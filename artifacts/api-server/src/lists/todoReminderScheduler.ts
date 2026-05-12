import cron from "node-cron";
import { query } from "../db.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";

interface TodoReminderRow {
  id: number;
  user_name: string;
  item_text: string;
  reminder_time: Date;
}

export function startTodoReminderScheduler(): void {
  cron.schedule("* * * * *", async () => {
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

        await sendPushToAll(
          {
            title: "James Bond",
            body: `Just a reminder — ${item.item_text}`,
            tag: `todo-reminder-${item.id}`,
            notificationType: "reminder",
            url: "winston://lists?tab=todo",
            requireInteraction: true,
          },
          item.user_name
        );

        logger.info(
          { id: item.id, itemText: item.item_text, user: item.user_name },
          "[TodoReminder] Fired"
        );
      }
    } catch (err) {
      logger.error({ err }, "[TodoReminder] Scheduler error");
    }
  });

  logger.info("[TodoReminder] To-do reminder scheduler started");
}
