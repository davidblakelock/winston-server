import cron from "node-cron";
import { query } from "../db.js";
import { broadcastToUser } from "./sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { getAppUrl } from "../auth/sessionAuth.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";

interface ReminderRow {
  id: number;
  user_name: string;
  reminder_text: string;
  fire_at: Date;
  recurring: string | null;
  recurring_time: string | null;
  timezone: string;
  status: string;
}

function nextOccurrence(timeStr: string, tz: string): Date {
  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const now = new Date();

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const tzYear  = parseInt(p.year,   10);
  const tzMonth = parseInt(p.month,  10) - 1;
  const tzDay   = parseInt(p.day,    10);
  const tzHour  = parseInt(p.hour,   10);
  const tzMin   = parseInt(p.minute, 10);

  const localNowMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, 0);
  const offsetMs   = now.getTime() - localNowMs;

  let candidateMs = Date.UTC(tzYear, tzMonth, tzDay, desiredH, desiredM, 0);
  if (candidateMs <= localNowMs) {
    candidateMs += 24 * 60 * 60 * 1000;
  }

  return new Date(candidateMs + offsetMs);
}

export function startScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      // Select only 'pending' reminders whose fire_at has passed.
      // Using status = 'pending' (not last_fired_at) is the definitive guard against
      // double-firing — the status is updated to 'fired' atomically before the push
      // is sent, so even if the scheduler runs twice in close succession the second
      // run will never select the same reminder.
      const { rows } = await query<ReminderRow>(
        `SELECT * FROM reminders
         WHERE status = 'pending'
           AND fire_at <= NOW()`
      );

      for (const reminder of rows) {
        // ── 1. Mark as 'fired' IMMEDIATELY — prevents any race-condition double-fire ──
        const updated = await query(
          `UPDATE reminders
              SET status = 'fired', last_fired_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [reminder.id]
        );

        // If nothing was updated another scheduler beat us to it — skip
        if (!updated.rows.length) continue;

        const speakText = `Hey ${reminder.user_name}, your reminder: ${reminder.reminder_text}.`;

        // ── 2. Broadcast via SSE to EVERY connected device for this user ──
        // broadcastToUser loops all SSE connections mapped to this user so all
        // open browser tabs / devices receive the event simultaneously.
        console.log("SCHEDULER: firing reminder id", reminder.id, "text:", reminder.reminder_text);
        broadcastToUser(reminder.user_name, "reminder", {
          id: reminder.id,
          userName: reminder.user_name,
          reminderText: reminder.reminder_text,
          speakText,
        });

        // Also sync all panels to remove this reminder immediately
        broadcastToUser(reminder.user_name, "reminder_sync", { action: "fired", id: reminder.id });

        // ── 3. Send push notification to all registered devices ──
        // Look up companion_name dynamically so the notification always uses the current name
        const profile = await getProfile(reminder.user_name).catch(() => null);
        const companionName = profile?.companionName ?? "Your Companion";

        const appUrl = getAppUrl();
        const reminderUrl = `${appUrl}/?notification=reminder&text=${encodeURIComponent(reminder.reminder_text)}`;
        await sendPushToAll({
          title: `⏰ Reminder — ${companionName}`,
          body: reminder.reminder_text,
          tag: `reminder-${reminder.id}`,
          url: reminderUrl,
          reminderId: reminder.id,
          companion_name: companionName,
          requireInteraction: true,
        });

        logger.info({ id: reminder.id, text: reminder.reminder_text }, "Reminder fired");

        // ── 4. For recurring reminders: schedule next occurrence and reset to 'pending' ──
        if (reminder.recurring && reminder.recurring_time) {
          const nextFire = nextOccurrence(reminder.recurring_time, reminder.timezone);
          const { rows: updated } = await query<ReminderRow>(
            `UPDATE reminders
                SET fire_at = $1, status = 'pending', last_fired_at = NOW()
              WHERE id = $2
            RETURNING *`,
            [nextFire, reminder.id]
          );
          // Tell all open panels about the rescheduled occurrence immediately
          if (updated[0]) {
            broadcast("reminder_sync", { action: "created", reminder: updated[0] });
          }
        }
        // One-time reminders stay as 'fired' — they won't be selected again
      }
    } catch (err) {
      logger.error({ err }, "Scheduler error");
    }
  });

  logger.info("Reminder scheduler started");
}
