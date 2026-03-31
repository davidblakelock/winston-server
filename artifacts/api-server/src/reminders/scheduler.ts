import cron from "node-cron";
import { query } from "../db.js";
import { broadcast } from "./sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
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
  const now = new Date();
  const [hours, minutes] = timeStr.split(":").map(Number);

  const candidate = new Date(
    now.toLocaleString("en-US", { timeZone: tz })
  );
  candidate.setHours(hours, minutes, 0, 0);

  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  if (candidate <= nowLocal) {
    candidate.setDate(candidate.getDate() + 1);
  }

  const offsetMs = now.getTime() - nowLocal.getTime();
  return new Date(candidate.getTime() + offsetMs);
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
        sendPushToAll({
          title: "⏰ Reminder — Emma Peel",
          body: reminder.reminder_text,
          tag: `reminder-${reminder.id}`,
          url: "/",
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
