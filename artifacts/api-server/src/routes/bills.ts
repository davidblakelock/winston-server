import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { markBillPaid, getBills } from "../bills/billManager.js";
import { createReminder } from "../reminders/reminderManager.js";

const router: IRouter = Router();

// ── POST /api/bills/mark-paid ─────────────────────────────────────────────────
// Called by the native app when the user taps "Mark Paid ✓" on the bill
// notification action button. Logs the bill as paid and suppresses further
// reminders for this billing cycle. Runs as a background request — app stays closed.
// Body: { billId: number, billName?: string }
// Response: { ok: true }
router.post("/bills/mark-paid", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { billId, billName } = req.body as { billId?: number; billName?: string };
  if (!billId || typeof billId !== "number") {
    res.status(400).json({ error: "billId (number) is required" });
    return;
  }

  try {
    const name = billName?.trim() || `Bill #${billId}`;
    await markBillPaid(billId, name, userName);
    req.log.info({ userName, billId, billName: name }, "[BILLS] Marked paid via notification action");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/mark-paid error");
    res.status(500).json({ error: "Failed to mark bill as paid" });
  }
});

// ── POST /api/bills/remind-tomorrow ──────────────────────────────────────────
// Called by the native app when the user taps "Remind Me Tomorrow" on the bill
// notification action button. Creates a one-off reminder for 9 AM tomorrow.
// Runs as a background request — app stays closed.
// Body: { billId: number, billName?: string, amount?: string }
// Response: { ok: true, reminderId: number }
router.post("/bills/remind-tomorrow", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { billId, billName, amount } = req.body as {
    billId?: number;
    billName?: string;
    amount?: string;
  };
  if (!billId || typeof billId !== "number") {
    res.status(400).json({ error: "billId (number) is required" });
    return;
  }

  try {
    const name = billName?.trim() || `Bill #${billId}`;
    const amtPart = amount ? ` of ${amount}` : "";

    // Schedule for 9 AM tomorrow (Central Time)
    const now = new Date();
    const tomorrowCT = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    tomorrowCT.setDate(tomorrowCT.getDate() + 1);
    tomorrowCT.setHours(9, 0, 0, 0);
    // Convert back to UTC-aware Date by building ISO string with offset
    const fireAt = new Date(
      tomorrowCT.toLocaleString("en-US", { timeZone: "UTC" })
    );

    const reminder = await createReminder({
      userName,
      reminderText: `Your ${name}${amtPart} payment — have you paid it yet?`,
      fireAt,
      timezone: "America/Chicago",
    });

    req.log.info({ userName, billId, reminderId: reminder.id }, "[BILLS] Remind-tomorrow reminder created via notification action");
    res.json({ ok: true, reminderId: reminder.id });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/remind-tomorrow error");
    res.status(500).json({ error: "Failed to create tomorrow reminder" });
  }
});

export default router;
