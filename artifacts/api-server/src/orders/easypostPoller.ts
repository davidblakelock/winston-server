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
import { createTracker, getTracker } from "./easypostManager.js";
import { applyEasyPostTrackerUpdate } from "./easypostSync.js";

// Only bother re-checking a tracker after this long since its last update —
// the webhook is expected to keep things fresh in the normal case.
const STALE_HOURS = 4;

// Backfill for orders that have a real tracking number but no EasyPost
// tracker — confirmed live: createTracker() can fail at order-creation time
// (gmailOrderScanner.ts's handleOrderResult falls back to a hardcoded
// "pre_transit" status when it does) and nothing ever retried it. Since
// pollStaleTrackers below only looks at rows that already HAVE a tracker id,
// an order in this state was previously frozen on "pre_transit" forever —
// no webhook possible (nothing to subscribe), no poll possible (filtered
// out by the WHERE clause). This closes that gap by attempting tracker
// creation again on the same poll cadence.
async function backfillMissingTrackers(): Promise<void> {
  const { rows } = await query<{ id: number; tracking_number: string; carrier: string | null }>(
    `SELECT id, tracking_number, carrier FROM orders
     WHERE tracking_number IS NOT NULL
       AND easypost_tracker_id IS NULL
       AND status != 'delivered'`
  );
  if (rows.length === 0) return;

  logger.info({ count: rows.length }, "[EasyPostPoller] Backfilling orders with no tracker");

  for (const order of rows) {
    try {
      const tracker = await createTracker(order.tracking_number, order.carrier ?? undefined);
      if (!tracker) {
        logger.warn({ orderId: order.id }, "[EasyPostPoller] Backfill tracker creation still failing — will retry next poll");
        continue;
      }
      await query(`UPDATE orders SET easypost_tracker_id = $1 WHERE id = $2`, [tracker.trackerId, order.id]);
      await applyEasyPostTrackerUpdate(tracker.trackerId, {
        status:          tracker.status,
        carrier:         tracker.carrier,
        estDeliveryDate: tracker.estDeliveryDate,
        trackingEvents:  tracker.trackingEvents,
      });
      logger.info({ orderId: order.id, trackerId: tracker.trackerId }, "[EasyPostPoller] Backfill succeeded");
    } catch (err) {
      logger.warn({ err, orderId: order.id }, "[EasyPostPoller] Backfill failed for order");
    }
  }
}

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
      await backfillMissingTrackers();
      await pollStaleTrackers();
    } catch (err) {
      logger.error({ err }, "[EasyPostPoller] Scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info(`[EasyPostPoller] Scheduler started — checks every ${STALE_HOURS}h for trackers stale beyond that window`);
}
