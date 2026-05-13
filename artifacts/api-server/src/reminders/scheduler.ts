import cron from "node-cron";
import { query } from "../db.js";
import { broadcast, broadcastToUser } from "./sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";
import { nextOccurrenceForPattern } from "./recurringUtils.js";

interface ReminderRow {
  id: number;
  user_name: string;
  reminder_text: string;
  fire_at: Date;
  recurring: string | null;
  recurring_time: string | null;
  timezone: string;
  status: string;
  for_contact: string | null;
  push_category_id: string | null;
  push_data: string | null;
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
        // ── 1. Mark as 'completed' IMMEDIATELY — prevents any race-condition double-fire ──
        // Using 'completed' directly means the row is already in its final state once the
        // push/SSE is sent — no second round-trip from the frontend is needed.
        // The WHERE status = 'pending' guard is the atomic lock against double-fire.
        const updated = await query(
          `UPDATE reminders
              SET status = 'completed', last_fired_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [reminder.id]
        );

        // If nothing was updated another scheduler beat us to it — skip
        if (!updated.rows.length) continue;

        const speakText = `Hey ${reminder.user_name}, your reminder: ${reminder.reminder_text}.`;

        // ── 2. Broadcast via SSE to EVERY connected device for this user ──
        console.log("SCHEDULER: firing reminder id", reminder.id, "text:", reminder.reminder_text);
        broadcastToUser(reminder.user_name, "reminder", {
          id: reminder.id,
          userName: reminder.user_name,
          reminderText: reminder.reminder_text,
          speakText,
        });
        broadcastToUser(reminder.user_name, "reminder_sync", { action: "fired", id: reminder.id });

        // ── 3. Look up companion name (used in both paths below) ──────────
        const profile = await getProfile(reminder.user_name).catch(() => null);
        const companionName = profile?.companionName ?? "your companion";

        // ── 4a. Contact push — if this reminder is FOR a contact with Winston ──
        // Look up contact_push_links: finds the linked Winston user for the named contact.
        // Uses case-insensitive prefix match so "Sarah" matches "sarah" or "Sarah Blakelock".
        if (reminder.for_contact) {
          try {
            const { rows: links } = await query<{ linked_user_name: string; contact_name: string }>(
              `SELECT linked_user_name, contact_name
               FROM contact_push_links
               WHERE owner_user_name = $1
                 AND LOWER(contact_name) LIKE LOWER($2 || '%')
               LIMIT 1`,
              [reminder.user_name, reminder.for_contact]
            );

            if (links.length > 0) {
              const link = links[0];
              const contactBody = `${reminder.user_name} wanted to remind you — ${reminder.reminder_text}`;
              logger.info(
                { contactName: link.contact_name, linkedUser: link.linked_user_name },
                "[Scheduler] Sending contact reminder push"
              );
              await sendPushToAll(
                {
                  title: `${companionName}`,
                  body: contactBody,
                  tag: `contact-reminder-${reminder.id}`,
                  reminderId: reminder.id,
                  notificationType: "contact-reminder",
                  requireInteraction: true,
                },
                link.linked_user_name
              );
              logger.info(
                { id: reminder.id, forContact: reminder.for_contact, linkedUser: link.linked_user_name },
                "[Scheduler] Contact reminder sent"
              );
            } else {
              logger.info(
                { id: reminder.id, forContact: reminder.for_contact },
                "[Scheduler] No push link found for contact — skipping contact push"
              );
            }
          } catch (contactErr) {
            logger.warn({ contactErr }, "[Scheduler] Contact push lookup failed");
          }
        }

        // ── 4b. Always send the reminder push to the reminder owner ──────
        // NOTE: no URL included — the native app handles taps via notificationType.
        // If the reminder has a push_category_id (e.g. "bill-action" for bill snoozes),
        // use that instead of the default "reminder-action". Extra push fields from
        // push_data (e.g. companionMessage with billId) are merged in.
        const extraPushData: Record<string, unknown> = reminder.push_data
          ? (() => { try { return JSON.parse(reminder.push_data) as Record<string, unknown>; } catch { return {}; } })()
          : {};
        await sendPushToAll({
          title: reminder.for_contact
            ? `✅ Reminder sent to ${reminder.for_contact} — ${companionName}`
            : reminder.push_category_id === "bill-action"
              ? `Bill Due Soon`
              : `⏰ Reminder — ${companionName}`,
          body: reminder.reminder_text,
          tag: reminder.push_category_id === "bill-action"
            ? (() => {
                try {
                  const d = reminder.push_data ? JSON.parse(reminder.push_data) as Record<string, unknown> : {};
                  const cm = d.companionMessage ? JSON.parse(d.companionMessage as string) as Record<string, unknown> : {};
                  return cm.billId ? `bill-${cm.billId}` : `reminder-${reminder.id}`;
                } catch { return `reminder-${reminder.id}`; }
              })()
            : `reminder-${reminder.id}`,
          reminderId: reminder.id,
          notificationType: reminder.push_category_id === "bill-action" ? "bill-reminder" : "reminder",
          categoryId: reminder.push_category_id ?? "reminder-action",
          requireInteraction: !reminder.for_contact,
          ...extraPushData,
        }, reminder.user_name);

        logger.info({ id: reminder.id, text: reminder.reminder_text, forContact: reminder.for_contact ?? "self" }, "Reminder fired");

        // ── 5. Recurring reminders: schedule next occurrence and reset to 'pending' ──
        if (reminder.recurring && reminder.recurring_time) {
          const nextFire = nextOccurrenceForPattern(
            reminder.recurring,
            reminder.recurring_time,
            reminder.timezone || "America/Chicago",
            new Date() // compute from now so we always get the truly next occurrence
          );

          const { rows: rescheduleRows } = await query<ReminderRow>(
            `UPDATE reminders
                SET fire_at = $1, status = 'pending', last_fired_at = NOW()
              WHERE id = $2
            RETURNING *`,
            [nextFire, reminder.id]
          );
          // Tell all open panels about the rescheduled occurrence immediately
          if (rescheduleRows[0]) {
            broadcast("reminder_sync", { action: "created", reminder: rescheduleRows[0] });
          }
          logger.info(
            { id: reminder.id, pattern: reminder.recurring, nextFire },
            "[Scheduler] Recurring reminder rescheduled"
          );
        }
        // One-time reminders stay as 'completed' — they won't be selected again
      }
    } catch (err) {
      logger.error({ err }, "Scheduler error");
    }
  });

  logger.info("Reminder scheduler started");
}
