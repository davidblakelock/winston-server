import { Router, type IRouter, type Request, type Response } from "express";
import { query } from "../db.js";
import { authenticate, NATIVE_STORED_NAME } from "../auth/middleware.js";

export const VALID_SOURCES = ["voice", "text", "evening-checkin"] as const;
type JournalSource = (typeof VALID_SOURCES)[number];

export async function ensureJournalSourceColumn(): Promise<void> {
  await query(`
    ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'text'
  `);
}

const router: IRouter = Router();

// GET /api/journal — paginated, most recent first
router.get("/journal", async (req: Request, res: Response) => {
  try {
    const userName = (await authenticate(req, res).catch(() => null)) ?? NATIVE_STORED_NAME;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const offset = (page - 1) * limit;

    const [entriesRes, countRes] = await Promise.all([
      query<{
        id: number;
        entry_date: string;
        content: string;
        source: string;
        created_at: string;
      }>(
        `SELECT id, entry_date, content, source, created_at
         FROM journal_entries
         WHERE user_name = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userName, String(limit), String(offset)]
      ),
      query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM journal_entries WHERE user_name = $1`,
        [userName]
      ),
    ]);

    const total = parseInt(countRes.rows[0]?.total ?? "0", 10);

    res.json({
      entries: entriesRes.rows.map((r) => ({
        id: r.id,
        entryDate: r.entry_date,
        content: r.content,
        source: r.source,
        createdAt: r.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    req.log?.warn({ err }, "Journal GET error");
    res.status(500).json({ error: "Failed to fetch journal entries" });
  }
});

// POST /api/journal — create entry
router.post("/journal", async (req: Request, res: Response) => {
  try {
    const userName = (await authenticate(req, res).catch(() => null)) ?? NATIVE_STORED_NAME;
    const { text, source, timestamp } = req.body as {
      text?: string;
      source?: string;
      timestamp?: string;
    };

    if (!text?.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const resolvedSource: JournalSource = VALID_SOURCES.includes(source as JournalSource)
      ? (source as JournalSource)
      : "text";

    const entryDate = timestamp
      ? new Date(timestamp).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    const { rows } = await query<{
      id: number;
      entry_date: string;
      content: string;
      source: string;
      created_at: string;
    }>(
      `INSERT INTO journal_entries (user_name, content, source, entry_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id, entry_date, content, source, created_at`,
      [userName, text.trim(), resolvedSource, entryDate]
    );

    res.status(201).json({
      entry: {
        id: rows[0].id,
        entryDate: rows[0].entry_date,
        content: rows[0].content,
        source: rows[0].source,
        createdAt: rows[0].created_at,
      },
    });
  } catch (err) {
    req.log?.warn({ err }, "Journal POST error");
    res.status(500).json({ error: "Failed to create journal entry" });
  }
});

// PUT /api/journal/:id — edit text
router.put("/journal/:id", async (req: Request, res: Response) => {
  try {
    const userName = (await authenticate(req, res).catch(() => null)) ?? NATIVE_STORED_NAME;
    const id = parseInt(req.params.id, 10);
    const { text } = req.body as { text?: string };

    if (!text?.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const { rows } = await query<{
      id: number;
      entry_date: string;
      content: string;
      source: string;
      created_at: string;
    }>(
      `UPDATE journal_entries SET content = $1
       WHERE id = $2 AND user_name = $3
       RETURNING id, entry_date, content, source, created_at`,
      [text.trim(), id, userName]
    );

    if (!rows.length) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }

    res.json({
      entry: {
        id: rows[0].id,
        entryDate: rows[0].entry_date,
        content: rows[0].content,
        source: rows[0].source,
        createdAt: rows[0].created_at,
      },
    });
  } catch (err) {
    req.log?.warn({ err }, "Journal PUT error");
    res.status(500).json({ error: "Failed to update journal entry" });
  }
});

// DELETE /api/journal/:id
router.delete("/journal/:id", async (req: Request, res: Response) => {
  try {
    const userName = (await authenticate(req, res).catch(() => null)) ?? NATIVE_STORED_NAME;
    const id = parseInt(req.params.id, 10);

    const { rowCount } = await query(
      `DELETE FROM journal_entries WHERE id = $1 AND user_name = $2`,
      [id, userName]
    );

    if ((rowCount ?? 0) === 0) {
      res.status(404).json({ error: "Journal entry not found" });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    req.log?.warn({ err }, "Journal DELETE error");
    res.status(500).json({ error: "Failed to delete journal entry" });
  }
});

export default router;
