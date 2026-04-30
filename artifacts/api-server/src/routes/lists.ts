import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { authenticate } from "../auth/middleware.js";
import {
  fullTasksSync,
  pullTasksFromGoogle,
  pushItemsToGoogleTasks,
} from "../google/tasks.js";

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
    // Use DISTINCT ON lower(show_name) so duplicate rows in watched_shows don't inflate the count.
    // Fall back to profile_items shows only if watched_shows is completely empty.
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

// GET /api/tasks/sync — manual bidirectional sync with Google Tasks
router.get("/tasks/sync", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const result = await fullTasksSync(userName);
    res.json({ ok: true, fromGoogle: result.fromGoogle, toGoogle: result.toGoogle });
  } catch (err) {
    req.log.warn({ err }, "Tasks sync error");
    res.status(500).json({ error: "Failed to sync Google Tasks" });
  }
});

// ── TV Shows — MUST be before /lists/:listName wildcard ──────────────────────
// GET /api/lists/tv-shows
router.get("/lists/tv-shows", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  // Disable client-side caching so stale empty responses don't mask fresh data
  res.setHeader("Cache-Control", "no-store");
  try {
    // watched_shows is the single source of truth.
    // DISTINCT ON lower(show_name) deduplicates rows where the same show was inserted
    // multiple times (e.g. mentioned in chat more than once). The lowest id wins.
    // Fall back to profile_items only if watched_shows has zero distinct rows.
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

// ── Generic list_items — wildcard routes AFTER specific routes ────────────────
// GET /api/lists/:listName — fetch all items for a list
router.get("/lists/:listName", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { listName } = req.params;
  try {
    if (listName === "to do" || listName === "to%20do") {
      pullTasksFromGoogle(userName).catch(() => {});
    }
    const { rows } = await query<{ id: number; item_text: string; created_at: string }>(
      `SELECT id, item_text, created_at
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
    const { rows } = await query<{ id: number; item_text: string; created_at: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT list_items_uq
       DO UPDATE SET item_text = EXCLUDED.item_text
       RETURNING id, item_text, created_at`,
      [userName, listName, item.trim()]
    );
    if (listName === "to do" && rows[0]) {
      pushItemsToGoogleTasks(userName, [item.trim()]).catch(() => {});
    }
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
