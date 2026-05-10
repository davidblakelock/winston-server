import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { authenticate } from "../auth/middleware.js";
import {
  batchCategorizeItems,
  categorizeAndUpdateItem,
  syncListItemToConnections,
  sortByCategory,
} from "../lists/listManager.js";

const router: IRouter = Router();

// GET /api/lists — always returns all 4 lists with real counts from their respective tables
router.get("/lists", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    // Shopping and To Do — from list_items
    const { rows: listRows } = await query<{ list_name: string; item_count: string }>(
      `SELECT list_name, COUNT(*) AS item_count
       FROM list_items
       WHERE user_name = $1 AND list_name IN ('shopping', 'to do')
       GROUP BY list_name`,
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

    res.json({
      lists: [
        { listName: "shopping",    displayName: "Shopping",     itemCount: listCounts["shopping"] ?? 0 },
        { listName: "to do",       displayName: "To Do",        itemCount: listCounts["to do"] ?? 0 },
        { listName: "tv-shows",    displayName: "TV Shows",     itemCount: tvCount },
        { listName: "restaurants", displayName: "Restaurants",  itemCount: restCount },
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
  try {
    const { rows } = await query<{ id: number; name: string; detail: string | null; created_at: string }>(
      `SELECT id, name, detail, created_at
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
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    req.log.warn({ err }, "Restaurants list GET error");
    res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});

// POST /api/lists/restaurants
router.post("/lists/restaurants", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const item = (req.body?.item ?? "").trim();
  if (!item) return res.status(400).json({ error: "item required" });
  try {
    const { rows } = await query<{ id: number; name: string }>(
      `INSERT INTO profile_items (user_name, category, name, detail)
       SELECT $1, 'restaurants', $2, NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM profile_items
         WHERE user_name = $1 AND category = 'restaurants' AND lower(name) = lower($2)
       )
       RETURNING id, name`,
      [userName, item]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: "Restaurant already in list" });
    }
    res.json({ item: { id: rows[0].id, item_text: rows[0].name, created_at: new Date().toISOString() } });
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

// ── Shopping — dedicated routes (Feature 2: auto-categorize + Feature 1: sync)
// MUST be before the /lists/:listName wildcard.

interface ShoppingItem {
  id: number;
  item_text: string;
  category: string | null;
  added_by: string | null;
  created_at: string;
}

// GET /api/lists/shopping — returns items sorted by category, with category + added_by fields
router.get("/lists/shopping", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { rows } = await query<ShoppingItem>(
      `SELECT id, item_text, category, added_by, created_at
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
  const { item } = req.body as { item?: string };
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }
  try {
    const { rows } = await query<ShoppingItem>(
      `INSERT INTO list_items (user_name, list_name, item_text)
       VALUES ($1, 'shopping', $2)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text
       RETURNING id, item_text, category, added_by, created_at`,
      [userName, item.trim()]
    );
    const newItem = rows[0];

    // Fire-and-forget: categorize + sync
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
router.get("/lists/todo", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; created_at: string }>(
      `SELECT id, item_text, added_by, created_at FROM list_items
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

router.post("/lists/todo", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { item } = req.body as { item?: string };
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; created_at: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text)
       VALUES ($1, 'to do', $2)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text
       RETURNING id, item_text, added_by, created_at`,
      [userName, item.trim()]
    );
    syncListItemToConnections("to do", [item.trim()], userName).catch(() => {});
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "To Do POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

router.delete("/lists/todo/:id", async (req: Request, res: Response) => {
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

// ── Generic list_items — wildcard routes AFTER specific routes ────────────────
// GET /api/lists/:listName — fetch all items for a list
router.get("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; created_at: string }>(
      `SELECT id, item_text, added_by, created_at
       FROM list_items
       WHERE user_name = $1 AND list_name = $2
       ORDER BY created_at ASC`,
      [userName, listName]
    );
    res.json({ items: rows });
  } catch (err) {
    req.log.warn({ err }, "Lists GET error");
    res.status(500).json({ error: "Failed to fetch list" });
  }
});

// POST /api/lists/:listName — add an item
router.post("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  const { item } = req.body as { item?: string };
  if (!item || !item.trim()) {
    res.status(400).json({ error: "item is required" });
    return;
  }
  try {
    const { rows } = await query<{ id: number; item_text: string; added_by: string | null; created_at: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, list_name, lower(item_text))
       DO UPDATE SET item_text = EXCLUDED.item_text
       RETURNING id, item_text, added_by, created_at`,
      [userName, listName, item.trim()]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "Lists POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// DELETE /api/lists/:listName/:id — remove an item by id
router.delete("/lists/:listName/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName, id } = req.params;
  try {
    await query(
      `DELETE FROM list_items WHERE id = $1 AND user_name = $2 AND list_name = $3 RETURNING id`,
      [id, userName, listName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Lists DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

export default router;
