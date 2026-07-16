import { Router, type IRouter } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";

const router: IRouter = Router();

interface UserRecord {
  id: number;
  user_name: string;
  category: string;
  trip_id: number | null;
  vendor_name: string | null;
  confirmation_number: string | null;
  date_start: string | null;
  date_end: string | null;
  time: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  amount: string | null;
  notes: string | null;
  raw_email_snippet: string | null;
  service_provider_id: number | null;
  created_at: string;
  deleted_at: string | null;
}

type GroupedRecords = Record<string, UserRecord[]>;

// ── GET /api/records ───────────────────────────────────────────────────────────
// Returns all non-deleted user_records for the authenticated user, grouped by category.

router.get("/records", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const { rows } = await query<UserRecord>(
      `SELECT id, user_name, category, trip_id, vendor_name, confirmation_number,
              date_start, date_end, time, address, phone, website,
              amount, notes, raw_email_snippet, service_provider_id, created_at, deleted_at
       FROM user_records
       WHERE user_name = $1
         AND deleted_at IS NULL
       ORDER BY category ASC, date_start ASC NULLS LAST, vendor_name ASC`,
      [userName]
    );

    const grouped: GroupedRecords = {
      trip: [],
      warranty: [],
      home_service: [],
      subscription: [],
      vehicle: [],
      order: [],
      other: [],
    };

    for (const row of rows) {
      const bucket = row.category in grouped ? row.category : "other";
      grouped[bucket].push(row);
    }

    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: "Failed to load records" });
  }
});

// ── PUT /api/records/:id ───────────────────────────────────────────────────────
// Partial update — only fields present in the request body are written.

const UPDATABLE_FIELDS = [
  "vendor_name", "confirmation_number", "date_start", "date_end",
  "time", "address", "phone", "website", "amount", "notes",
] as const;
type UpdatableField = typeof UPDATABLE_FIELDS[number];

router.put("/records/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: "Invalid record id" });

  const body = req.body as Record<string, unknown>;
  const updates: Partial<Record<UpdatableField, unknown>> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in body) updates[field] = body[field] ?? null;
  }

  if (Object.keys(updates).length === 0) {
    return void res.status(400).json({ error: "No updatable fields provided" });
  }

  const fields = Object.keys(updates) as UpdatableField[];
  const setClauses = fields.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const values = fields.map((f) => updates[f]);

  try {
    const { rows } = await query<UserRecord>(
      `UPDATE user_records
       SET ${setClauses}
       WHERE id = $${fields.length + 1}
         AND user_name = $${fields.length + 2}
         AND deleted_at IS NULL
       RETURNING *`,
      [...values, id, userName]
    );

    if (rows.length === 0) return void res.status(404).json({ error: "Record not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update record" });
  }
});

// ── DELETE /api/records/:id ────────────────────────────────────────────────────
// Soft delete — sets deleted_at = NOW(), does not remove the row.

router.delete("/records/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: "Invalid record id" });

  try {
    const { rows } = await query<{ id: number }>(
      `UPDATE user_records
       SET deleted_at = NOW()
       WHERE id = $1
         AND user_name = $2
         AND deleted_at IS NULL
       RETURNING id`,
      [id, userName]
    );

    if (rows.length === 0) return void res.status(404).json({ error: "Record not found" });
    res.json({ deleted: true, id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete record" });
  }
});

export default router;
