/**
 * Records Archiver — daily soft-delete of expired user_records.
 *
 * Runs once daily at 3am CT. Sets deleted_at = NOW() for any record where:
 *   - deleted_at IS NULL (not already archived), AND
 *   - COALESCE(date_end, date_start) is more than 7 days in the past.
 *
 * date_end is preferred over date_start so a multi-day booking (e.g. hotel)
 * is not archived until after checkout, not after check-in.
 * Records with no date at all are never auto-archived.
 */

import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";

// Archiver uses UTC — archived record dates are absolute

async function archiveOldRecords(): Promise<void> {
  try {
    const { rows } = await query<{ id: number }>(
      `UPDATE user_records
       SET deleted_at = NOW()
       WHERE deleted_at IS NULL
         AND COALESCE(date_end, date_start) IS NOT NULL
         AND COALESCE(date_end, date_start)::date < CURRENT_DATE - INTERVAL '7 days'
       RETURNING id`
    );
    logger.info({ archived: rows.length }, "[RecordsArchiver] Expired records soft-deleted");
  } catch (err) {
    logger.error({ err }, "[RecordsArchiver] Failed to archive old records");
  }
}

export function startRecordsArchiver(): void {
  cron.schedule("0 3 * * *", async () => {
    logger.info("[RecordsArchiver] Daily archive run triggered");
    await archiveOldRecords();
  });

  logger.info("[RecordsArchiver] Scheduler started — daily at 3am CT");
}
