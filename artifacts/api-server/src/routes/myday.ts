import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { authenticate } from "../auth/middleware.js";

// ── Ensure table exists (idempotent) ─────────────────────────────────────────
query(`
  CREATE TABLE IF NOT EXISTS myday_entries (
    id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
    user_name   text NOT NULL,
    entry_date  date NOT NULL,
    content     text NOT NULL,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    UNIQUE (user_name, entry_date)
  )
`).catch((err) => {
  console.error("[MyDay] Table init failed:", err);
});

const router: IRouter = Router();

// ── POST /api/myday — save (upsert) an entry for today or a given date ───────
router.post("/myday", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { content, date } = req.body as { content?: string; date?: string };

  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  // If a date is provided use it; otherwise default to today in UTC
  const entryDate = date ?? new Date().toISOString().slice(0, 10);

  const { rows } = await query<{
    id: number;
    entry_date: string;
    content: string;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO myday_entries (user_name, entry_date, content, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_name, entry_date)
     DO UPDATE SET content = EXCLUDED.content, updated_at = now()
     RETURNING id, entry_date, content, created_at, updated_at`,
    [userName, entryDate, content.trim()]
  );

  res.json(rows[0]);
});

// ── GET /api/myday — all entries for the user, newest first ──────────────────
router.get("/myday", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { rows } = await query<{
    id: number;
    entry_date: string;
    content: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, entry_date, content, created_at, updated_at
     FROM myday_entries
     WHERE user_name = $1
     ORDER BY entry_date DESC`,
    [userName]
  );

  res.json(rows);
});

// ── GET /api/myday/:date — entry for a specific date (YYYY-MM-DD) ─────────────
router.get("/myday/:date", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { date } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
    return;
  }

  const { rows } = await query<{
    id: number;
    entry_date: string;
    content: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, entry_date, content, created_at, updated_at
     FROM myday_entries
     WHERE user_name = $1 AND entry_date = $2`,
    [userName, date]
  );

  if (!rows.length) {
    res.status(404).json({ error: "No entry found for this date" });
    return;
  }

  res.json(rows[0]);
});

export default router;
