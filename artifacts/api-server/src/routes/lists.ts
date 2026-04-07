import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";

const router: IRouter = Router();

const USER = "David";

// GET /api/lists/:listName — fetch all items for a list
router.get("/lists/:listName", async (req: Request, res: Response) => {
  const { listName } = req.params;
  try {
    const { rows } = await query<{ id: number; item_text: string; created_at: string }>(
      `SELECT id, item_text, created_at
       FROM list_items
       WHERE user_name = $1 AND list_name = $2
       ORDER BY created_at ASC`,
      [USER, listName]
    );
    res.json({ items: rows });
  } catch (err) {
    req.log.warn({ err }, "Lists GET error");
    res.status(500).json({ error: "Failed to fetch list" });
  }
});

// POST /api/lists/:listName — add an item
router.post("/lists/:listName", async (req: Request, res: Response) => {
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
       RETURNING id, item_text, created_at`,
      [USER, listName, item.trim()]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    req.log.warn({ err }, "Lists POST error");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// DELETE /api/lists/:listName/:id — remove an item by id
router.delete("/lists/:listName/:id", async (req: Request, res: Response) => {
  const { listName, id } = req.params;
  try {
    await query(
      `DELETE FROM list_items WHERE id = $1 AND user_name = $2 AND list_name = $3`,
      [id, USER, listName]
    );
    res.json({ deleted: true });
  } catch (err) {
    req.log.warn({ err }, "Lists DELETE error");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

export default router;
