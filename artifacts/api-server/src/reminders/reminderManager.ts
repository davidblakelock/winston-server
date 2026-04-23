import { query } from "../db.js";
import { broadcast } from "./sseStore.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface ReminderInput {
  userName?: string;
  reminderText: string;
  fireAt: Date | string;
  recurring?: string | null;
  recurringTime?: string | null;
  timezone?: string;
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
  last_fired_at: string | null;
  created_at: string;
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
       (user_name, reminder_text, fire_at, recurring, recurring_time, timezone, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
    [
      resolvedUser,
      input.reminderText,
      input.fireAt,
      input.recurring    ?? null,
      input.recurringTime ?? null,
      resolvedTz,
    ]
  );

  const newReminder = rows[0];

  // ── Broadcast so all open panels update immediately ──────────────────────────
  broadcast("reminder_sync", { action: "created", reminder: newReminder });

  return newReminder;
}
