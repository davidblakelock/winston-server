import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getOrders, updateOrderTracking } from "./ordersManager.js";
import { trackOrderDirect, isCarrierTrackerEnabled } from "./carrierTracker.js";
import { sendPushToAll } from "../push/pushManager.js";

const ORDER_PUSH_STATUSES = new Set(["out_for_delivery", "delivered", "exception"]);
const TZ = "America/Chicago";

// An order is "active" if it has a tracking number, is not delivered, and was created within 30 days
function isActive(order: Awaited<ReturnType<typeof getOrders>>[number]): boolean {
  if (!order.tracking_number) return false;
  if (order.status === "delivered") return false;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return new Date(order.created_at).getTime() > thirtyDaysAgo;
}

// ── Core polling function ─────────────────────────────────────────────────────

export async function pollActiveOrderTracking(
  userName = NATIVE_USER
): Promise<{ updated: number; skipped: number }> {
  if (!isCarrierTrackerEnabled()) {
    logger.warn("[OrderTracker] APIFY_API_KEY not set — carrier tracking unavailable");
    return { updated: 0, skipped: 0 };
  }

  const allOrders = await getOrders(userName);
  const trackable = allOrders.filter(isActive);

  if (trackable.length === 0) {
    logger.info({ userName }, "[OrderTracker] No active trackable orders");
    return { updated: 0, skipped: 0 };
  }

  logger.info({ userName, count: trackable.length }, "[OrderTracker] Polling active orders");

  let updated = 0;
  let skipped = 0;

  for (const order of trackable) {
    try {
      const result = await trackOrderDirect(order.tracking_number!, order.carrier);

      if (!result) {
        skipped++;
        continue;
      }

      const prevStatus = order.status;

      await updateOrderTracking(order.id, {
        status:        result.status,
        expected_date: result.expectedDate ?? undefined,
        tracking_events: result.events,
        carrier:       result.carrier,
        status_color:  result.statusColor,
        status_detail: result.statusDetail,
      });

      updated++;

      logger.info(
        {
          orderId:        order.id,
          retailer:       order.retailer,
          item:           order.item_name,
          prevStatus,
          newStatus:      result.status,
          statusColor:    result.statusColor,
          trackingNumber: order.tracking_number,
        },
        "[OrderTracker] Tracking updated"
      );

      // Push notification on status change
      if (prevStatus !== result.status && ORDER_PUSH_STATUSES.has(result.status)) {
        const label =
          result.status === "delivered"       ? "📦 Delivered" :
          result.status === "out_for_delivery" ? "🚚 Out for delivery" :
          result.status === "exception"        ? "⚠️ Delivery issue" :
          "Shipped";

        sendPushToAll(
          {
            title: "Package Update",
            body:  `${label}: ${order.item_name} from ${order.retailer}`,
            tag:   `order-${order.id}`,
          },
          userName
        ).catch((e) =>
          logger.warn({ e, orderId: order.id }, "[OrderTracker] Push send failed")
        );
      }
    } catch (err) {
      logger.warn({ err, orderId: order.id }, "[OrderTracker] Failed to track order");
      skipped++;
    }
  }

  logger.info({ userName, updated, skipped, total: trackable.length }, "[OrderTracker] Poll complete");
  return { updated, skipped };
}

// ── Scheduler: every 4 hours during waking hours (7 AM – 9 PM CT) ────────────

export function startOrderTrackingScheduler(): void {
  if (!isCarrierTrackerEnabled()) {
    logger.info("[OrderTracker] Scheduler skipped — APIFY_API_KEY not set");
    return;
  }

  // Fires at 7 AM, 11 AM, 3 PM, 7 PM CT
  cron.schedule("0 7,11,15,19 * * *", async () => {
    logger.info("[OrderTracker] Scheduled poll starting");
    try {
      const { updated, skipped } = await pollActiveOrderTracking(NATIVE_USER);
      logger.info({ updated, skipped }, "[OrderTracker] Scheduled poll finished");
    } catch (err) {
      logger.error({ err }, "[OrderTracker] Scheduled poll failed");
    }
  }, { timezone: TZ });

  logger.info("[OrderTracker] Scheduler started — polling every 4 hours (7 AM, 11 AM, 3 PM, 7 PM CT)");
}
