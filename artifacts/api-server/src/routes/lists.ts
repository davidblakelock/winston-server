import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { authenticate } from "../auth/middleware.js";
import { MODEL_HAIKU } from "../lib/models.js";
import {
  batchCategorizeItems,
  categorizeAndUpdateItem,
  syncListItemToConnections,
  sortByCategory,
} from "../lists/listManager.js";
import {
  hasListSharePermission,
  grantListShare,
  revokeListShare,
  getSharedWithUser,
  getRequesterLabel,
} from "../lists/listShareManager.js";
import { autoUpdateItemUrl, autoUpdateRestaurantUrl, detectAutoLookupType, lookupRestaurantUrl, isBookingPlatformUrl, detectBookingPlatform } from "../lists/autoUrlLookup.js";
import { sendPushToAll } from "../push/pushManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router: IRouter = Router();

// In-process throttle: track when each profile_item ID was last backfill-checked.
// Prevents hammering the AI search API on every restaurant list load.
// Cleared on server restart (Railway restarts periodically anyway).
const restaurantBackfillChecked = new Map<number, number>(); // id → timestamp ms
const BACKFILL_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 hours per restaurant

// ── Idempotent migrations ─────────────────────────────────────────────────────
query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS reminder_time TIMESTAMPTZ`).catch(() => {});
query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS reminder_fired BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS notes TEXT`).catch(() => {});

// lists — per-user list metadata (list_type: checklist | notepad)
query(`
  CREATE TABLE IF NOT EXISTS lists (
    id          serial      PRIMARY KEY,
    user_name   text        NOT NULL,
    list_name   text        NOT NULL,
    list_type   text        NOT NULL DEFAULT 'checklist',
    created_at  timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (user_name, list_name)
  )
`).catch(() => {});

// ── Idempotent column migrations for profile_items (restaurants) ────────────
// These columns were added after initial schema creation — ensure they exist in
// Supabase before any restaurant SELECT/INSERT/UPDATE referencing them runs.
query(`ALTER TABLE profile_items ADD COLUMN IF NOT EXISTS url TEXT`).catch(() => {});
query(`ALTER TABLE profile_items ADD COLUMN IF NOT EXISTS booking_platform TEXT`).catch(() => {});

// ── Disable 304 caching for all list routes ────────────────────────────────
// Express generates a stable ETag from the response body and returns 304 when
// the client's If-None-Match matches — even when Cache-Control: no-store is set.
// Setting a time-based ETag before Express can generate its own prevents the
// match (Express skips generation if ETag is already present), guaranteeing
// every list request returns a fresh 200 with live DB data.
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("ETag", `"ts-${Date.now()}"`);
  next();
});

// GET /api/lists — returns all lists with real counts + list_type from the lists table
router.get("/lists", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");

  // Fixed list names that are handled by dedicated routes/tables or profile_items.
  const SYSTEM_LISTS = new Set(["shopping", "to do", "tv-shows", "restaurants"]);

  try {
    // Run all count queries + list metadata in parallel
    const [listItemsRes, wsCountRes, piShowsRes, piRestRes, listMetaRes] = await Promise.all([
      query<{ list_name: string; item_count: string }>(
        `SELECT lower(list_name) AS list_name, COUNT(*) AS item_count
         FROM list_items WHERE user_name = $1
         GROUP BY lower(list_name)`,
        [userName]
      ),
      query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT DISTINCT ON (lower(show_name)) id
           FROM watched_shows WHERE user_name = ANY($1)
           ORDER BY lower(show_name), id ASC
         ) sub`,
        [[userName, "David"]]
      ),
      query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM profile_items WHERE user_name = $1 AND category = 'shows'`,
        [userName]
      ),
      query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM profile_items WHERE user_name = $1 AND category = 'restaurants'`,
        [userName]
      ),
      // list_type metadata — only exists for lists explicitly created via POST /api/lists
      query<{ list_name: string; list_type: string }>(
        `SELECT lower(list_name) AS list_name, list_type FROM lists WHERE user_name = $1`,
        [userName]
      ).catch((): { rows: Array<{ list_name: string; list_type: string }> } => ({ rows: [] })),
    ]);

    const listCounts: Record<string, number> = {};
    for (const r of listItemsRes.rows) listCounts[r.list_name] = parseInt(r.item_count, 10);

    // list_type lookup (defaults to 'checklist' if not in lists table)
    const listTypeMap: Record<string, string> = {};
    for (const r of listMetaRes.rows) listTypeMap[r.list_name] = r.list_type;

    const wsCount = parseInt(wsCountRes.rows[0]?.cnt ?? "0", 10);
    const tvCount = wsCount > 0 ? wsCount : parseInt(piShowsRes.rows[0]?.cnt ?? "0", 10);
    const restCount = parseInt(piRestRes.rows[0]?.cnt ?? "0", 10);

    // Custom lists — union of names in list_items AND names in the lists metadata
    // table, excluding system lists. This ensures notepad lists appear even before
    // any content has been saved (i.e. they exist in `lists` but have no items yet).
    const customListNames = new Set([
      ...Object.keys(listCounts).filter((n) => !SYSTEM_LISTS.has(n)),
      ...Object.keys(listTypeMap).filter((n) => !SYSTEM_LISTS.has(n)),
    ]);

    const customLists = [...customListNames].map((name) => ({
      listName: name,
      displayName: name
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      itemCount: listCounts[name] ?? 0,
      listType: listTypeMap[name] ?? "checklist",
      isCustom: true,
    }));

    res.json({
      lists: [
        { listName: "shopping",    displayName: "Shopping",    itemCount: listCounts["shopping"] ?? 0, listType: "checklist" },
        { listName: "to do",       displayName: "To Do",       itemCount: listCounts["to do"] ?? 0,    listType: "checklist" },
        { listName: "tv-shows",    displayName: "TV Shows",    itemCount: tvCount,                      listType: "checklist" },
        { listName: "restaurants", displayName: "Restaurants", itemCount: restCount,                    listType: "checklist" },
        ...customLists,
      ],
    });
  } catch (err) {
    req.log.warn({ err }, "Lists index GET error");
    res.status(500).json({ error: "Failed to fetch lists" });
  }
});

// POST /api/lists — create or update a named list's metadata (list_type).
// Must be declared before POST /api/lists/:listName wildcard.
// Body: { listName: string, list_type?: "checklist" | "notepad" }
router.post("/lists", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { listName: rawName, list_type: rawType } = req.body as {
    listName?: string;
    list_type?: string;
  };
  const listName = rawName?.trim().toLowerCase();
  if (!listName) {
    res.status(400).json({ error: "listName is required" });
    return;
  }
  const listType = rawType === "notepad" ? "notepad" : "checklist";

  try {
    await query(
      `INSERT INTO lists (user_name, list_name, list_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, list_name)
       DO UPDATE SET list_type = EXCLUDED.list_type`,
      [userName, listName, listType]
    );
    req.log.info({ userName, listName, listType }, "[Lists] List metadata upserted");
    res.json({ listName, listType });
  } catch (err) {
    req.log.warn({ err }, "POST /api/lists error");
    res.status(500).json({ error: "Failed to create list" });
  }
});

// ── TV Shows — MUST be before /lists/:listName wildcard ──────────────────────
// GET /api/lists/tv-shows
router.get("/lists/tv-shows", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows: wsRows } = await query<{ id: number; show_name: string; network: string | null; status: string | null }>(
      `SELECT DISTINCT ON (lower(show_name)) id, show_name, network, status
       FROM watched_shows
       WHERE user_name = ANY($1)
       ORDER BY lower(show_name), id ASC`,
      [[userName, "David"]]
    );
    let rows = wsRows;
    if (rows.length === 0) {
      const { rows: piRows } = await query<{ id: number; show_name: string; network: string | null; status: string | null }>(
        `SELECT id, name AS show_name, NULL AS network, NULL AS status
         FROM profile_items
         WHERE user_name = $1 AND category = 'shows'
         ORDER BY name ASC`,
        [userName]
      );
      rows = piRows;
    }
    req.log.info({ count: rows.length, userName }, "[TV Shows] Fetched watched shows");
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        item_text: r.show_name,
        detail: r.network ?? null,
        status: r.status ?? null,
        created_at: new Date().toISOString(),
      })),
    });
  } catch (err) {
    req.log.warn({ err }, "TV Shows list GET error");
    res.status(500).json({ error: "Failed to fetch TV shows" });
  }
});

// POST /api/lists/tv-shows — add a show directly from the UI
router.post("/lists/tv-shows", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const item = ((req.body?.item ?? "") as string).trim();
  if (!item) { res.status(400).json({ error: "item required" }); return; }
  try {
    const { rows } = await query<{ id: number; show_name: string }>(
      `INSERT INTO watched_shows (user_name, show_name)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM watched_shows WHERE user_name = $1 AND lower(show_name) = lower($2)
       )
       RETURNING id, show_name`,
      [userName, item]
    );
    if (rows.length === 0) {
      res.status(409).json({ error: "Show already in list" });
      return;
    }
    req.log.info({ userName, show: item }, "[TV Shows] Added via UI");
    res.json({ item: { id: rows[0].id, item_text: rows[0].show_name, created_at: new Date().toISOString() } });
  } catch (err) {
    req.log.warn({ err }, "TV Shows list POST error");
    res.status(500).json({ error: "Failed to add show" });
  }
});

// DELETE /api/lists/tv-shows/:id
router.delete("/lists/tv-shows/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM watched_shows WHERE id = $1 AND user_name = $2 RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "TV Shows list DELETE error");
    res.status(500).json({ error: "Failed to remove show" });
  }
});

// ── Restaurants — MUST be before /lists/:listName wildcard ───────────────────
// GET /api/lists/restaurants
router.get("/lists/restaurants", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await query<{ id: number; name: string; detail: string | null; url: string | null; booking_platform: string | null; notes: string | null; created_at: string }>(
      `SELECT id, name, detail, url, booking_platform, notes, created_at
       FROM profile_items
       WHERE user_name = $1 AND category = 'restaurants'
       ORDER BY created_at DESC`,
      [userName]
    );
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        item_text: r.name,
        detail: r.detail ?? null,
        url: r.url ?? null,
        booking_platform: r.booking_platform ?? null,
        notes: r.notes ?? null,
        created_at: r.created_at,
      })),
    });

    // Lazy URL backfill: trigger background lookups for restaurants that either:
    //  a) have no URL / a non-booking-platform URL (always retry), OR
    //  b) have an OpenTable /r/<slug> URL — those are AI-guessed slugs and can 404;
    //     re-verify them at most once every 4 hours using the throttle map.
    // Yelp search URLs are skipped — they mean we already tried and found nothing better.
    const needsLookup = rows.filter((r) => {
      if (/yelp\.com\/search/i.test(r.url ?? "")) return false; // already retried, use Yelp search
      if (!isBookingPlatformUrl(r.url)) return true;            // no direct booking URL → check
      // Re-verify /r/ OT slug URLs (guessed by AI, often wrong) but throttle to 4h
      if (/opentable\.com\/r\//i.test(r.url ?? "")) {
        const last = restaurantBackfillChecked.get(r.id) ?? 0;
        return Date.now() - last > BACKFILL_THROTTLE_MS;
      }
      return false; // trusted URL (profile/ID, Resy, Yelp BIZ) — don't re-check
    });
    if (needsLookup.length > 0) {
      const batch = needsLookup.slice(0, 3); // cap lower (2 Claude calls each now)
      batch.forEach((r) => restaurantBackfillChecked.set(r.id, Date.now()));
      Promise.allSettled(
        batch.map((r) => autoUpdateRestaurantUrl(r.id, r.name))
      ).catch(() => {});
    }
  } catch (err) {
    req.log.warn({ err }, "Restaurants list GET error");
    res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});

// POST /api/lists/restaurants
// Accepts optional manual url; if none provided, auto-looks up booking/website URL.
// Awaits the lookup so the response always includes the resolved URL.
router.post("/lists/restaurants", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { item: rawItem, url: rawUrl } = req.body as { item?: string; url?: string };
  const item = (rawItem ?? "").trim();
  if (!item) return res.status(400).json({ error: "item required" });
  const manualUrl = rawUrl?.trim() || null;
  // Detect platform from a manually-provided URL upfront so it can be stored in the INSERT.
  const manualPlatform = manualUrl ? detectBookingPlatform(manualUrl) : null;
  try {
    const { rows } = await query<{ id: number; name: string }>(
      `INSERT INTO profile_items (user_name, category, name, detail, url, booking_platform)
       SELECT $1, 'restaurants', $2, NULL, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM profile_items
         WHERE user_name = $1 AND category = 'restaurants' AND lower(name) = lower($2)
       )
       RETURNING id, name`,
      [userName, item, manualUrl, manualPlatform]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: "Restaurant already in list" });
    }
    const newItem = rows[0];

    // Await the URL lookup so the response includes the resolved URL immediately.
    // manualUrl takes priority; otherwise auto-lookup (booking platform → website).
    let resolvedUrl = manualUrl;
    if (!resolvedUrl) {
      try {
        resolvedUrl = await lookupRestaurantUrl(newItem.name);
        if (resolvedUrl) {
          const platform = detectBookingPlatform(resolvedUrl);
          await query(
            `UPDATE profile_items SET url = $1, booking_platform = $2 WHERE id = $3`,
            [resolvedUrl, platform, newItem.id]
          );
          req.log.info({ id: newItem.id, name: newItem.name, url: resolvedUrl, platform }, "[Restaurants] URL auto-resolved");
        }
      } catch (lookupErr) {
        req.log.warn({ lookupErr, name: newItem.name }, "[Restaurants] URL lookup failed — restaurant saved without URL");
      }
    }

    const resolvedPlatform = detectBookingPlatform(resolvedUrl);
    res.json({ item: { id: newItem.id, item_text: newItem.name, url: resolvedUrl ?? null, booking_platform: resolvedPlatform, created_at: new Date().toISOString() } });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list POST error");
    res.status(500).json({ error: "Failed to add restaurant" });
  }
});

// DELETE /api/lists/restaurants/:id
router.delete("/lists/restaurants/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM profile_items WHERE id = $1 AND user_name = $2 AND category = 'restaurants' RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list DELETE error");
    res.status(500).json({ error: "Failed to remove restaurant" });
  }
});

// PUT /api/lists/restaurants/:id — update a restaurant name, url, and/or notes
router.put("/lists/restaurants/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  const { item, url: rawUrl, notes } = req.body as { item?: string; url?: string; notes?: string | null };
  if (!item?.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }
  const manualUrl = rawUrl?.trim() || null;
  const manualPlatform = manualUrl ? detectBookingPlatform(manualUrl) : null;
  const notesVal = notes !== undefined ? (notes?.trim() || null) : undefined;
  try {
    const { rows } = await query<{ id: number; name: string; url: string | null; booking_platform: string | null; notes: string | null }>(
      `UPDATE profile_items
       SET name = $1,
           url = COALESCE($2, url),
           booking_platform = CASE WHEN $2 IS NOT NULL THEN $3 ELSE booking_platform END,
           notes = COALESCE($4, notes)
       WHERE id = $5 AND user_name = $6 AND category = 'restaurants'
       RETURNING id, name, url, booking_platform, notes`,
      [item.trim(), manualUrl, manualPlatform, notesVal ?? null, id, userName]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }
    res.json({ item: { id: rows[0].id, item_text: rows[0].name, url: rows[0].url, booking_platform: rows[0].booking_platform, notes: rows[0].notes } });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list PUT error");
    res.status(500).json({ error: "Failed to update restaurant" });
  }
});

// POST /api/lists/restaurants/backfill-urls
// Queues background URL lookups for restaurants that either:
//   • have no URL (url IS NULL), OR
//   • have a non-booking-platform URL (e.g. the restaurant's own website)
// Both cases need to be re-looked up against OpenTable / Resy / Yelp.
// Returns { queued: N } immediately; lookups run sequentially with 600 ms gaps.
router.post("/lists/restaurants/backfill-urls", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { rows } = await query<{ id: number; name: string; url: string | null }>(
      `SELECT id, name, url FROM profile_items
       WHERE user_name = $1 AND category = 'restaurants'
       ORDER BY created_at ASC`,
      [userName]
    );

    // Only queue restaurants that don't already have a booking platform URL
    const toProcess = rows.filter((r) => !isBookingPlatformUrl(r.url));

    // Look up the user's city for location-aware booking URL searches.
    const profileCityRow = await query<{ city: string | null }>(
      `SELECT city FROM user_profiles WHERE user_name = $1`,
      [userName]
    ).catch(() => ({ rows: [] as Array<{ city: string | null }> }));
    const userCity = profileCityRow.rows[0]?.city ?? "";

    res.json({ queued: toProcess.length, total: rows.length });

    // Run sequentially with 600 ms delay to stay gentle on the Anthropic API.
    (async () => {
      for (const row of toProcess) {
        await autoUpdateRestaurantUrl(row.id, row.name, userCity);
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
    })().catch(() => {});
  } catch (err) {
    req.log.warn({ err }, "Restaurants backfill-urls POST error");
    res.status(500).json({ error: "Failed to start URL backfill" });
  }
});

// ── Shopping — dedicated routes (Feature 2: auto-categorize + Feature 1: sync)
// MUST be before the /lists/:listName wildcard.

interface ShoppingItem {
  id: number;
  item_text: string;
  category: string | null;
  added_by: string | null;
  url: string | null;
  created_at: string;
}

// GET /api/lists/shopping — returns items sorted by category, with category + added_by + url fields
router.get("/lists/shopping", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await query<ShoppingItem>(
      `SELECT id, item_text, category, added_by, url, created_at
       FROM list_items
       WHERE user_name = $1 AND list_name = 'shopping'
       ORDER BY created_at ASC`,
      [userName]
    );

    const sorted = sortByCategory(rows);

    // Build byCategory map
    const byCategory: Record<string, ShoppingItem[]> = {};
    for (const item of sorted) {
      const cat = item.category ?? "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    }

    res.json({ items: sorted, byCategory });
  } catch (err) {
    req.log.warn({ err }, "Shopping list GET error");
    res.status(500).json({ error: "Failed to fetch shopping list" });
  }
});

// POST /api/lists/shopping — add item, auto-categorize (async), sync to connections (async)
router.post("/lists/shopping", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { item, url: rawUrl, ownerUserName } = req.body as { item?: string; url?: string; ownerUserName?: string };
  const manualUrl = rawUrl?.trim() || null;
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }

  const targetUser = ownerUserName?.trim() ?? userName;

  if (targetUser !== userName) {
    const allowed = await hasListSharePermission(targetUser, userName, "shopping").catch(() => false);
    if (!allowed) {
      res.status(403).json({ error: "You do not have permission to add to this list" });
      return;
    }
    const { rows: existing } = await query<{ id: number }>(
      `SELECT id FROM list_items
       WHERE user_name = $1 AND list_name = 'shopping' AND lower(item_text) = lower($2)`,
      [targetUser, item.trim()]
    );
    if (existing.length > 0) {
      await sendPushToAll(
        {
          title: "Already on the list",
          body: `"${item.trim()}" is already on ${targetUser}'s shopping list`,
          tag: `list-dup-${userName}`,
          notificationType: "list-sync",
        },
        userName
      ).catch(() => {});
      res.json({ item: null, duplicate: true, message: `"${item.trim()}" is already on that list` });
      return;
    }
    const addedByLabel = await getRequesterLabel(targetUser, userName).catch(() => userName);
    const { rows } = await query<ShoppingItem>(
      `INSERT INTO list_items (user_name, list_name, item_text, added_by, url)
       VALUES ($1, 'shopping', $2, $3, $4)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id, item_text, category, added_by, url, created_at`,
      [targetUser, item.trim(), addedByLabel, manualUrl]
    );
    const newItem = rows[0];
    if (newItem) {
      categorizeAndUpdateItem(newItem.id, newItem.item_text).catch(() => {});
      await sendPushToAll(
        {
          title: `${addedByLabel} added to your shopping list`,
          body: item.trim(),
          tag: `list-shared-add-${newItem.id}`,
          notificationType: "list-sync",
          deepLink: "winston://lists?tab=shopping",
          companionMessage: `${addedByLabel} added "${item.trim()}" to your shopping list.`,
        },
        targetUser
      ).catch(() => {});
    }
    res.json({ item: newItem ?? null });
    return;
  }

  try {
    const { rows } = await query<ShoppingItem>(
      `INSERT INTO list_items (user_name, list_name, item_text, url)
       VALUES ($1, 'shopping', $2, $3)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text,
                     url = CASE WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url ELSE list_items.url END
       RETURNING id, item_text, category, added_by, url, created_at`,
      [userName, item.trim(), manualUrl]
    );
    const newItem = rows[0];

    if (newItem) {
      categorizeAndUpdateItem(newItem.id, newItem.item_text).catch(() => {});
      syncListItemToConnections("shopping", [newItem.item_text], userName).catch(() => {});
    }

    res.json({ item: newItem });
  } catch (err) {
    req.log.warn({ err }, "Shopping list POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// DELETE /api/lists/shopping/:id
router.delete("/lists/shopping/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM list_items WHERE id = $1 AND user_name = $2 AND list_name = 'shopping' RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Shopping list DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// POST /api/lists/shopping/categorize — batch-categorize all uncategorized items
router.post("/lists/shopping/categorize", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const force = (req.query["force"] ?? req.body?.force) === "true" || req.body?.force === true;

    const { rows } = await query<{ id: number; item_text: string }>(
      force
        ? `SELECT id, item_text FROM list_items WHERE user_name = $1 AND list_name = 'shopping'`
        : `SELECT id, item_text FROM list_items WHERE user_name = $1 AND list_name = 'shopping' AND category IS NULL`,
      [userName]
    );

    if (!rows.length) {
      res.json({ categorized: 0, message: "All items already have categories" });
      return;
    }

    const itemTexts = rows.map((r) => r.item_text);
    const categoryMap = await batchCategorizeItems(itemTexts);

    let updated = 0;
    for (const row of rows) {
      const cat = categoryMap[row.item_text.toLowerCase()] ?? "Other";
      await query(
        `UPDATE list_items SET category = $1 WHERE id = $2`,
        [cat, row.id]
      ).catch(() => {});
      updated++;
    }

    req.log.info({ userName, updated }, "[Shopping] Bulk categorize complete");
    res.json({ categorized: updated });
  } catch (err) {
    req.log.warn({ err }, "Shopping categorize error");
    res.status(500).json({ error: "Failed to categorize items" });
  }
});

// ── To Do — dedicated slug so the URL never needs %20 encoding ───────────────
// Maps the clean /todo path to list_name = 'to do' in the DB.
// MUST appear before the /lists/:listName wildcard.
router.get(["/lists/todo", "/lists/to do"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null; notes: string | null }>(
      `SELECT id, item_text, added_by, url, created_at, reminder_time, notes FROM list_items
       WHERE user_name = $1 AND list_name = 'to do'
       ORDER BY created_at ASC`,
      [userName]
    );
    res.json({ items: rows });
  } catch (err) {
    req.log.warn({ err }, "To Do GET error");
    res.status(500).json({ error: "Failed to fetch to do list" });
  }
});

router.post(["/lists/todo", "/lists/to do"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { item, url: rawTodoUrl, ownerUserName, reminder_time: rawReminderTime, notes: rawNotes } = req.body as { item?: string; url?: string; ownerUserName?: string; reminder_time?: string; notes?: string };
  const manualUrl = rawTodoUrl?.trim() || null;
  const reminderTime = rawReminderTime?.trim() || null;
  const todoNotes = rawNotes?.trim() || null;
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }

  const targetUser = ownerUserName?.trim() ?? userName;

  if (targetUser !== userName) {
    const allowed = await hasListSharePermission(targetUser, userName, "to do").catch(() => false);
    if (!allowed) {
      res.status(403).json({ error: "You do not have permission to add to this list" });
      return;
    }
    const { rows: existing } = await query<{ id: number }>(
      `SELECT id FROM list_items
       WHERE user_name = $1 AND list_name = 'to do' AND lower(item_text) = lower($2)`,
      [targetUser, item.trim()]
    );
    if (existing.length > 0) {
      await sendPushToAll(
        {
          title: "Already on the list",
          body: `"${item.trim()}" is already on ${targetUser}'s to-do list`,
          tag: `list-dup-${userName}`,
          notificationType: "list-sync",
        },
        userName
      ).catch(() => {});
      res.json({ item: null, duplicate: true, message: `"${item.trim()}" is already on that list` });
      return;
    }
    const addedByLabel = await getRequesterLabel(targetUser, userName).catch(() => userName);
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null; notes: string | null }>(
      `INSERT INTO list_items (user_name, list_name, item_text, added_by, url, reminder_time, notes)
       VALUES ($1, 'to do', $2, $3, $4, $5, $6)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id, item_text, added_by, url, created_at, reminder_time, notes`,
      [targetUser, item.trim(), addedByLabel, manualUrl, reminderTime, todoNotes]
    );
    const newItem = rows[0];
    if (newItem) {
      await sendPushToAll(
        {
          title: `${addedByLabel} added to your to-do list`,
          body: item.trim(),
          tag: `list-shared-add-${newItem.id}`,
          notificationType: "list-sync",
          deepLink: "winston://lists?tab=todo",
          companionMessage: `${addedByLabel} added "${item.trim()}" to your to-do list.`,
        },
        targetUser
      ).catch(() => {});
    }
    res.json({ item: newItem ?? null });
    return;
  }

  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null; notes: string | null }>(
      `INSERT INTO list_items (user_name, list_name, item_text, url, reminder_time, notes)
       VALUES ($1, 'to do', $2, $3, $4, $5)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text     = EXCLUDED.item_text,
                     url           = CASE WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url ELSE list_items.url END,
                     reminder_time = CASE WHEN EXCLUDED.reminder_time IS NOT NULL THEN EXCLUDED.reminder_time ELSE list_items.reminder_time END,
                     reminder_fired = CASE WHEN EXCLUDED.reminder_time IS NOT NULL THEN FALSE ELSE list_items.reminder_fired END,
                     notes         = CASE WHEN EXCLUDED.notes IS NOT NULL THEN EXCLUDED.notes ELSE list_items.notes END
       RETURNING id, item_text, added_by, url, created_at, reminder_time, notes`,
      [userName, item.trim(), manualUrl, reminderTime, todoNotes]
    );
    syncListItemToConnections("to do", [item.trim()], userName).catch(() => {});
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "To Do POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

router.delete(["/lists/todo/:id", "/lists/to do/:id"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM list_items WHERE id = $1 AND user_name = $2 AND list_name = 'to do' RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "To Do DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ── List sharing management ───────────────────────────────────────────────────
// MUST be before the /lists/:listName wildcard.

// GET /api/lists/shared-with-me — lists shared with the authenticated user
router.get("/lists/shared-with-me", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const entries = await getSharedWithUser(userName);
    const grouped: Record<string, Array<{ listName: string; grantedAt: string }>> = {};
    for (const e of entries) {
      if (!grouped[e.ownerUserName]) grouped[e.ownerUserName] = [];
      grouped[e.ownerUserName].push({ listName: e.listName, grantedAt: e.createdAt });
    }
    const sharedLists = Object.entries(grouped).map(([ownerUserName, lists]) => ({
      ownerUserName,
      lists,
    }));
    res.json({ sharedLists });
  } catch (err) {
    req.log.warn({ err }, "Shared-with-me GET error");
    res.status(500).json({ error: "Failed to fetch shared lists" });
  }
});

// POST /api/lists/share — grant permission for a connected user to add to one of the owner's lists
// Body: { sharedWithUserName: string, listName: string }
router.post("/lists/share", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { sharedWithUserName, listName } = req.body as { sharedWithUserName?: string; listName?: string };
  if (!sharedWithUserName?.trim() || !listName?.trim()) {
    res.status(400).json({ error: "sharedWithUserName and listName are required" });
    return;
  }
  const { rows: connRows } = await query<{ id: number }>(
    `SELECT id FROM winston_connections
     WHERE ((requester_user_name = $1 AND recipient_user_name = $2)
        OR  (requester_user_name = $2 AND recipient_user_name = $1))
       AND status = 'accepted'
     LIMIT 1`,
    [userName, sharedWithUserName.trim()]
  );
  if (!connRows.length) {
    res.status(403).json({ error: "No accepted connection with that user" });
    return;
  }
  try {
    await grantListShare(userName, sharedWithUserName.trim(), listName.trim());
    req.log.info({ userName, sharedWithUserName, listName }, "[ListShare] Permission granted");
    res.json({ granted: true });
  } catch (err) {
    req.log.warn({ err }, "List share grant error");
    res.status(500).json({ error: "Failed to grant list share" });
  }
});

// DELETE /api/lists/share — revoke list share permission
// Body: { sharedWithUserName: string, listName: string }
router.delete("/lists/share", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { sharedWithUserName, listName } = req.body as { sharedWithUserName?: string; listName?: string };
  if (!sharedWithUserName?.trim() || !listName?.trim()) {
    res.status(400).json({ error: "sharedWithUserName and listName are required" });
    return;
  }
  try {
    await revokeListShare(userName, sharedWithUserName.trim(), listName.trim());
    req.log.info({ userName, sharedWithUserName, listName }, "[ListShare] Permission revoked");
    res.json({ revoked: true });
  } catch (err) {
    req.log.warn({ err }, "List share revoke error");
    res.status(500).json({ error: "Failed to revoke list share" });
  }
});

// ── Generic list_items — wildcard routes AFTER specific routes ────────────────
// GET /api/lists/:listName — fetch all items for a list
router.get("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  const { listName } = req.params;
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null; notes: string | null }>(
      `SELECT id, item_text, added_by, url, created_at, reminder_time, notes
       FROM list_items
       WHERE user_name = $1 AND lower(list_name) = lower($2)
       ORDER BY created_at ASC`,
      [userName, listName]
    );
    res.json({ items: rows });
  } catch (err) {
    req.log.warn({ err }, "Lists GET error");
    res.status(500).json({ error: "Failed to fetch list" });
  }
});

// ── POST /api/lists/parse-voice ───────────────────────────────────────────────
// Parses a natural language transcript into individual list items using Haiku.
// Body: { transcript: string, listName: string }
// Returns: { items: string[] }
router.post("/lists/parse-voice", express.json(), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { transcript, listName } = req.body as { transcript?: unknown; listName?: unknown };

  if (typeof transcript !== "string" || !transcript.trim()) {
    res.status(400).json({ error: "transcript is required" });
    return;
  }
  if (typeof listName !== "string" || !listName.trim()) {
    res.status(400).json({ error: "listName is required" });
    return;
  }

  const isTodo = listName.toLowerCase().includes("to") || listName.toLowerCase().includes("todo") || listName.toLowerCase().includes("task");
  const listContext = isTodo
    ? "to-do / task list (items are actions like 'call the dentist', 'pick up dry cleaning')"
    : "shopping list (items are things to buy like 'milk', 'bread', 'olive oil')";

  const prompt = `Extract individual ${listContext} items from this voice transcript. Return ONLY a JSON array of strings — no explanation, no markdown.

Rules:
- Split on conjunctions (and, also, plus) and commas
- Preserve natural phrasing for to-do tasks (e.g. "call the dentist", not just "dentist")
- For shopping items, use simple noun phrases (e.g. "almond milk", not "get some almond milk")
- Strip filler words: "add", "put", "I need", "we need", "get me", "grab", "pick up", "can you add", "please add"
- Preserve quantity/brand qualifiers (e.g. "2% milk", "a dozen eggs", "Tide pods")
- Do not include empty strings
- Return [] if no valid items can be extracted

Transcript: "${transcript.trim()}"

Return JSON array only:`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "[]";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      res.json({ items: [], urlMap: {} });
      return;
    }

    const parsed = JSON.parse(match[0]);
    const items: string[] = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
      : [];

    // Extract any URLs from the transcript and map them to the nearest item
    const urlMap: Record<string, string> = {};
    const urlMatches = transcript.match(/https?:\/\/[^\s]+/g);
    if (urlMatches && urlMatches.length > 0 && items.length > 0) {
      urlMap[items[items.length - 1]] = urlMatches[0];
    }

    req.log.info({ userName, listName, transcript: transcript.trim(), itemCount: items.length, urlCount: Object.keys(urlMap).length }, "[ParseVoice] Extracted items");
    res.json({ items, urlMap });
  } catch (err) {
    req.log.error({ err }, "[ParseVoice] Claude extraction failed");
    res.status(500).json({ error: "Failed to parse transcript" });
  }
});

// POST /api/lists/:listName — add an item
// - Manual url field is saved as-is when provided.
// - For auto-lookup list types (movies, books, restaurants, recipes, tv shows),
//   if no url is supplied, a URL is looked up in the background after insert.
router.post("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  const { item, url, notes: rawNotes } = req.body as { item?: string; url?: string; notes?: string };
  if (!item || !item.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }

  const manualUrl = url?.trim() || null;
  const notes = rawNotes?.trim() || null;
  const isAutoLookupList = !manualUrl && !!detectAutoLookupType(listName);

  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; notes: string | null }>(
      `INSERT INTO list_items (user_name, list_name, item_text, url, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text,
                     url = CASE WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url ELSE list_items.url END,
                     notes = CASE WHEN EXCLUDED.notes IS NOT NULL THEN EXCLUDED.notes ELSE list_items.notes END
       RETURNING id, item_text, added_by, url, created_at, notes`,
      [userName, listName, item.trim(), manualUrl, notes]
    );
    const newItem = rows[0];

    if (newItem && isAutoLookupList) {
      autoUpdateItemUrl(newItem.id, newItem.item_text, listName).catch(() => {});
    }

    req.log.info({ userName, listName, item: item.trim(), manualUrl, isAutoLookupList }, "[Lists] Item added");
    res.json({ item: newItem });
  } catch (err) {
    req.log.warn({ err }, "Lists POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// PUT /api/lists/:listName/content — replace the entire content of a notepad list.
// Deletes all existing items and inserts a single text-blob item.
// MUST be declared before PUT /api/lists/:listName/:id so "content" isn't matched as :id.
// Body: { content: string }
router.put("/lists/:listName/content", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  const { content } = req.body as { content?: string };
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) is required" });
    return;
  }
  try {
    // Replace atomically: delete all items then insert one blob
    await query(
      `DELETE FROM list_items WHERE user_name = $1 AND lower(list_name) = lower($2)`,
      [userName, listName]
    );
    if (content.trim().length > 0) {
      await query(
        `INSERT INTO list_items (user_name, list_name, item_text)
         VALUES ($1, $2, $3)`,
        [userName, listName, content]
      );
    }
    req.log.info({ userName, listName, contentLength: content.length }, "[Lists] Notepad content replaced");
    res.json({ ok: true, listName, content });
  } catch (err) {
    req.log.warn({ err }, "Lists PUT /content error");
    res.status(500).json({ error: "Failed to save notepad content" });
  }
});

// PUT /api/lists/:listName/:id — update an existing item's text, url, and/or reminder_time
router.put("/lists/:listName/:id", async (req: Request, res: Response) => {
  (req as any).log?.info({ params: req.params, body: req.body }, "[Lists PUT] Raw request received");
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName, id } = req.params;
  const { item, url: rawUrl, reminder_time: rawReminderTime, notes: rawNotes } = req.body as { item?: string; url?: string; reminder_time?: string; notes?: string };
  if (!item?.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }
  const manualUrl = rawUrl?.trim() || null;
  const reminderTime = rawReminderTime?.trim() || null;
  const notes = rawNotes?.trim() || null;
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null; notes: string | null }>(
      `UPDATE list_items
       SET item_text      = $1,
           url            = COALESCE($2, url),
           reminder_time  = COALESCE($3, reminder_time),
           reminder_fired = CASE WHEN $3 IS NOT NULL THEN FALSE ELSE reminder_fired END,
           notes          = COALESCE($4, notes)
       WHERE id = $5 AND user_name = $6 AND list_name = $7
       RETURNING id, item_text, added_by, url, created_at, reminder_time, notes`,
      [item.trim(), manualUrl, reminderTime, notes, id, userName, listName]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "Lists PUT error");
    res.status(500).json({ error: "Failed to update item" });
  }
});

// DELETE /api/lists/:listName — delete the entire list and all its items.
// MUST be declared before DELETE /api/lists/:listName/:id so Express doesn't
// match a bare list-name as a two-segment path.
router.delete("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  try {
    const [itemsResult] = await Promise.all([
      query(
        `DELETE FROM list_items WHERE user_name = $1 AND lower(list_name) = lower($2)`,
        [userName, listName]
      ),
      // Remove metadata row if it exists (safe to ignore if table or row absent)
      query(
        `DELETE FROM lists WHERE user_name = $1 AND lower(list_name) = lower($2)`,
        [userName, listName]
      ).catch(() => {}),
    ]);
    const deletedCount = itemsResult.rowCount ?? 0;
    req.log.info({ userName, listName, deletedCount }, "[Lists] List deleted");
    res.json({ deleted: true, listName, itemsRemoved: deletedCount });
  } catch (err) {
    req.log.warn({ err }, "Lists DELETE /:listName error");
    res.status(500).json({ error: "Failed to delete list" });
  }
});

// DELETE /api/lists/:listName/:id — remove an item by id
router.delete("/lists/:listName/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName, id } = req.params;
  try {
    await query(
      `DELETE FROM list_items WHERE id = $1 AND user_name = $2 AND lower(list_name) = lower($3) RETURNING id`,
      [id, userName, listName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Lists DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

export default router;
