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
}

type GroupedRecords = Record<string, UserRecord[]>;

// ── GET /api/records ───────────────────────────────────────────────────────────
// Returns all user_records for the authenticated user, grouped by category.

router.get("/records", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const { rows } = await query<UserRecord>(
      `SELECT id, user_name, category, trip_id, vendor_name, confirmation_number,
              date_start, date_end, time, address, phone, website,
              amount, notes, raw_email_snippet, service_provider_id, created_at
       FROM user_records
       WHERE user_name = $1
       ORDER BY category ASC, date_start ASC NULLS LAST`,
      [userName]
    );

    const grouped: GroupedRecords = {
      trip: [],
      warranty: [],
      home_service: [],
      subscription: [],
      vehicle: [],
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

export default router;
