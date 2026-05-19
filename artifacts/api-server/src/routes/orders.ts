import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getOrders,
  upsertOrder,
  deleteOrder,
  getLastOrderScanAt,
  updateLastOrderScanAt,
} from "../orders/ordersManager.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
import { pollActiveOrderTracking } from "../orders/orderTrackingScheduler.js";
import { logger } from "../lib/logger.js";

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
// Body: { force?: boolean } — when true, ignores last_scan_at and looks back 90 days.
router.post("/orders/sync", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const force = req.body?.force === true;
  req.log.info({ userName, force }, "[Orders] Sync started");

  try {
    // ── Step 1: Gmail scan ──────────────────────────────────────────────────
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const existingOrders = await getOrders(userName);
    // Only treat as "has real orders" if at least one has a tracking number.
    // Orders without tracking are likely digital purchases or bad parses.
    const hasTrackedOrders = existingOrders.some((o) => !!o.tracking_number);
    // Force flag OR no tracked orders → ignore last_scan_at, look back 90 days
    const lastScan = (force || !hasTrackedOrders) ? null : await getLastOrderScanAt(userName);
    const since = lastScan ?? ninetyDaysAgo;
    if (force) req.log.info({ userName, since }, "[Orders] Force sync — using 90-day lookback");
    else if (!hasTrackedOrders) req.log.info({ userName, since }, "[Orders] No tracked orders on record — using 90-day lookback");

    const scanned = await scanOrderEmails(userName, since);
    let newCount = 0;

    for (const order of scanned) {
      const inserted = await upsertOrder(userName, order);
      if (inserted) newCount++;
    }

    await updateLastOrderScanAt(userName);
    req.log.info({ userName, scanned: scanned.length, newOrUpdated: newCount }, "[Orders] Gmail scan complete");

    // ── Step 2: Update live tracking via AfterShip (throttled — 30 min cooldown per order)
    const { updated: trackingUpdated } = await pollActiveOrderTracking(userName);
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
