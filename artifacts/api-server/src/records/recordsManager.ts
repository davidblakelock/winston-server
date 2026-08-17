import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface NewUserRecord {
  category: "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "vehicle_registration" | "order" | "other";
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

// ── Dedup context for classifiers ──────────────────────────────────────────────
// The real root cause of duplicate records (e.g. two separate rows for the
// same home inspection, pulled from two different emails in the same
// back-and-forth thread): classification happens per-email, in complete
// isolation — the classifier has no way to know an event is already on file,
// so an existing prompt instruction ("never treat a reminder about an
// appointment you already have on file as a new record") was structurally
// unenforceable, no matter how it was worded. This gives both scanners
// (reservationScanner.ts, emailClassifier.ts via backgroundEmailScanner.ts)
// the missing context — the user's own recent/upcoming records — so that
// instruction has something to actually check against. Scoped to the last 60
// days OR a future date_start, since a duplicate is only worth catching while
// the original is still relevant; ancient history isn't worth the prompt
// tokens.
export async function getRecentRecordsContextBlock(userName: string): Promise<string> {
  try {
    const { rows } = await query<{
      category: string;
      vendor_name: string;
      date_start: string | null;
      notes: string | null;
    }>(
      `SELECT category, vendor_name, date_start, notes
       FROM user_records
       WHERE user_name = $1
         AND deleted_at IS NULL
         AND (created_at > NOW() - INTERVAL '60 days' OR date_start >= CURRENT_DATE)
       ORDER BY created_at DESC
       LIMIT 30`,
      [userName]
    );
    if (rows.length === 0) return "None on file.";
    return rows
      .map((r) => `- ${r.vendor_name} (${r.category})${r.date_start ? ` — ${r.date_start}` : ""}${r.notes ? `: ${r.notes}` : ""}`)
      .join("\n");
  } catch (err) {
    logger.warn({ err, userName }, "[Records] getRecentRecordsContextBlock failed");
    return "None on file.";
  }
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

export async function updateLastSocialScanAt(userName: string, at?: Date): Promise<void> {
  await query(
    `INSERT INTO social_scan_state (user_name, last_scan_at)
     VALUES ($1, $2)
     ON CONFLICT (user_name)
     DO UPDATE SET last_scan_at = $2`,
    [userName, at ?? new Date()]
  );
}

// ── Insert ────────────────────────────────────────────────────────────────────
// Return value tells the caller whether a genuinely NEW record was created
// ("inserted") vs an existing one was merged/updated ("updated") or a
// literal duplicate was silently dropped ("skipped") — callers use this to
// decide whether the user actually needs a fresh notification. A booking
// that's already known about (a hold that got a reminder resent, a
// follow-up email that merges into the same trip) shouldn't re-notify just
// because the underlying email pipeline processed another message about it.

export type InsertUserRecordOutcome = "inserted" | "updated" | "skipped";

export async function insertUserRecord(
  userName: string,
  record: NewUserRecord
): Promise<InsertUserRecordOutcome> {
  // ── Idempotent upsert strategy ────────────────────────────────────────────
  // Priority 1: if same confirmation_number + user_name already exists,
  //   update it — handles re-sends of the same booking with a new Gmail ID.
  // Priority 1.5 (trip category only): a temporary hold and its eventual
  //   e-ticket legitimately carry DIFFERENT confirmation codes by airline
  //   design, so exact-code matching structurally can't connect them —
  //   fall back to same vendor within a recent window and merge into that
  //   instead. Scoped to "trip" specifically because it's a one-off event;
  //   for a subscription or recurring vehicle service, "same vendor again
  //   soon" is normal and would NOT mean the same booking.
  // Priority 2: if same gmail_id + user_name already exists, skip silently
  //   — prevents duplicates across server restarts.
  // Priority 3: fresh insert.

  // Check for existing record by confirmation_number first (most reliable key)
  if (record.confirmationNumber) {
    const existing = await query<{ id: number }>(
      `SELECT id FROM user_records
       WHERE user_name = $1
         AND confirmation_number = $2
         AND deleted_at IS NULL
       LIMIT 1`,
      [userName, record.confirmationNumber]
    );
    if (existing.rows.length > 0) {
      // Update existing record — same confirmation, possibly updated details
      await query(
        `UPDATE user_records SET
           vendor_name       = COALESCE($3, vendor_name),
           date_start        = COALESCE($4::date, date_start),
           date_end          = COALESCE($5::date, date_end),
           time              = COALESCE($6, time),
           address           = COALESCE($7, address),
           phone             = COALESCE($8, phone),
           website           = COALESCE($9, website),
           amount            = COALESCE($10, amount),
           notes             = COALESCE($11, notes),
           raw_email_snippet = COALESCE($12, raw_email_snippet),
           gmail_id          = COALESCE($13, gmail_id)
         WHERE id = $1 AND user_name = $2`,
        [
          existing.rows[0]!.id, userName,
          record.vendorName ?? null,
          record.dateStart ?? null,
          record.dateEnd ?? null,
          record.time ?? null,
          record.address ?? null,
          record.phone ?? null,
          record.website ?? null,
          record.amount ?? null,
          record.notes ?? null,
          record.rawSnippet ?? null,
          record.gmailId ?? null,
        ]
      );
      logger.info(
        { id: existing.rows[0]!.id, confirmationNumber: record.confirmationNumber },
        "[Records] Updated existing record by confirmation_number"
      );
      return "updated";
    }
  }

  // Priority 1.5: no exact confirmation-number match — for one-off-event
  // categories (trip, warranty), fall back to a fuzzy same-vendor match
  // within a recent window and merge into that rather than inserting a new
  // row. Deliberately excludes subscription/vehicle_registration: those
  // recur legitimately (a new renewal genuinely isn't "the same" booking as
  // last year's), so "same vendor again soon" must NOT auto-merge there.
  //
  // Vendor match is a bidirectional prefix check, not exact equality —
  // confirmed live as the actual cause of a real duplicate: two emails from
  // the same inspector's back-and-forth thread extracted the vendor as "NPI
  // - NE Tarrant County" in one and "NPI - NE Tarrant County (Chas
  // Dohanich)" in the other. Exact lower() equality treats those as two
  // different vendors; this catches one being a prefix of the other, which
  // is what "same business, slightly different extraction" actually looks
  // like in practice. Window widened from 7 to 14 days since these events
  // are often scheduled — and re-mentioned across a thread — further out
  // than a trip booking's hold-to-confirmation gap.
  const DEDUP_ELIGIBLE_CATEGORIES = ["trip", "warranty"];
  if (DEDUP_ELIGIBLE_CATEGORIES.includes(record.category) && record.vendorName) {
    const recent = await query<{ id: number }>(
      `SELECT id FROM user_records
       WHERE user_name = $1
         AND category = $3
         AND (lower(vendor_name) LIKE lower($2) || '%' OR lower($2) LIKE lower(vendor_name) || '%')
         AND deleted_at IS NULL
         AND created_at > NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userName, record.vendorName, record.category]
    );
    if (recent.rows.length > 0) {
      await query(
        `UPDATE user_records SET
           vendor_name         = COALESCE($3, vendor_name),
           confirmation_number = COALESCE($4, confirmation_number),
           date_start          = COALESCE($5::date, date_start),
           date_end            = COALESCE($6::date, date_end),
           time                = COALESCE($7, time),
           address             = COALESCE($8, address),
           phone               = COALESCE($9, phone),
           website             = COALESCE($10, website),
           amount              = COALESCE($11, amount),
           notes               = COALESCE($12, notes),
           raw_email_snippet   = COALESCE($13, raw_email_snippet),
           gmail_id            = COALESCE($14, gmail_id)
         WHERE id = $1 AND user_name = $2`,
        [
          recent.rows[0]!.id, userName,
          record.vendorName ?? null,
          record.confirmationNumber ?? null,
          record.dateStart ?? null,
          record.dateEnd ?? null,
          record.time ?? null,
          record.address ?? null,
          record.phone ?? null,
          record.website ?? null,
          record.amount ?? null,
          record.notes ?? null,
          record.rawSnippet ?? null,
          record.gmailId ?? null,
        ]
      );
      logger.info(
        { id: recent.rows[0]!.id, category: record.category, vendorName: record.vendorName, newConfirmationNumber: record.confirmationNumber },
        "[Records] Merged record into recent same-vendor record — no shared confirmation number (fuzzy vendor match)"
      );
      return "updated";
    }
  }

  // Fresh insert — use gmail_id conflict as safety net against duplicates.
  // RETURNING id distinguishes a genuine insert from a silent ON CONFLICT
  // DO NOTHING no-op (this exact email already processed, e.g. a restart
  // re-scanned it) — the latter must report "skipped", not "inserted".
  if (record.gmailId) {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO user_records
         (user_name, category, vendor_name, confirmation_number,
          date_start, date_end, time, address, phone, website,
          amount, notes, raw_email_snippet, gmail_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (user_name, gmail_id) WHERE gmail_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        userName, record.category, record.vendorName, record.confirmationNumber ?? null,
        record.dateStart ?? null, record.dateEnd ?? null, record.time ?? null,
        record.address ?? null, record.phone ?? null, record.website ?? null,
        record.amount ?? null, record.notes ?? null,
        record.rawSnippet ?? null, record.gmailId,
      ]
    );
    return rows.length > 0 ? "inserted" : "skipped";
  } else {
    await query(
      `INSERT INTO user_records
         (user_name, category, vendor_name, confirmation_number,
          date_start, date_end, time, address, phone, website,
          amount, notes, raw_email_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        userName, record.category, record.vendorName, record.confirmationNumber ?? null,
        record.dateStart ?? null, record.dateEnd ?? null, record.time ?? null,
        record.address ?? null, record.phone ?? null, record.website ?? null,
        record.amount ?? null, record.notes ?? null, record.rawSnippet ?? null,
      ]
    );
    return "inserted";
  }
}
