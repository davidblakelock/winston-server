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
import { autoUpdateItemUrl, autoUpdateRestaurantUrl, detectAutoLookupType, detectBookingPlatform } from "../lists/autoUrlLookup.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { extractReminder, computeFireAt, computeFireAtForDate, resolveNextDayOfWeek } from "../reminders/reminderParser.js";
import { nextOccurrenceForPattern } from "../reminders/recurringUtils.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { createReminder } from "../reminders/reminderManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router: IRouter = Router();

// TEMPORARY — recipe-display diagnostic (winston-native app/lists.tsx forwards
// here). Remove once the "recipe saves fine but only the title shows, long-press
// does nothing" bug is root-caused. No auth check — this is throwaway and the
// payload never touches the database, just the log stream.
router.post("/debug/recipe-log", (req: Request, res: Response) => {
  req.log.info({ tag: req.body?.tag, payload: req.body?.payload }, "[RECIPE-DEBUG]");
  res.json({ ok: true });
});

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

// ── Idempotent migration for the dedicated restaurants table ─────────────────
// Own table, own dedicated routes below — same pattern watched_shows already
// uses for TV Shows, replacing profile_items category 'restaurants'.
query(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id                serial      PRIMARY KEY,
    user_name         text        NOT NULL,
    name              text        NOT NULL,
    detail            text,
    notes             text,
    url               text,
    booking_platform  text,
    created_at        timestamptz NOT NULL DEFAULT now()
  )
`).catch(() => {});
query(`CREATE INDEX IF NOT EXISTS restaurants_user_idx ON restaurants (user_name)`).catch(() => {});
// Prevents duplicate restaurant names per user (case-insensitive) — mirrors the
// dedup-on-insert logic below.
query(`
  CREATE UNIQUE INDEX IF NOT EXISTS restaurants_user_name_lower_idx
  ON restaurants (user_name, lower(name))
`).catch(() => {});

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
    const [listItemsRes, wsCountRes, piShowsRes, restCountRes, listMetaRes, todoCount] = await Promise.all([
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
        `SELECT COUNT(*) AS cnt FROM restaurants WHERE user_name = $1`,
        [userName]
      ),
      // list_type metadata — only exists for lists explicitly created via POST /api/lists
      query<{ list_name: string; list_type: string }>(
        `SELECT lower(list_name) AS list_name, list_type FROM lists WHERE user_name = $1`,
        [userName]
      ).catch((): { rows: Array<{ list_name: string; list_type: string }> } => ({ rows: [] })),
      query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM reminders
         WHERE user_name = $1 AND status = 'pending'`,
        [userName]
      ),
    ]);

    const listCounts: Record<string, number> = {};
    for (const r of listItemsRes.rows) listCounts[r.list_name] = parseInt(r.item_count, 10);

    // list_type lookup (defaults to 'checklist' if not in lists table)
    const listTypeMap: Record<string, string> = {};
    for (const r of listMetaRes.rows) listTypeMap[r.list_name] = r.list_type;

    const wsCount = parseInt(wsCountRes.rows[0]?.cnt ?? "0", 10);
    const tvCount = wsCount > 0 ? wsCount : parseInt(piShowsRes.rows[0]?.cnt ?? "0", 10);
    const restCount = parseInt(restCountRes.rows[0]?.cnt ?? "0", 10);

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
        { listName: "to do",       displayName: "To Do",       itemCount: Number(todoCount.rows[0]?.count ?? 0), listType: "checklist" },
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
       FROM restaurants
       WHERE user_name = $1
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

    // Lazy URL backfill: any restaurant without an official site gets queued
    // for a lookup, throttled per-restaurant (not just for one URL shape —
    // this used to only throttle the "re-verify an AI-guessed OT slug" case,
    // so a restaurant with no URL at all got re-queued on every single load).
    const needsLookup = rows.filter((r) => {
      if (r.url) return false; // already has a site
      const last = restaurantBackfillChecked.get(r.id) ?? 0;
      return Date.now() - last > BACKFILL_THROTTLE_MS;
    });
    if (needsLookup.length > 0) {
      const batch = needsLookup.slice(0, 3); // cap per load to stay gentle on the Places/Anthropic APIs
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
// Accepts optional manual url; if none provided, the official site is looked
// up in the background (fire-and-forget) — this endpoint used to await that
// lookup synchronously with no timeout anywhere in the chain, which is what
// made "add a restaurant" spin for 9+ seconds (confirmed live) with no cap
// on how much worse a slow run could get. Respond immediately instead.
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
      `INSERT INTO restaurants (user_name, name, detail, url, booking_platform)
       SELECT $1, $2, NULL, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM restaurants
         WHERE user_name = $1 AND lower(name) = lower($2)
       )
       RETURNING id, name`,
      [userName, item, manualUrl, manualPlatform]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: "Restaurant already in list" });
    }
    const newItem = rows[0];

    res.json({ item: { id: newItem.id, item_text: newItem.name, url: manualUrl, booking_platform: manualPlatform, created_at: new Date().toISOString() } });

    if (!manualUrl) {
      autoUpdateRestaurantUrl(newItem.id, newItem.name).catch(() => {});
    }
  } catch (err) {
    req.log.warn({ err }, "Restaurants list POST error");
    res.status(500).json({ error: "Failed to add restaurant" });
  }
  return;
});

// DELETE /api/lists/restaurants/:id
router.delete("/lists/restaurants/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM restaurants WHERE id = $1 AND user_name = $2 RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list DELETE error");
    res.status(500).json({ error: "Failed to remove restaurant" });
  }
});

// PUT /api/lists/restaurants/:id — update a restaurant name, url, and/or notes
// This is a full-resource PUT — the edit modal always sends every field, so
// an empty url/notes means the user explicitly cleared it, not "leave alone."
// COALESCE(newValue, oldValue) used to treat both the same (an empty string
// collapses to null before it ever reaches SQL), silently reverting a
// deliberate clear back to the old value — always write what was sent.
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
  const notesVal = notes?.trim() || null;
  try {
    const { rows } = await query<{ id: number; name: string; url: string | null; booking_platform: string | null; notes: string | null }>(
      `UPDATE restaurants
       SET name = $1,
           url = $2,
           booking_platform = $3,
           notes = $4
       WHERE id = $5 AND user_name = $6
       RETURNING id, name, url, booking_platform, notes`,
      [item.trim(), manualUrl, manualPlatform, notesVal, id, userName]
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
// Queues background official-site lookups for restaurants with no URL yet.
// Returns { queued: N } immediately; lookups run sequentially with 600 ms gaps.
router.post("/lists/restaurants/backfill-urls", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { rows } = await query<{ id: number; name: string; url: string | null }>(
      `SELECT id, name, url FROM restaurants
       WHERE user_name = $1
       ORDER BY created_at ASC`,
      [userName]
    );

    // Only queue restaurants that don't already have an official site
    const toProcess = rows.filter((r) => !r.url);

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

  // Splits "milk, eggs, bread" typed into the app's own add-item field into
  // 3 separate items. Confirmed live: that field posts here with the raw
  // text as a single string, and this route never had any splitting logic
  // at all — the earlier comma→semicolon fix (commit 8def519) only ever
  // touched the chat/voice path's add_list_item action tag, a completely
  // separate route. Safe to split on every comma here specifically (unlike
  // the generic /lists/:listName route used by recipes/notes/restaurants,
  // where a comma is often just prose punctuation inside one entry) because
  // shopping items are always short, atomic nouns — nobody types a
  // multi-clause sentence into a grocery list. A manually-attached URL only
  // ever applies to a single-item add (e.g. saving a product page), so it's
  // dropped for a multi-item split rather than wrongly attached to all of them.
  const items = item.split(",").map((s) => s.trim()).filter(Boolean);
  const itemUrl = items.length === 1 ? manualUrl : null;

  const targetUser = ownerUserName?.trim() ?? userName;

  if (targetUser !== userName) {
    const allowed = await hasListSharePermission(targetUser, userName, "shopping").catch(() => false);
    if (!allowed) {
      res.status(403).json({ error: "You do not have permission to add to this list" });
      return;
    }
    const addedByLabel = await getRequesterLabel(targetUser, userName).catch(() => userName);
    const added: ShoppingItem[] = [];
    const duplicates: string[] = [];

    for (const text of items) {
      const { rows: existing } = await query<{ id: number }>(
        `SELECT id FROM list_items
         WHERE user_name = $1 AND list_name = 'shopping' AND lower(item_text) = lower($2)`,
        [targetUser, text]
      );
      if (existing.length > 0) {
        duplicates.push(text);
        continue;
      }
      const { rows } = await query<ShoppingItem>(
        `INSERT INTO list_items (user_name, list_name, item_text, added_by, url)
         VALUES ($1, 'shopping', $2, $3, $4)
         ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
         RETURNING id, item_text, category, added_by, url, created_at`,
        [targetUser, text, addedByLabel, itemUrl]
      );
      const newItem = rows[0];
      if (newItem) {
        added.push(newItem);
        categorizeAndUpdateItem(newItem.id, newItem.item_text).catch(() => {});
      }
    }

    if (duplicates.length > 0) {
      await sendFcmNotification({
        userName,
        notificationType: 'list-sync',
        title: duplicates.length === 1 ? 'Already on the list' : 'Some items already on the list',
        body: `"${duplicates.join('", "')}" already on ${targetUser}'s shopping list`,
        data: { tag: `list-dup-${userName}` },
      }).catch(() => {});
    }
    if (added.length > 0) {
      await sendFcmNotification({
        userName: targetUser,
        notificationType: 'list-sync',
        title: `${addedByLabel} added to your shopping list`,
        body: added.map((i) => i.item_text).join(', '),
        data: {
          tag: `list-shared-add-${added[0].id}`,
          deepLink: 'winston://lists?tab=shopping',
          companionMessage: `${addedByLabel} added "${added.map((i) => i.item_text).join('", "')}" to your shopping list.`,
        },
      }).catch(() => {});
    }
    // Single-item add keeps the original response shape (item/duplicate/message)
    // so nothing that only ever sent one item at a time sees a shape change.
    if (items.length === 1) {
      res.json(
        added[0]
          ? { item: added[0] }
          : { item: null, duplicate: true, message: `"${items[0]}" is already on that list` }
      );
      return;
    }
    res.json({ items: added, duplicates });
    return;
  }

  try {
    const added: ShoppingItem[] = [];
    for (const text of items) {
      const { rows } = await query<ShoppingItem>(
        `INSERT INTO list_items (user_name, list_name, item_text, url)
         VALUES ($1, 'shopping', $2, $3)
         ON CONFLICT (user_name, list_name, lower(item_text))
         DO UPDATE SET item_text = EXCLUDED.item_text,
                       url = CASE WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url ELSE list_items.url END
         RETURNING id, item_text, category, added_by, url, created_at`,
        [userName, text, itemUrl]
      );
      const newItem = rows[0];
      if (newItem) {
        added.push(newItem);
        categorizeAndUpdateItem(newItem.id, newItem.item_text).catch(() => {});
      }
    }
    if (added.length > 0) {
      syncListItemToConnections("shopping", added.map((i) => i.item_text), userName).catch(() => {});
    }

    // Single-item add keeps the original { item } response shape.
    if (items.length === 1) {
      res.json({ item: added[0] ?? null });
      return;
    }
    res.json({ items: added });
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
router.get(["/lists/todo", "/lists/to do", "/lists/to%20do"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await query<{ id: number; item_text: string; reminder_time: string | null; created_at: string }>(
      `SELECT id, reminder_text AS item_text, fire_at AS reminder_time, created_at
       FROM reminders
       WHERE user_name = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [userName]
    );
    res.json({ items: rows });
  } catch (err) {
    req.log.warn({ err }, "To Do GET error");
    res.status(500).json({ error: "Failed to fetch to do list" });
  }
});

router.post(["/lists/todo", "/lists/to do", "/lists/to%20do"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { item, ownerUserName } = req.body as { item?: string; ownerUserName?: string };
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }

  const targetUser = ownerUserName?.trim() ?? userName;

  if (targetUser !== userName) {
    const allowed = await hasListSharePermission(targetUser, userName, "to do").catch(() => false);
    if (!allowed) {
      res.status(403).json({ error: "You do not have permission to add to this list" });
      return;
    }
    const { rows: existing } = await query<{ id: number }>(
      `SELECT id FROM reminders
       WHERE user_name = $1 AND status = 'pending' AND fire_at IS NULL AND lower(reminder_text) = lower($2)`,
      [targetUser, item.trim()]
    );
    if (existing.length > 0) {
      await sendFcmNotification({
        userName,
        notificationType: 'list-sync',
        title: 'Already on the list',
        body: `"${item.trim()}" is already on ${targetUser}'s to-do list`,
        data: { tag: `list-dup-${userName}` },
      }).catch(() => {});
      res.json({ item: null, duplicate: true, message: `"${item.trim()}" is already on that list` });
      return;
    }
    const addedByLabel = await getRequesterLabel(targetUser, userName).catch(() => userName);
    const targetProfile = await getProfile(targetUser).catch(() => null);
    const newItem = await createReminder({
      userName: targetUser,
      reminderText: item.trim(),
      fireAt: null as any,
      timezone: targetProfile?.timezone ?? "UTC",
    });
    await sendFcmNotification({
      userName: targetUser,
      notificationType: 'list-sync',
      title: `${addedByLabel} added to your to-do list`,
      body: item.trim(),
      data: {
        tag: `list-shared-add-${newItem.id}`,
        deepLink: 'winston://lists?tab=todo',
        companionMessage: `${addedByLabel} added "${item.trim()}" to your to-do list.`,
      },
    }).catch(() => {});
    res.json({ item: { id: newItem.id, item_text: newItem.reminder_text, created_at: newItem.created_at } });
    return;
  }

  let resolvedItemText = item.trim();
  let resolvedFireAt: Date | null = null;
  if (/remind/i.test(resolvedItemText)) {
    try {
      const profile = await getProfile(userName).catch(() => null);
      const tz = profile?.timezone ?? "UTC";
      const extracted = await extractReminder(resolvedItemText, tz);
      if (extracted?.time) {
        const recurringPattern = extracted.recurring;
        const needsPatternScheduling =
          extracted.isRecurring &&
          recurringPattern &&
          (recurringPattern.startsWith("weekly:") || recurringPattern.startsWith("monthly:"));
        resolvedFireAt = needsPatternScheduling
          ? nextOccurrenceForPattern(recurringPattern!, extracted.time, tz)
          : extracted.explicitDate && !extracted.isRecurring
            ? computeFireAtForDate(extracted.explicitDate, extracted.time, tz)
            : extracted.dayOfWeek && !extracted.isRecurring
              ? resolveNextDayOfWeek(extracted.dayOfWeek, extracted.time, tz, extracted.nextWeek ?? false)
              : computeFireAt(extracted.time, tz, extracted.isTomorrow ?? false);
        resolvedItemText = extracted.reminderText || resolvedItemText;
      }
    } catch {
      // extraction failed — store as plain to-do
    }
  }

  try {
    const profile = await getProfile(userName).catch(() => null);
    const newItem = await createReminder({
      userName,
      reminderText: resolvedItemText,
      fireAt: (resolvedFireAt ?? null) as any,
      timezone: profile?.timezone ?? "UTC",
    });
    syncListItemToConnections("to do", [resolvedItemText], userName).catch(() => {});
    res.json({ item: { id: newItem.id, item_text: newItem.reminder_text, created_at: newItem.created_at } });
  } catch (err) {
    req.log.warn({ err }, "To Do POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

router.delete(["/lists/todo/:id", "/lists/to do/:id", "/lists/to%20do/:id"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  try {
    await query(
      `DELETE FROM reminders WHERE id = $1 AND user_name = $2 AND status = 'pending' RETURNING id`,
      [id, userName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "To Do DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ── POST /api/lists/todo/done — clear a to-do reminder without deleting the item ──
// Called by the native app when the user taps "Done ✓" on a to-do reminder
// notification. Clears reminder_time (the field the list screen checks to
// decide whether an item still has an active reminder) so the alarm badge
// disappears and todoReminderScheduler.ts never picks this row up again.
// Body: { itemId: number }
// Response: { ok: true }
router.post("/lists/todo/done", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const rawId = (req.body as { itemId?: number | string })?.itemId;
  const itemId = typeof rawId === "string" ? parseInt(rawId, 10) : rawId;
  if (!itemId || typeof itemId !== "number" || isNaN(itemId)) {
    res.status(400).json({ error: "itemId (number) is required" });
    return;
  }

  try {
    const { rows } = await query<{ id: number }>(
      `UPDATE list_items
          SET reminder_time  = NULL,
              reminder_fired = TRUE
        WHERE id = $1 AND user_name = $2
        RETURNING id`,
      [itemId, userName]
    );
    if (!rows.length) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    req.log.info({ userName, itemId }, "[Lists] To-do reminder cleared via notification action");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Lists] POST /lists/todo/done error");
    res.status(500).json({ error: "Failed to clear to-do reminder" });
  }
});

// ── POST /api/lists/todo/snooze — reschedule a to-do reminder 30 minutes out ─────
// Called by the native app when the user taps "Remind in 30 min" on a to-do
// reminder notification. todoReminderScheduler.ts's normal polling picks the
// item back up once reminder_time elapses.
// Body: { itemId: number }
// Response: { ok: true }
router.post("/lists/todo/snooze", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const rawId = (req.body as { itemId?: number | string })?.itemId;
  const itemId = typeof rawId === "string" ? parseInt(rawId, 10) : rawId;
  if (!itemId || typeof itemId !== "number" || isNaN(itemId)) {
    res.status(400).json({ error: "itemId (number) is required" });
    return;
  }

  try {
    const snoozeUntil = new Date(Date.now() + 30 * 60 * 1000);
    const { rows } = await query<{ id: number }>(
      `UPDATE list_items
          SET reminder_time  = $1,
              reminder_fired = FALSE
        WHERE id = $2 AND user_name = $3
        RETURNING id`,
      [snoozeUntil, itemId, userName]
    );
    if (!rows.length) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    req.log.info({ userName, itemId, snoozeUntil }, "[Lists] To-do reminder snoozed via notification action");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Lists] POST /lists/todo/snooze error");
    res.status(500).json({ error: "Failed to snooze to-do reminder" });
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
  const isAutoLookupList = !manualUrl && !!detectAutoLookupType(typeof listName === 'string' ? listName : listName[0]);

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
      autoUpdateItemUrl(newItem.id, newItem.item_text, typeof listName === 'string' ? listName : listName[0]).catch(() => {});
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

// PUT /api/lists/todo/:id — update a to-do item's text and/or fire_at (reminders table).
// MUST appear before the /lists/:listName/:id wildcard.
router.put(["/lists/todo/:id", "/lists/to do/:id", "/lists/to%20do/:id"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  const { item, reminder_time } = req.body as { item?: string; reminder_time?: string | null };
  try {
    const { rows } = await query<{ id: number; item_text: string; reminder_time: string | null; created_at: string }>(
      `UPDATE reminders
       SET reminder_text = COALESCE($1, reminder_text),
           fire_at = $2
       WHERE id = $3 AND user_name = $4 AND status = 'pending'
       RETURNING id, reminder_text AS item_text, fire_at AS reminder_time, created_at`,
      [item?.trim() ?? null, reminder_time ?? null, id, userName]
    );
    if (!rows[0]) { res.status(404).json({ error: "Item not found" }); return; }
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "To Do PUT error");
    res.status(500).json({ error: "Failed to update item" });
  }
});

// PUT /api/lists/:listName/:id — update an existing item's text, url, and/or reminder_time
// Full-resource PUT — the edit modal always sends every field, so an empty
// url/notes/reminder_time means the user explicitly cleared it, not "leave
// alone." COALESCE(newValue, oldValue) used to treat both the same (an
// empty string collapses to null before it reaches SQL), silently
// reverting a deliberate clear back to the old value — always write what
// was sent instead.
router.put("/lists/:listName/:id", async (req: Request, res: Response) => {
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
           url            = $2,
           reminder_time  = $3,
           reminder_fired = CASE WHEN $3 IS NOT NULL THEN FALSE ELSE reminder_fired END,
           notes          = $4
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
