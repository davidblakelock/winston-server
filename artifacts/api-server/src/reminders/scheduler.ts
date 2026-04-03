import cron from "node-cron";
import { query } from "../db.js";
import { broadcast } from "./sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { getAppUrl } from "../auth/sessionAuth.js";
import { logger } from "../lib/logger.js";

interface ReminderRow {
  id: number;
  user_name: string;
  reminder_text: string;
  fire_at: Date;
  recurring: string | null;
  recurring_time: string | null;
  timezone: string;
}

function nextOccurrence(timeStr: string, tz: string): Date {
  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const now = new Date();

  // Use Intl.DateTimeFormat.formatToParts — reliable across all Node.js environments.
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

  // Always schedule for the NEXT occurrence (i.e., tomorrow or later today if before now)
  let candidateMs = Date.UTC(tzYear, tzMonth, tzDay, desiredH, desiredM, 0);
  if (candidateMs <= localNowMs) {
    candidateMs += 24 * 60 * 60 * 1000;
  }

  return new Date(candidateMs + offsetMs);
}

export function startScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const { rows } = await query<ReminderRow>(
        `SELECT * FROM reminders
         WHERE fire_at <= NOW()
           AND (last_fired_at IS NULL OR recurring IS NOT NULL)
           AND (last_fired_at IS NULL OR fire_at > last_fired_at)`
      );

      for (const reminder of rows) {
        const speakText = `Hey ${reminder.user_name}, your reminder: ${reminder.reminder_text}.`;

        broadcast("reminder", {
          id: reminder.id,
          userName: reminder.user_name,
          reminderText: reminder.reminder_text,
          speakText,
        });

        // Also send a push notification so David is notified even if the app is closed
        const appUrl = getAppUrl();
        const reminderUrl = `${appUrl}/?notification=reminder&text=${encodeURIComponent(reminder.reminder_text)}`;
        sendPushToAll({
          title: "⏰ Reminder — Emma Peel",
          body: reminder.reminder_text,
          tag: `reminder-${reminder.id}`,
          url: reminderUrl,
          requireInteraction: true,
        }).catch(() => {});

        logger.info({ id: reminder.id, text: reminder.reminder_text }, "Reminder fired");

        if (reminder.recurring && reminder.recurring_time) {
          const nextFire = nextOccurrence(reminder.recurring_time, reminder.timezone);
          await query(
            `UPDATE reminders SET fire_at = $1, last_fired_at = NOW() WHERE id = $2`,
            [nextFire, reminder.id]
          );
        } else {
          await query(
            `UPDATE reminders SET last_fired_at = NOW() WHERE id = $1`,
            [reminder.id]
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "Scheduler error");
    }
  });

  logger.info("Reminder scheduler started");
}
