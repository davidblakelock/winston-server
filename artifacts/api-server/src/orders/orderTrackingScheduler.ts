import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import {
  getOrders,
  updateOrderTracking,
} from "./ordersManager.js";
import { trackOrder, isAfterShipEnabled } from "./aftershipTracker.js";
import { sendPushToAll } from "../push/pushManager.js";

const ORDER_PUSH_STATUSES = new Set(["shipped", "out_for_delivery", "delivered"]);

const TZ = "America/Chicago";

// ── Throttle: skip orders tracked within the last 30 minutes ─────────────────

const THROTTLE_MS = 30 * 60 * 1000;

function needsTracking(lastTrackedAt: string | null): boolean {
  if (!lastTrackedAt) return true;
  return Date.now() - new Date(lastTrackedAt).getTime() > THROTTLE_MS;
}

// ── Core polling function ─────────────────────────────────────────────────────

export async function pollActiveOrderTracking(userName = NATIVE_USER): Promise<{ updated: number; skipped: number }> {
  if (!isAfterShipEnabled()) {
    logger.warn("[OrderTracker] AfterShip not enabled — AFTERSHIP_API_KEY not set");
    return { updated: 0, skipped: 0 };
  }

  const allOrders = await getOrders(userName);
  const trackableOrders = allOrders.filter(
    (o) =>
      o.tracking_number &&
      o.status !== "delivered" &&
      o.status !== "exception"
  );

  if (trackableOrders.length === 0) {
    logger.info({ userName }, "[OrderTracker] No active trackable orders");
    return { updated: 0, skipped: 0 };
  }

  let updated = 0;
  let skipped = 0;

  for (const order of trackableOrders) {
    if (!needsTracking(order.last_tracked_at)) {
      skipped++;
      continue;
    }

    try {
      const result = await trackOrder(
        order.tracking_number!,
        order.aftership_slug,
        order.carrier
      );

      if (!result) {
        skipped++;
        continue;
      }

      const prevStatus = order.status;

      await updateOrderTracking(order.id, {
        status: result.status,
        expected_date: result.expected_date ?? undefined,
        tracking_events: result.events,
        aftership_slug: result.aftership_slug,
        carrier: result.carrier ?? undefined,
      });

      updated++;

      logger.info(
        {
          orderId: order.id,
          retailer: order.retailer,
          item: order.item_name,
          prevStatus,
          newStatus: result.status,
          trackingNumber: order.tracking_number,
        },
        "[OrderTracker] Tracking updated"
      );

      if (prevStatus !== result.status) {
        logger.info(
          { orderId: order.id, prevStatus, newStatus: result.status },
          "[OrderTracker] Status changed"
        );
        if (ORDER_PUSH_STATUSES.has(result.status)) {
          const label =
            result.status === "delivered" ? "Delivered" :
            result.status === "out_for_delivery" ? "Out for delivery" :
            "Shipped";
          sendPushToAll(
            {
              title: "Package Update",
              body: `${label}: ${order.item_name} from ${order.retailer}`,
              tag: `order-${order.id}`,
            },
            userName
          ).catch((e) => logger.warn({ e, orderId: order.id }, "[OrderTracker] Push send failed"));
        }
      }
    } catch (err) {
      logger.warn({ err, orderId: order.id }, "[OrderTracker] Failed to track order");
      skipped++;
    }
  }

  logger.info({ userName, updated, skipped, total: trackableOrders.length }, "[OrderTracker] Poll complete");
  return { updated, skipped };
}

// ── Scheduler: every 2 hours ──────────────────────────────────────────────────

export function startOrderTrackingScheduler(): void {
  if (!isAfterShipEnabled()) {
    logger.info("[OrderTracker] Scheduler skipped — AFTERSHIP_API_KEY not set");
    return;
  }

  // Run at minute 0 of every even hour (0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22)
  cron.schedule("0 */2 * * *", async () => {
    logger.info("[OrderTracker] Scheduled poll starting");
    try {
      const { updated, skipped } = await pollActiveOrderTracking(NATIVE_USER);
      logger.info({ updated, skipped }, "[OrderTracker] Scheduled poll finished");
    } catch (err) {
      logger.error({ err }, "[OrderTracker] Scheduled poll failed");
    }
  }, { timezone: TZ });

  logger.info("[OrderTracker] Scheduler started — polling every 2 hours");
}
