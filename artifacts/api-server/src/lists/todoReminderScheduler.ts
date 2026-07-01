import cron from "node-cron";
import { query } from "../db.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";

interface TodoReminderRow {
  id: number;
  user_name: string;
  item_text: string;
  reminder_time: Date;
}

export function startTodoReminderScheduler(): void {
  let _running = false;
  cron.schedule("50 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const { rows } = await query<TodoReminderRow>(
        `SELECT id, user_name, item_text, reminder_time
           FROM list_items
          WHERE list_name      = 'to do'
            AND reminder_time  IS NOT NULL
            AND reminder_time  <= NOW()
            AND reminder_fired = FALSE`
      );

      for (const item of rows) {
        // Atomically mark fired — prevents double-fire if scheduler overlaps
        const locked = await query(
          `UPDATE list_items
              SET reminder_fired = TRUE
            WHERE id             = $1
              AND reminder_fired = FALSE
            RETURNING id`,
          [item.id]
        );
        if (!locked.rows.length) continue;

        sendFcmNotification({
          userName: item.user_name,
          notificationType: "reminder",
          title: "Reminder",
          body: `Just a reminder — ${item.item_text}`,
          data: { screen: "/lists?list=to+do", action: "navigate" },
        }).catch((err: unknown) => {
          logger.error({ err, id: item.id }, "[TodoReminder] FCM push delivery failed");
        });

        // Timezone note: reminder_time is stored as TIMESTAMPTZ (UTC).
        // computeFireAt() in chat.ts uses Intl.DateTimeFormat to convert
        // the user's local time (America/Chicago) to UTC before storing.
        // The comparison `reminder_time <= NOW()` is therefore always in UTC
        // on both sides — timezone handling is correct.
        logger.info(
          {
            id: item.id,
            itemText: item.item_text,
            user: item.user_name,
            reminderTimeUTC: new Date(item.reminder_time).toISOString(),
            reminderTimeChicago: new Date(item.reminder_time).toLocaleString("en-US", {
              timeZone: "America/Chicago",
              dateStyle: "short",
              timeStyle: "short",
            }),
            firedAtUTC: new Date().toISOString(),
          },
          "[TodoReminder] Fired"
        );
      }
    } catch (err) {
      logger.error({ err }, "[TodoReminder] Scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("[TodoReminder] To-do reminder scheduler started");
}
