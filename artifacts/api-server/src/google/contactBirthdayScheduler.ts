/**
 * Contact Birthday & Anniversary Scheduler
 *
 * Runs daily at 9 AM CT. For each active user, checks google_contacts for
 * birthdays and anniversaries occurring within the next 7 days and sends a
 * push notification. Deduplicates by contact+year so it fires only once per
 * event per year.
 */

import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { sendPushToAll } from "../push/pushManager.js";

const TZ = "America/Chicago";

interface ContactDateRow {
  display_name: string;
  birthday: string | null;
  anniversary: string | null;
}

function daysUntilNextOccurrence(mmdd: string): number {
  const [mm, dd] = mmdd.split("-").map(Number);
  if (!mm || !dd) return 9999;

  const now = new Date();
  const todayCT = new Date(
    now.toLocaleString("en-US", { timeZone: TZ })
  );

  const thisYear = new Date(todayCT.getFullYear(), mm - 1, dd);
  const candidate =
    thisYear.getTime() >= todayCT.setHours(0, 0, 0, 0)
      ? thisYear
      : new Date(todayCT.getFullYear() + 1, mm - 1, dd);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((candidate.getTime() - today.getTime()) / 86_400_000);
}

async function checkContactBirthdays(): Promise<void> {
  const users = await getActiveUsers().catch(() => []);
  const currentYear = new Date().getFullYear();

  for (const { userName } of users) {
    try {
      const { rows } = await query<ContactDateRow>(
        `SELECT display_name, birthday, anniversary
           FROM google_contacts
          WHERE user_name = $1
            AND (birthday IS NOT NULL OR anniversary IS NOT NULL)`,
        [userName]
      );

      for (const row of rows) {
        const events: Array<{ field: "birthday" | "anniversary"; mmdd: string }> = [];
        if (row.birthday)     events.push({ field: "birthday",    mmdd: row.birthday });
        if (row.anniversary)  events.push({ field: "anniversary", mmdd: row.anniversary });

        for (const { field, mmdd } of events) {
          const days = daysUntilNextOccurrence(mmdd);
          if (days < 0 || days > 7) continue;

          // Dedup tag — one push per contact per field per year
          const tag = `contact-${field}-${userName}-${row.display_name.replace(/\s+/g, "_")}-${currentYear}`;

          // Check if we already sent this year
          const { rows: logged } = await query<{ count: string }>(
            `SELECT COUNT(*) as count
               FROM proactive_message_log
              WHERE user_name = $1
                AND message_type = $2
                AND sent_at >= NOW() - INTERVAL '300 days'`,
            [userName, tag]
          ).catch(() => ({ rows: [{ count: "0" }] }));
          if (parseInt(logged[0]?.count ?? "0", 10) > 0) continue;

          const daysLabel =
            days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
          const eventLabel = field === "birthday" ? "birthday" : "anniversary";
          const body =
            `A reminder — ${row.display_name}'s ${eventLabel} is ${daysLabel}.`;

          await sendPushToAll(
            {
              title: field === "birthday" ? "🎂 Birthday Reminder" : "💍 Anniversary Reminder",
              body,
              tag,
              notificationType: "contact-date-reminder",
              requireInteraction: false,
            },
            userName
          );

          // Log to dedup
          await query(
            `INSERT INTO proactive_message_log (user_name, message_type, sent_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [userName, tag]
          ).catch(() => {});

          logger.info(
            { userName, name: row.display_name, field, days },
            "[ContactBirthday] Push sent"
          );
        }
      }
    } catch (err) {
      logger.warn({ err, userName }, "[ContactBirthday] Error checking user");
    }
  }
}

let _lastCheckedDate: string | null = null;

export function startContactBirthdayScheduler(): void {
  // Run at startup if it's already past 9 AM CT (and not already run today)
  const nowHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }),
    10
  );
  if (nowHour >= 9) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    if (_lastCheckedDate !== today) {
      _lastCheckedDate = today;
      setTimeout(() => checkContactBirthdays().catch(() => {}), 8000);
    }
  }

  cron.schedule(
    "0 9 * * *",
    async () => {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      _lastCheckedDate = today;
      try { await checkContactBirthdays(); }
      catch (err) { logger.error({ err }, "[ContactBirthday] Scheduler error"); }
    },
    { timezone: TZ }
  );

  logger.info("[ContactBirthday] Scheduler started (daily 9 AM CT)");
}

/**
 * Look up upcoming birthdays/anniversaries for a user — used by other modules.
 */
export async function getContactsWithUpcomingDates(
  userName: string,
  daysAhead = 7
): Promise<Array<{ name: string; field: "birthday" | "anniversary"; mmdd: string; daysUntil: number }>> {
  const { rows } = await query<ContactDateRow>(
    `SELECT display_name, birthday, anniversary
       FROM google_contacts
      WHERE user_name = $1
        AND (birthday IS NOT NULL OR anniversary IS NOT NULL)`,
    [userName]
  );

  const result: Array<{ name: string; field: "birthday" | "anniversary"; mmdd: string; daysUntil: number }> = [];
  for (const row of rows) {
    for (const [field, val] of [["birthday", row.birthday], ["anniversary", row.anniversary]] as const) {
      if (!val) continue;
      const days = daysUntilNextOccurrence(val);
      if (days >= 0 && days <= daysAhead) {
        result.push({ name: row.display_name, field, mmdd: val, daysUntil: days });
      }
    }
  }
  return result.sort((a, b) => a.daysUntil - b.daysUntil);
}
