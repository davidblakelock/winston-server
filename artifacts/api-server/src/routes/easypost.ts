import { Router, type IRouter, type Request, type Response } from "express";
import { parseWebhookEvent, isKeyTrackingStatus, getStatusLabel } from "../orders/easypostManager.js";
import { query } from "../db.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.post("/easypost/webhook", async (req: Request, res: Response) => {
  // Respond immediately — EasyPost requires 2XX within 30 seconds
  res.status(200).json({ received: true });

  try {
    const parsed = parseWebhookEvent(req.body);
    if (!parsed) {
      logger.info("[EasyPost] Webhook ignored — not a tracker.updated event");
      return;
    }

    const { trackerId, status, carrier, estDeliveryDate, trackingEvents } = parsed;

    // Find the order by easypost_tracker_id
    const { rows } = await query<{
      id: number;
      user_name: string;
      item_name: string;
      retailer: string;
      status: string;
    }>(
      `SELECT id, user_name, item_name, retailer, status
       FROM orders WHERE easypost_tracker_id = $1`,
      [trackerId]
    );

    if (!rows[0]) {
      logger.warn({ trackerId }, "[EasyPost] No order found for tracker");
      return;
    }

    const order = rows[0];

    // Update order
    await query(
      `UPDATE orders SET
        status = $1,
        carrier = $2,
        expected_date = $3,
        tracking_events = $4,
        last_tracked_at = NOW(),
        updated_at = NOW()
       WHERE id = $5`,
      [
        getStatusLabel(status),
        carrier,
        estDeliveryDate ? new Date(estDeliveryDate).toISOString().split("T")[0] : null,
        JSON.stringify(trackingEvents),
        order.id,
      ]
    );

    logger.info({ trackerId, status, orderId: order.id }, "[EasyPost] Order updated");

    // Send push notification for key status changes
    if (isKeyTrackingStatus(status) && status !== order.status) {
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

      const msg = messages[status];
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
  } catch (err) {
    logger.error({ err }, "[EasyPost] Webhook processing failed");
  }
});

export default router;
