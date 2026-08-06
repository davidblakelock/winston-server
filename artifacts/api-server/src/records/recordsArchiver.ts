/**
 * Records Archiver — per-user soft-delete of expired user_records.
 *
 * Checks every 5 minutes, fires once per user at their own local 3am
 * (profile.timezone — same per-user local-hour pattern as billScheduler.ts
 * and datesScheduler.ts), and sets deleted_at = NOW() for any of that user's
 * records where:
 *   - deleted_at IS NULL (not already archived), AND
 *   - COALESCE(date_end, date_start) is more than 2 days in the past.
 *
 * date_end is preferred over date_start so a multi-day booking (e.g. hotel)
 * is not archived until after checkout, not after check-in.
 * Records with no date at all are never auto-archived.
 */

import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";

const TARGET_LOCAL_HOUR = 3;
// userName -> local date (in that user's own timezone) already archived
const _archivedToday = new Map<string, string>();

async function archiveOldRecordsForUser(userName: string): Promise<void> {
  try {
    const { rows } = await query<{ id: number }>(
      `UPDATE user_records
       SET deleted_at = NOW()
       WHERE user_name = $1
         AND deleted_at IS NULL
         AND COALESCE(date_end, date_start) IS NOT NULL
         AND COALESCE(date_end, date_start)::date < CURRENT_DATE - INTERVAL '2 days'
       RETURNING id`,
      [userName]
    );
    if (rows.length > 0) {
      logger.info({ userName, archived: rows.length }, "[RecordsArchiver] Expired records soft-deleted");
    }
  } catch (err) {
    logger.error({ err, userName }, "[RecordsArchiver] Failed to archive old records for user");
  }
}

async function runPerUserCheck(user: ActiveUser): Promise<void> {
  const tz = user.timezone ?? "UTC";
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
    10
  );
  if (localHour < TARGET_LOCAL_HOUR) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: tz });
  if (_archivedToday.get(user.userName) === today) return;
  _archivedToday.set(user.userName, today);

  await archiveOldRecordsForUser(user.userName);
}

export function startRecordsArchiver(): void {
  let _running = false;
  cron.schedule("*/5 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => []);
      await Promise.allSettled(users.map((user) => runPerUserCheck(user)));
    } catch (err) {
      logger.error({ err }, "[RecordsArchiver] Scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("[RecordsArchiver] Scheduler started — checks every 5 min, fires once per user at their local 3am");
}
