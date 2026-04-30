import { query } from "../db.js";
import { broadcast } from "./sseStore.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

// Add for_contact column if it doesn't exist (idempotent)
query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS for_contact text DEFAULT NULL`)
  .catch(() => {});

// Add push override columns — allow specific reminder types (e.g. bill snooze) to
// fire with a custom categoryId and extra push data instead of the generic "reminder-action".
query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS push_category_id text DEFAULT NULL`)
  .catch(() => {});
query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS push_data text DEFAULT NULL`)
  .catch(() => {});

// Fix legacy user_name default from 'David' to canonical stored username
query(`ALTER TABLE reminders ALTER COLUMN user_name SET DEFAULT '${NATIVE_STORED_NAME}'`)
  .catch(() => {});

export interface ReminderInput {
  userName?: string;
  reminderText: string;
  fireAt: Date | string;
  recurring?: string | null;
  recurringTime?: string | null;
  timezone?: string;
  forContact?: string | null;
  /** Override the push notification category (default: "reminder-action"). */
  pushCategoryId?: string | null;
  /** Extra push payload fields to merge in (e.g. companionMessage with billId). Stored as JSON text. */
  pushData?: Record<string, unknown> | null;
}

export interface ReminderRow {
  id: number;
  user_name: string;
  reminder_text: string;
  fire_at: string;
  recurring: string | null;
  recurring_time: string | null;
  timezone: string;
  status: string;
  for_contact: string | null;
  last_fired_at: string | null;
  created_at: string;
  push_category_id: string | null;
  push_data: string | null;
}

/**
 * Single authoritative path for creating a reminder.
 * - Duplicate guard: if a pending row with the same user + text + fire_at already exists,
 *   returns that row without inserting (idempotent).
 * - Broadcasts reminder_sync {action:"created"} via SSE so every open panel updates
 *   immediately without a page refresh.
 */
export async function createReminder(input: ReminderInput): Promise<ReminderRow> {
  const resolvedUser = input.userName ?? NATIVE_STORED_NAME;
  const resolvedTz   = input.timezone   ?? "America/Chicago";

  // ── Duplicate guard ──────────────────────────────────────────────────────────
  // Only block genuine double-submits: same user + text + fire_at created within
  // the last 5 seconds.  A wider window (matching on fire_at alone) was dropping
  // legitimate second reminders because computeFireAt rounds seconds to 0, making
  // two "remind me in 2 min" requests set 30 s apart produce the same fire_at.
  const { rows: existing } = await query<ReminderRow>(
    `SELECT * FROM reminders
      WHERE user_name     = $1
        AND reminder_text = $2
        AND fire_at       = $3
        AND status        = 'pending'
        AND created_at    > NOW() - INTERVAL '5 seconds'
      LIMIT 1`,
    [resolvedUser, input.reminderText, input.fireAt]
  );
  if (existing.length > 0) {
    // Genuine double-submit within 5 s — return the existing row without inserting
    return existing[0];
  }

  // ── Insert ───────────────────────────────────────────────────────────────────
  const { rows } = await query<ReminderRow>(
    `INSERT INTO reminders
       (user_name, reminder_text, fire_at, recurring, recurring_time, timezone, status, for_contact, push_category_id, push_data)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
       RETURNING *`,
    [
      resolvedUser,
      input.reminderText,
      input.fireAt,
      input.recurring      ?? null,
      input.recurringTime  ?? null,
      resolvedTz,
      input.forContact     ?? null,
      input.pushCategoryId ?? null,
      input.pushData       != null ? JSON.stringify(input.pushData) : null,
    ]
  );

  const newReminder = rows[0];

  // ── Broadcast so all open panels update immediately ──────────────────────────
  broadcast("reminder_sync", { action: "created", reminder: newReminder });

  return newReminder;
}

/**
 * Mark a reminder as done (completed) from a notification action button.
 * This is a background operation — the app does not need to open.
 * For recurring reminders, the scheduler has already rescheduled the next
 * occurrence before this is called, so we only mark the current fired instance.
 * Works on any status so it's safe to call even if already completed.
 */
export async function markReminderDone(id: number): Promise<boolean> {
  const { rows } = await query(
    `UPDATE reminders SET status = 'completed' WHERE id = $1 RETURNING id`,
    [id]
  );
  if (rows.length > 0) {
    broadcast("reminder_sync", { action: "completed", id });
  }
  return rows.length > 0;
}
