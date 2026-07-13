import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getOrders,
  upsertOrder,
  deleteOrder,
  getLastOrderScanAt,
  updateLastOrderScanAt,
  consolidateOrders,
} from "../orders/ordersManager.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";

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
    // Use last_scan_at if we have ANY existing orders — even ones without tracking numbers.
    // Previously this checked hasTrackedOrders which caused every sync to do a full 90-day
    // re-scan (and re-insert the same emails) whenever Amazon emails lacked tracking numbers.
    const hasAnyOrders = existingOrders.length > 0;
    // Force flag OR truly first-time (no orders at all) → ignore last_scan_at, look back 90 days
    const lastScan = (force || !hasAnyOrders) ? null : await getLastOrderScanAt(userName);
    const since = lastScan ?? ninetyDaysAgo;
    if (force) req.log.info({ userName, since }, "[Orders] Force sync — using 90-day lookback");
    else if (!hasAnyOrders) req.log.info({ userName, since }, "[Orders] No orders on record — using 90-day lookback");

    const scanned = await scanOrderEmails(userName, since);
    let newCount = 0;

    for (const order of scanned) {
      const inserted = await upsertOrder(userName, order);
      if (inserted) newCount++;

      // Create EasyPost tracker if a tracking number exists and one hasn't been created yet
      if (inserted?.tracking_number && !inserted.easypost_tracker_id) {
        const { createTracker } = await import("../orders/easypostManager.js");
        const tracker = await createTracker(inserted.tracking_number, inserted.carrier ?? undefined);
        if (tracker) {
          await query(
            `UPDATE orders SET easypost_tracker_id = $1 WHERE user_name = $2 AND tracking_number = $3`,
            [tracker.trackerId, userName, inserted.tracking_number]
          ).catch((err) => logger.warn({ err }, "[Orders] Failed to store EasyPost tracker ID"));
          logger.info({ trackerId: tracker.trackerId, trackingNumber: inserted.tracking_number }, "[Orders] EasyPost tracker created");
        }
      }
    }

    await updateLastOrderScanAt(userName);
    req.log.info({ userName, scanned: scanned.length, newOrUpdated: newCount }, "[Orders] Gmail scan complete");

    // ── Step 2: Consolidate duplicates from this scan and any previous scans ─
    // Merges rows that share the same tracking_number or order_number so the
    // user never sees the same package listed more than once.
    const consolidated = await consolidateOrders(userName);
    if (consolidated > 0) {
      req.log.info({ userName, consolidated }, "[Orders] Duplicate rows removed by consolidation");
    }

    const updatedOrders = await getOrders(userName);
    res.json({
      ok: true,
      newOrders: newCount,
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
