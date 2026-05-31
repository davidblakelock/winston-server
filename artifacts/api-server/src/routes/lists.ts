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
import { autoUpdateItemUrl, autoUpdateRestaurantUrl, detectAutoLookupType, lookupRestaurantUrl } from "../lists/autoUrlLookup.js";
import { sendPushToAll } from "../push/pushManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router: IRouter = Router();

// ── Idempotent column migrations for list_items ────────────────────────────
query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS reminder_time TIMESTAMPTZ`).catch(() => {});
query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS reminder_fired BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});

// ── Idempotent column migration for profile_items (restaurants) ─────────────
// The url column was added after initial schema creation — ensure it exists in
// Supabase before any restaurant SELECT/INSERT/UPDATE referencing it runs.
query(`ALTER TABLE profile_items ADD COLUMN IF NOT EXISTS url TEXT`).catch(() => {});

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

// GET /api/lists — always returns all 4 lists with real counts from their respective tables
router.get("/lists", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");

  // Fixed list names that are handled by dedicated routes/tables or profile_items.
  const SYSTEM_LISTS = new Set(["shopping", "to do", "tv-shows", "restaurants"]);

  try {
    // All lists from list_items, grouped case-insensitively to avoid duplicates
    // when the same list was created with different capitalisations.
    const { rows: listRows } = await query<{ list_name: string; item_count: string }>(
      `SELECT lower(list_name) AS list_name, COUNT(*) AS item_count
       FROM list_items
       WHERE user_name = $1
       GROUP BY lower(list_name)`,
      [userName]
    );
    const listCounts: Record<string, number> = {};
    for (const r of listRows) listCounts[r.list_name] = parseInt(r.item_count, 10);

    // TV Shows — watched_shows is the single source of truth.
    const { rows: wsCountRows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT DISTINCT ON (lower(show_name)) id
         FROM watched_shows
         WHERE user_name = ANY($1)
         ORDER BY lower(show_name), id ASC
       ) sub`,
      [[userName, "David"]]
    );
    const wsCount = parseInt(wsCountRows[0]?.cnt ?? "0", 10);
    let tvCount: number;
    if (wsCount > 0) {
      tvCount = wsCount;
    } else {
      const { rows: piCountRows } = await query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM profile_items WHERE user_name = $1 AND category = 'shows'`,
        [userName]
      );
      tvCount = parseInt(piCountRows[0]?.cnt ?? "0", 10);
    }

    // Restaurants — from profile_items
    const { rows: restRows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM profile_items WHERE user_name = $1 AND category = 'restaurants'`,
      [userName]
    );
    const restCount = parseInt(restRows[0]?.cnt ?? "0", 10);

    // Custom lists — any list_name in list_items that isn't a system list or restaurants
    const customLists = Object.entries(listCounts)
      .filter(([name]) => !SYSTEM_LISTS.has(name))
      .map(([name, count]) => ({
        listName: name,
        displayName: name
          .split(" ")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        itemCount: count,
        isCustom: true,
      }));

    res.json({
      lists: [
        { listName: "shopping",    displayName: "Shopping",     itemCount: listCounts["shopping"] ?? 0 },
        { listName: "to do",       displayName: "To Do",        itemCount: listCounts["to do"] ?? 0 },
        { listName: "tv-shows",    displayName: "TV Shows",     itemCount: tvCount },
        { listName: "restaurants", displayName: "Restaurants",  itemCount: restCount },
        ...customLists,
      ],
    });
  } catch (err) {
    req.log.warn({ err }, "Lists index GET error");
    res.status(500).json({ error: "Failed to fetch lists" });
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
    const { rows } = await query<{ id: number; name: string; detail: string | null; url: string | null; created_at: string }>(
      `SELECT id, name, detail, url, created_at
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
        created_at: r.created_at,
      })),
    });

    // Lazy URL backfill: for restaurants that have no URL (typically added via chat/profile
    // manager before auto-lookup was wired up), trigger background lookups capped at 5 at a time.
    const nullUrlRows = rows.filter((r) => !r.url);
    if (nullUrlRows.length > 0) {
      const batch = nullUrlRows.slice(0, 5);
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
  try {
    const { rows } = await query<{ id: number; name: string }>(
      `INSERT INTO profile_items (user_name, category, name, detail, url)
       SELECT $1, 'restaurants', $2, NULL, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM profile_items
         WHERE user_name = $1 AND category = 'restaurants' AND lower(name) = lower($2)
       )
       RETURNING id, name`,
      [userName, item, manualUrl]
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
          await query(
            `UPDATE profile_items SET url = $1 WHERE id = $2`,
            [resolvedUrl, newItem.id]
          );
          req.log.info({ id: newItem.id, name: newItem.name, url: resolvedUrl }, "[Restaurants] URL auto-resolved");
        }
      } catch (lookupErr) {
        req.log.warn({ lookupErr, name: newItem.name }, "[Restaurants] URL lookup failed — restaurant saved without URL");
      }
    }

    res.json({ item: { id: newItem.id, item_text: newItem.name, url: resolvedUrl ?? null, created_at: new Date().toISOString() } });
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

// PUT /api/lists/restaurants/:id — update a restaurant name and/or url
router.put("/lists/restaurants/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { id } = req.params;
  const { item, url: rawUrl } = req.body as { item?: string; url?: string };
  if (!item?.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }
  const manualUrl = rawUrl?.trim() || null;
  try {
    const { rows } = await query<{ id: number; name: string; url: string | null }>(
      `UPDATE profile_items
       SET name = $1, url = COALESCE($2, url)
       WHERE id = $3 AND user_name = $4 AND category = 'restaurants'
       RETURNING id, name, url`,
      [item.trim(), manualUrl, id, userName]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }
    res.json({ item: { id: rows[0].id, item_text: rows[0].name, url: rows[0].url } });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list PUT error");
    res.status(500).json({ error: "Failed to update restaurant" });
  }
});

// POST /api/lists/restaurants/backfill-urls
// Queues background URL lookups for all restaurants that still have url = NULL.
// Returns { queued: N } immediately; lookups run sequentially with 500 ms gaps.
router.post("/lists/restaurants/backfill-urls", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { rows } = await query<{ id: number; name: string }>(
      `SELECT id, name FROM profile_items
       WHERE user_name = $1 AND category = 'restaurants' AND url IS NULL
       ORDER BY created_at ASC`,
      [userName]
    );
    res.json({ queued: rows.length });

    // Run sequentially with 500 ms delay to avoid flooding the Anthropic API.
    (async () => {
      for (const row of rows) {
        await autoUpdateRestaurantUrl(row.id, row.name);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
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

// ── GET /api/lists/grocery-deeplinks ─────────────────────────────────────────
// Returns a deep link for each item on the shopping list using the user's
// preferred grocery service (set via POST /api/integrations/:service/set-preferred).
// MUST appear before the /lists/:listName wildcard.
router.get("/lists/grocery-deeplinks", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const [prefRows, itemRows] = await Promise.all([
      query<{ service_name: string }>(
        `SELECT service_name FROM user_service_preferences
         WHERE user_name = $1 AND service_type = 'grocery' AND preferred = true AND is_connected = true
         LIMIT 1`,
        [userName]
      ).then((r) => r.rows).catch((): Array<{ service_name: string }> => []),
      query<{ id: number; item_text: string; category: string | null }>(
        `SELECT id, item_text, category FROM list_items
         WHERE user_name = $1 AND list_name = 'shopping'
         ORDER BY category NULLS LAST, item_text`,
        [userName]
      ).then((r) => r.rows).catch((): Array<{ id: number; item_text: string; category: string | null }> => []),
    ]);

    const service = prefRows[0]?.service_name ?? null;

    const deeplinks = itemRows.map((item) => ({
      id: item.id,
      item: item.item_text,
      category: item.category,
      url: buildGroceryDeepLink(service, item.item_text),
    }));

    res.json({ service, deeplinks });
  } catch (err) {
    req.log.warn({ err }, "[Lists] grocery-deeplinks error");
    res.status(500).json({ error: "Failed to fetch grocery deep links" });
  }
});

function buildGroceryDeepLink(service: string | null, item: string): string | null {
  const encoded = encodeURIComponent(item);
  switch (service) {
    case "instacart":    return `https://www.instacart.com/store/search_v3/term?term=${encoded}`;
    case "walmart":      return `https://www.walmart.com/search?q=${encoded}`;
    case "heb":          return `https://www.heb.com/search/?q=${encoded}`;
    case "kroger":       return `https://www.kroger.com/search?query=${encoded}`;
    case "shipt":        return `https://www.shipt.com/search?query=${encoded}`;
    case "amazon_fresh": return `https://www.amazon.com/s?k=${encoded}&i=amazonfresh`;
    case "amazon":       return `https://www.amazon.com/s?k=${encoded}`;
    default:             return null;
  }
}

// ── To Do — dedicated slug so the URL never needs %20 encoding ───────────────
// Maps the clean /todo path to list_name = 'to do' in the DB.
// MUST appear before the /lists/:listName wildcard.
router.get(["/lists/todo", "/lists/to do"], async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null }>(
      `SELECT id, item_text, added_by, url, created_at, reminder_time FROM list_items
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
  const { item, url: rawTodoUrl, ownerUserName, reminder_time: rawReminderTime } = req.body as { item?: string; url?: string; ownerUserName?: string; reminder_time?: string };
  const manualUrl = rawTodoUrl?.trim() || null;
  const reminderTime = rawReminderTime?.trim() || null;
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
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null }>(
      `INSERT INTO list_items (user_name, list_name, item_text, added_by, url, reminder_time)
       VALUES ($1, 'to do', $2, $3, $4, $5)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id, item_text, added_by, url, created_at, reminder_time`,
      [targetUser, item.trim(), addedByLabel, manualUrl, reminderTime]
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
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null }>(
      `INSERT INTO list_items (user_name, list_name, item_text, url, reminder_time)
       VALUES ($1, 'to do', $2, $3, $4)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text     = EXCLUDED.item_text,
                     url           = CASE WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url ELSE list_items.url END,
                     reminder_time = CASE WHEN EXCLUDED.reminder_time IS NOT NULL THEN EXCLUDED.reminder_time ELSE list_items.reminder_time END,
                     reminder_fired = CASE WHEN EXCLUDED.reminder_time IS NOT NULL THEN FALSE ELSE list_items.reminder_fired END
       RETURNING id, item_text, added_by, url, created_at, reminder_time`,
      [userName, item.trim(), manualUrl, reminderTime]
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
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string; reminder_time: string | null }>(
      `SELECT id, item_text, added_by, url, created_at, reminder_time
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
  const { item, url } = req.body as { item?: string; url?: string };
  if (!item || !item.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }

  const manualUrl = url?.trim() || null;
  const isAutoLookupList = !manualUrl && !!detectAutoLookupType(listName);

  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text, url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text,
                     url = CASE
                             WHEN EXCLUDED.url IS NOT NULL THEN EXCLUDED.url
                             ELSE list_items.url
                           END
       RETURNING id, item_text, added_by, url, created_at`,
      [userName, listName, item.trim(), manualUrl]
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

// PUT /api/lists/:listName/:id — update an existing item's text and/or url
router.put("/lists/:listName/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName, id } = req.params;
  const { item, url: rawUrl } = req.body as { item?: string; url?: string };
  if (!item?.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }
  const manualUrl = rawUrl?.trim() || null;
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; url: string | null; created_at: string }>(
      `UPDATE list_items
       SET item_text = $1, url = COALESCE($2, url)
       WHERE id = $3 AND user_name = $4 AND list_name = $5
       RETURNING id, item_text, added_by, url, created_at`,
      [item.trim(), manualUrl, id, userName, listName]
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
