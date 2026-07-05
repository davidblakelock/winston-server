/**
 * Winston Connect Birthday & Key Date Scheduler
 *
 * Runs daily at 9 AM CT. For each accepted connection, checks:
 *   - date_of_birth: if the birthday is within 7 days, push a reminder
 *   - key_dates: JSON array of { label, date } — same 7-day window
 */

import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function parseMD(dateStr: string): { month: number; day: number } | null {
  const parts = dateStr.split("-").map(Number);
  if (parts.length === 3) return { month: parts[1]!, day: parts[2]! };
  if (parts.length === 2) return { month: parts[0]!, day: parts[1]! };
  return null;
}

function daysUntilAnnual(month: number, day: number): number {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const [tY, tM, tD] = today.split("-").map(Number);

  const thisYear = new Date(Date.UTC(tY, month - 1, day, 12));
  const todayUtc = Date.UTC(tY, tM - 1, tD);
  const thisYearMs = thisYear.getTime() - todayUtc;
  if (thisYearMs >= 0) return Math.round(thisYearMs / 86400000);

  const nextYear = new Date(Date.UTC(tY + 1, month - 1, day, 12));
  return Math.round((nextYear.getTime() - todayUtc) / 86400000);
}

interface KeyDate {
  label: string;
  date: string; // "YYYY-MM-DD" or "MM-DD"
}

interface ConnectionRow {
  id: number;
  other_user_name: string;
  other_label: string | null;
  date_of_birth: string | null;
  key_dates: KeyDate[] | null;
}

let _lastCheckedDate: string | null = null;

async function checkBirthdayAlerts(): Promise<void> {
  const today = todayStr();
  if (_lastCheckedDate === today) return;
  _lastCheckedDate = today;

  const users = await getActiveUsers().catch(() => []);

  for (const { userName } of users) {
    try {
      const { rows } = await query<ConnectionRow>(
        `SELECT
           wc.id,
           CASE WHEN wc.requester_user_name = $1
             THEN wc.recipient_user_name
             ELSE wc.requester_user_name
           END AS other_user_name,
           CASE WHEN wc.requester_user_name = $1
             THEN wc.requester_label
             ELSE wc.recipient_label
           END AS other_label,
           wc.date_of_birth::text,
           wc.key_dates
         FROM winston_connections wc
         WHERE (wc.requester_user_name = $1 OR wc.recipient_user_name = $1)
           AND wc.status = 'accepted'`,
        [userName]
      );

      for (const row of rows) {
        const displayName = row.other_label ?? row.other_user_name ?? "your connection";

        // Birthday check
        if (row.date_of_birth) {
          const md = parseMD(row.date_of_birth);
          if (md) {
            const days = daysUntilAnnual(md.month, md.day);
            if (days >= 0 && days <= 7) {
              const daysLabel =
                days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
              await sendFcmNotification({
                userName,
                notificationType: "birthday-reminder",
                title: "Birthday Reminder",
                body: `A reminder — ${displayName}'s birthday is ${daysLabel}.`,
              });
              logger.info(
                { userName, connection: displayName, days },
                "[ConnectBirthday] Birthday push sent"
              );
            }
          }
        }

        // Key dates check
        const keyDates: KeyDate[] = Array.isArray(row.key_dates) ? row.key_dates : [];
        for (const kd of keyDates) {
          if (!kd.date || !kd.label) continue;
          const md = parseMD(kd.date);
          if (!md) continue;
          const days = daysUntilAnnual(md.month, md.day);
          if (days >= 0 && days <= 7) {
            const daysLabel =
              days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
            await sendFcmNotification({
              userName,
              notificationType: "key-date-reminder",
              title: "Key Date Reminder",
              body: `A reminder — ${displayName}'s ${kd.label} is ${daysLabel}.`,
            });
            logger.info(
              { userName, connection: displayName, label: kd.label, days },
              "[ConnectBirthday] Key-date push sent"
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err, userName }, "[ConnectBirthday] Error checking user");
    }
  }
}

export function startConnectBirthdayScheduler(): void {
  const startHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }),
    10
  );
  if (startHour >= 9) {
    setTimeout(() => checkBirthdayAlerts().catch(() => {}), 8000);
  }

  cron.schedule(
    "0 8 * * *",
    async () => {
      try { await checkBirthdayAlerts(); }
      catch (err) { logger.error({ err }, "[ConnectBirthday] scheduler error"); }
    },
    { timezone: TZ }
  );

  logger.info("[ConnectBirthday] Scheduler started (daily 9 AM CT)");
}
