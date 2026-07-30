/**
 * EasyPost polling backstop — the webhook (routes/easypost.ts) is the
 * primary path, but there's no way to know from inside this app whether
 * EasyPost's account-level webhook URL is correctly configured, reachable,
 * or a given delivery attempt succeeded. Without this, a missed webhook
 * leaves an order frozen indefinitely with nothing to notice or recover.
 *
 * No per-user scoping needed — EasyPost auth is a single account-wide API
 * key, not per-user OAuth, and orders.user_name is already on each row, so
 * one global query across all users covers everything in a single pass.
 */

import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { getTracker } from "./easypostManager.js";
import { applyEasyPostTrackerUpdate } from "./easypostSync.js";

// Only bother re-checking a tracker after this long since its last update —
// the webhook is expected to keep things fresh in the normal case.
const STALE_HOURS = 4;

async function pollStaleTrackers(): Promise<void> {
  const { rows } = await query<{ easypost_tracker_id: string }>(
    `SELECT easypost_tracker_id FROM orders
     WHERE easypost_tracker_id IS NOT NULL
       AND status != 'delivered'
       AND (last_tracked_at IS NULL OR last_tracked_at < NOW() - INTERVAL '${STALE_HOURS} hours')`
  );
  if (rows.length === 0) return;

  logger.info({ count: rows.length }, "[EasyPostPoller] Refreshing stale trackers");

  for (const { easypost_tracker_id: trackerId } of rows) {
    try {
      const tracker = await getTracker(trackerId);
      if (!tracker) continue;
      await applyEasyPostTrackerUpdate(trackerId, {
        status: tracker.status,
        carrier: tracker.carrier,
        estDeliveryDate: tracker.estDeliveryDate,
        trackingEvents: tracker.trackingEvents,
      });
    } catch (err) {
      logger.warn({ err, trackerId }, "[EasyPostPoller] Failed to refresh tracker");
    }
  }
}

export function startEasyPostPoller(): void {
  let _running = false;
  cron.schedule(`0 */${STALE_HOURS} * * *`, async () => {
    if (_running) return;
    _running = true;
    try {
      await pollStaleTrackers();
    } catch (err) {
      logger.error({ err }, "[EasyPostPoller] Scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info(`[EasyPostPoller] Scheduler started — checks every ${STALE_HOURS}h for trackers stale beyond that window`);
}
