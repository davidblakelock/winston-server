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
  const resolvedTz   = input.timezone   ?? "UTC";

  // ── Duplicate guard ──────────────────────────────────────────────────────────
  // Widened from 5s to 2 minutes — confirmed live the narrow window let a real
  // duplicate through: same text, same explicit fire_at, two separate
  // chat-native requests 22 seconds apart (each got its own distinct reply
  // from Claude, so this wasn't one request retried in transit — genuinely
  // two turns, whether from the user repeating themselves or the client
  // double-sending). Both created their own pending reminder and both fired.
  //
  // The original 5s window existed to avoid a DIFFERENT problem: a RELATIVE
  // request ("remind me in 2 min") re-evaluates "now + 2min" at whatever
  // moment it's actually said, and computeFireAt rounds seconds to 0 — so two
  // separate "in 2 min" requests a bit apart could coincidentally land on the
  // identical fire_at and get wrongly collapsed into one. That risk is
  // specific to relative phrasing; it doesn't apply to an ABSOLUTE time like
  // "at 3:00 PM", which computes to the identical fire_at deterministically
  // regardless of when it's said — there's no coincidence to worry about,
  // just a real repeat. A 2-minute window comfortably catches the kind of
  // gap observed here (and a plausible "wasn't sure it took, said it again")
  // while keeping the residual risk for the relative-time case low — and
  // even in that edge case, the outcome is just "one reminder instead of two
  // at the exact same moment," not a lost reminder.
  const { rows: existing } = await query<ReminderRow>(
    `SELECT * FROM reminders
      WHERE user_name     = $1
        AND reminder_text = $2
        AND fire_at       = $3
        AND status        = 'pending'
        AND created_at    > NOW() - INTERVAL '2 minutes'
      LIMIT 1`,
    [resolvedUser, input.reminderText, input.fireAt]
  );
  if (existing.length > 0) {
    // Genuine double-submit within the window — return the existing row without inserting
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
