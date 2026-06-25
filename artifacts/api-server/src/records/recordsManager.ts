import { query } from "../db.js";

export interface NewUserRecord {
  category: "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other";
  vendorName: string;
  confirmationNumber: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  time: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  amount: string | null;
  notes: string | null;
  rawSnippet: string | null;
  gmailId?: string | null;
}

// ── Schema migrations (idempotent) ────────────────────────────────────────────

export async function ensureUserRecordsColumns(): Promise<void> {
  await query(`ALTER TABLE user_records ADD COLUMN IF NOT EXISTS gmail_id TEXT`).catch(() => {});
  // Partial unique index — only dedups rows that came from Gmail (gmail_id IS NOT NULL).
  // Rows from inbound-email webhook or other paths (gmail_id NULL) insert freely.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_records_gmail_id_idx
    ON user_records (user_name, gmail_id) WHERE gmail_id IS NOT NULL
  `).catch(() => {});
}

// ── Social scan DB-backed state (mirrors order_sync_state) ────────────────────

export async function ensureSocialScanStateTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS social_scan_state (
      user_name TEXT PRIMARY KEY,
      last_scan_at TIMESTAMPTZ
    )
  `);
}

export async function getLastSocialScanAt(userName: string): Promise<Date | null> {
  const { rows } = await query<{ last_scan_at: string | null }>(
    `SELECT last_scan_at FROM social_scan_state WHERE user_name = $1`,
    [userName]
  );
  const val = rows[0]?.last_scan_at;
  return val ? new Date(val) : null;
}

export async function updateLastSocialScanAt(userName: string): Promise<void> {
  await query(
    `INSERT INTO social_scan_state (user_name, last_scan_at)
     VALUES ($1, now())
     ON CONFLICT (user_name)
     DO UPDATE SET last_scan_at = now()`,
    [userName]
  );
}

// ── Insert ────────────────────────────────────────────────────────────────────

export async function insertUserRecord(
  userName: string,
  record: NewUserRecord
): Promise<void> {
  if (record.gmailId) {
    // ON CONFLICT targets the partial unique index — skips silently if this Gmail
    // message has already been saved, preventing duplicates across server restarts.
    await query(
      `INSERT INTO user_records
         (user_name, category, vendor_name, confirmation_number,
          date_start, date_end, time, address, phone, website,
          amount, notes, raw_email_snippet, gmail_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_name, gmail_id) WHERE gmail_id IS NOT NULL DO NOTHING`,
      [
        userName,
        record.category,
        record.vendorName,
        record.confirmationNumber,
        record.dateStart,
        record.dateEnd,
        record.time,
        record.address,
        record.phone,
        record.website,
        record.amount,
        record.notes,
        record.rawSnippet,
        record.gmailId,
      ]
    );
  } else {
    await query(
      `INSERT INTO user_records
         (user_name, category, vendor_name, confirmation_number,
          date_start, date_end, time, address, phone, website,
          amount, notes, raw_email_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        userName,
        record.category,
        record.vendorName,
        record.confirmationNumber,
        record.dateStart,
        record.dateEnd,
        record.time,
        record.address,
        record.phone,
        record.website,
        record.amount,
        record.notes,
        record.rawSnippet,
      ]
    );
  }
}
