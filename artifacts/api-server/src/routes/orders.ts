import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getOrders,
  deleteOrder,
  consolidateOrders,
} from "../orders/ordersManager.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
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
// Scans currently-unread inbox mail for order/shipping emails (see
// buildGmailQuery in gmailOrderScanner.ts), parses each with Claude Haiku,
// then consolidates any duplicate rows. No lookback window or watermark —
// every sync just processes whatever's unread right now.
router.post("/orders/sync", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  req.log.info({ userName }, "[Orders] Sync started");

  try {
    // ── Step 1: Gmail scan ──────────────────────────────────────────────────
    // scanOrderEmails handles insertion + EasyPost tracker creation internally
    // and returns both the new-row count and how many candidates the Gmail
    // query itself found.
    const { newCount, candidatesFound } = await scanOrderEmails(userName);
    req.log.info({ userName, newOrUpdated: newCount, candidatesFound }, "[Orders] Gmail scan complete");

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
