/**
 * Contact Birthday & Anniversary Scheduler
 *
 * Runs daily at 9 AM. For each active user, checks google_contacts for
 * birthdays and anniversaries occurring within the next 7 days and sends a
 * push notification. Deduplicates by contact+year so it fires only once per
 * event per year.
 */

import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";

interface ContactDateRow {
  display_name: string;
  birthday: string | null;
  anniversary: string | null;
}

function daysUntilNextOccurrence(mmdd: string, tz = "UTC"): number {
  const [mm, dd] = mmdd.split("-").map(Number);
  if (!mm || !dd) return 9999;

  const now = new Date();
  const todayLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));

  const thisYear = new Date(todayLocal.getFullYear(), mm - 1, dd);
  const candidate =
    thisYear.getTime() >= todayLocal.setHours(0, 0, 0, 0)
      ? thisYear
      : new Date(todayLocal.getFullYear() + 1, mm - 1, dd);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((candidate.getTime() - today.getTime()) / 86_400_000);
}

async function checkContactBirthdays(): Promise<void> {
  const users = await getActiveUsers().catch(() => []);
  const currentYear = new Date().getFullYear();

  for (const { userName } of users) {
    try {
      const { rows: profRows } = await query<{ timezone: string | null }>(
        `SELECT timezone FROM user_profiles WHERE user_name = $1`,
        [userName]
      ).catch(() => ({ rows: [] }));
      const userTz = profRows[0]?.timezone ?? "UTC";
      const today = new Date().toLocaleDateString("en-CA", { timeZone: userTz });

      const { rows } = await query<ContactDateRow>(
        `SELECT display_name, birthday, anniversary
         FROM google_contacts
         WHERE user_name = $1
           AND (birthday IS NOT NULL OR anniversary IS NOT NULL)`,
        [userName]
      );

      for (const row of rows) {
        for (const [field, label] of [["birthday", "birthday"], ["anniversary", "anniversary"]] as const) {
          const val = row[field as keyof ContactDateRow];
          if (!val) continue;

          const mmdd = val.slice(5, 10); // MM-DD from YYYY-MM-DD or --MM-DD
          const days = daysUntilNextOccurrence(mmdd, userTz);
          if (days < 0 || days > 7) continue;

          const dedupKey = `${userName}:${row.display_name}:${field}:${currentYear}`;
          const { rows: existing } = await query<{ id: number }>(
            `SELECT id FROM contact_birthday_log WHERE dedup_key = $1 LIMIT 1`,
            [dedupKey]
          ).catch(() => ({ rows: [] }));
          if (existing.length > 0) continue;

          const daysLabel = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
          await sendFcmNotification({
            userName,
            notificationType: "birthday-reminder",
            title: `${label === "birthday" ? "🎂" : "💍"} ${row.display_name}`,
            body: `${row.display_name}'s ${label} is ${daysLabel}.`,
          });

          await query(
            `INSERT INTO contact_birthday_log (dedup_key, sent_date) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING dedup_key`,
            [dedupKey, today]
          ).catch(() => {});

          logger.info({ userName, name: row.display_name, label, days }, "[ContactBirthday] Push sent");
        }
      }
    } catch (err) {
      logger.warn({ err, userName }, "[ContactBirthday] Error checking user");
    }
  }
}

export function startContactBirthdayScheduler(): void {
  const startHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", hour12: false }),
    10
  );
  if (startHour >= 9) {
    setTimeout(() => checkContactBirthdays().catch(() => {}), 8000);
  }

  cron.schedule(
    "0 9 * * *",
    async () => {
      try { await checkContactBirthdays(); }
      catch (err) { logger.error({ err }, "[ContactBirthday] scheduler error"); }
    }
  );

  logger.info("[ContactBirthday] Scheduler started (daily 9 AM UTC)");
}