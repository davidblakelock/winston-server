import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getOrders,
  upsertOrder,
  updateOrderTracking,
  deleteOrder,
  getLastOrderScanAt,
  updateLastOrderScanAt,
} from "../orders/ordersManager.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
import { trackOrder } from "../orders/aftershipTracker.js";
import { logger } from "../lib/logger.js";
import { sendPushToAll } from "../push/pushManager.js";

const router: IRouter = Router();

// ── GET /api/orders ───────────────────────────────────────────────────────────
// Returns all active orders + recently delivered (< 7 days), sorted by priority.
router.get("/orders", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const orders = await getOrders(userName);
    res.json({ orders });
  } catch (err) {
    req.log.error({ err }, "[Orders] GET /orders error");
    res.status(500).json({ error: "Failed to load orders" });
  }
});

// ── POST /api/orders/sync ─────────────────────────────────────────────────────
// 1. Scans Gmail for new order/shipping emails since last sync (90 days on first run).
// 2. Parses each email with Claude Haiku.
// 3. Updates live tracking status via AfterShip for all orders with tracking numbers.
router.post("/orders/sync", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  req.log.info({ userName }, "[Orders] Sync started");

  try {
    // ── Step 1: Gmail scan ──────────────────────────────────────────────────
    const lastScan = await getLastOrderScanAt(userName);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const since = lastScan ?? ninetyDaysAgo;

    const scanned = await scanOrderEmails(userName, since);
    let newCount = 0;

    for (const order of scanned) {
      const inserted = await upsertOrder(userName, order);
      if (inserted) newCount++;
    }

    await updateLastOrderScanAt(userName);
    req.log.info({ userName, scanned: scanned.length, newOrUpdated: newCount }, "[Orders] Gmail scan complete");

    // ── Step 2: Update tracking for orders with tracking numbers ────────────
    const allOrders = await getOrders(userName);
    const trackableOrders = allOrders.filter(
      (o) =>
        o.tracking_number &&
        o.status !== "delivered" &&
        o.status !== "exception"
    );

    let trackingUpdated = 0;
    for (const order of trackableOrders) {
      try {
        const result = await trackOrder(
          order.tracking_number!,
          order.aftership_slug,
          order.carrier
        );
        if (result) {
          const prevStatus = order.status;
          await updateOrderTracking(order.id, {
            status: result.status,
            expected_date: result.expected_date ?? undefined,
            tracking_events: result.events,
            aftership_slug: result.aftership_slug,
            carrier: result.carrier ?? undefined,
          });
          trackingUpdated++;

          // Push notification when status transitions to a notable state
          if (prevStatus !== result.status) {
            if (result.status === "out_for_delivery") {
              sendPushToAll(userName, {
                title: "Package Out for Delivery",
                body: `Your ${order.item_name} from ${order.retailer} is out for delivery today.`,
              }).catch((e: unknown) => logger.warn({ e }, "[Orders] Push send failed"));
            } else if (result.status === "delivered") {
              sendPushToAll(userName, {
                title: "Package Delivered",
                body: `Your ${order.item_name} from ${order.retailer} has been delivered.`,
              }).catch((e: unknown) => logger.warn({ e }, "[Orders] Push send failed"));
            }
          }
        }
      } catch (err) {
        req.log.warn({ err, orderId: order.id }, "[Orders] Tracking update failed for order");
      }
    }

    req.log.info({ userName, trackingUpdated }, "[Orders] Tracking updates complete");

    const updatedOrders = await getOrders(userName);
    res.json({
      ok: true,
      newOrders: newCount,
      trackingUpdated,
      orders: updatedOrders,
    });
  } catch (err) {
    req.log.error({ err }, "[Orders] POST /orders/sync error");
    res.status(500).json({ error: "Sync failed" });
  }
});

// ── DELETE /api/orders/:id ────────────────────────────────────────────────────
router.delete("/orders/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }

  try {
    const deleted = await deleteOrder(id, userName);
    if (!deleted) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    req.log.info({ userName, orderId: id }, "[Orders] Order deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Orders] DELETE error");
    res.status(500).json({ error: "Failed to delete order" });
  }
});

export default router;
