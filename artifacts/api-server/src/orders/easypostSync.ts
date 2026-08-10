/**
 * Shared "apply a fresh EasyPost tracker result to our orders table" logic —
 * used by both the webhook handler (routes/easypost.ts, the primary path)
 * and the polling backstop (easypostPoller.ts, for when the webhook never
 * arrives). Keeping this in one place means both paths write status the
 * same correct way and fire the same notification rules.
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import {
  getStatusLabel,
  mapEasyPostStatus,
  isKeyTrackingStatus,
  type TrackingEvent,
} from "./easypostManager.js";
import { resolveOrderStatus, type OrderStatus } from "./ordersManager.js";

export interface FreshTrackerResult {
  status: string; // EasyPost's raw status vocabulary — mapped internally
  carrier: string;
  estDeliveryDate: string | null;
  trackingEvents: TrackingEvent[];
}

export async function applyEasyPostTrackerUpdate(
  trackerId: string,
  tracker: FreshTrackerResult
): Promise<void> {
  const { rows } = await query<{
    id: number;
    user_name: string;
    item_name: string;
    retailer: string;
    status: OrderStatus;
  }>(
    `SELECT id, user_name, item_name, retailer, status
     FROM orders WHERE easypost_tracker_id = $1`,
    [trackerId]
  );
  const order = rows[0];
  if (!order) {
    logger.warn({ trackerId }, "[EasyPost] No order found for tracker");
    return;
  }

  const resolvedStatus = resolveOrderStatus(order.status, mapEasyPostStatus(tracker.status));

  // EasyPost keeps sending tracker.updated events after delivery (extra scan
  // events, signature/weight confirmation, webhook retries). Since the update
  // below unconditionally sets updated_at = NOW(), and getOrders()'s 7-day
  // "recently delivered" visibility window is based on that same updated_at,
  // every one of those post-delivery pings was silently resetting the clock —
  // a delivered order could never age out of My Orders as long as EasyPost
  // kept pinging it. Once an order is already delivered and stays delivered
  // (resolveOrderStatus is monotonic, so this is the only way both sides can
  // read "delivered"), there's nothing user-facing left to update — skip the
  // write entirely instead of just this one column, so tracking_events/
  // last_tracked_at don't create the same false impression of new activity.
  if (order.status === "delivered" && resolvedStatus === "delivered") {
    logger.info(
      { trackerId, orderId: order.id },
      "[EasyPost] Order already delivered — skipping update to avoid resetting the 7-day visibility window"
    );
    return;
  }

  await query(
    `UPDATE orders SET
       status          = $1,
       status_detail   = $2,
       carrier         = $3,
       expected_date   = $4,
       tracking_events = $5::jsonb,
       last_tracked_at = NOW(),
       updated_at      = NOW()
     WHERE id = $6`,
    [
      resolvedStatus,
      getStatusLabel(tracker.status),
      tracker.carrier,
      tracker.estDeliveryDate ? new Date(tracker.estDeliveryDate).toISOString().split("T")[0] : null,
      JSON.stringify(tracker.trackingEvents),
      order.id,
    ]
  );

  logger.info(
    { trackerId, rawStatus: tracker.status, resolvedStatus, orderId: order.id },
    "[EasyPost] Order updated"
  );

  // Notify only on a genuine status change, for the statuses worth interrupting
  // the user for — matches the guard already in place for reservation pushes:
  // don't re-fire the same notification for information they already have.
  if (isKeyTrackingStatus(tracker.status) && resolvedStatus !== order.status) {
    const messages: Record<string, { title: string; body: string }> = {
      out_for_delivery: {
        title: "📦 Out for Delivery",
        body: `Your ${order.item_name} from ${order.retailer} is out for delivery!`,
      },
      delivered: {
        title: "✅ Delivered!",
        body: `Your ${order.item_name} from ${order.retailer} has been delivered.`,
      },
      available_for_pickup: {
        title: "📮 Ready for Pickup",
        body: `Your ${order.item_name} from ${order.retailer} is available for pickup.`,
      },
      return_to_sender: {
        title: "↩️ Returned to Sender",
        body: `Your ${order.item_name} from ${order.retailer} is being returned.`,
      },
      failure: {
        title: "⚠️ Delivery Failed",
        body: `Delivery failed for your ${order.item_name} from ${order.retailer}.`,
      },
    };

    const msg = messages[tracker.status];
    if (msg) {
      await sendFcmNotification({
        userName: order.user_name,
        notificationType: "order-tracking",
        title: msg.title,
        body: msg.body,
        data: {
          action: "navigate",
          screen: "/orders",
        },
      }).catch((err) => logger.warn({ err }, "[EasyPost] FCM push failed"));
    }
  }
}
