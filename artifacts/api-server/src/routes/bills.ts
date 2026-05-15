import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { markBillPaid, getBills, addBill, type Category, type Frequency } from "../bills/billManager.js";
import { createReminder } from "../reminders/reminderManager.js";
import { scanForBillAnomalies } from "../bills/billAnomalyScanner.js";

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
    res.json({ ok: true, dismissed: true, dismissTag: `bill-${billId}` });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/mark-paid error");
    res.status(500).json({ error: "Failed to mark bill as paid" });
  }
});

// ── POST /api/bills/paid — alias for /bills/mark-paid (native notification) ───
// Called by the native app when the user taps "Paid ✓" on a bill notification.
// Accepts billId directly in the body (no billName required — looks it up).
// Runs in the background — the app does not need to open.
router.post("/bills/paid", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const body = req.body as {
    billId?: number;
    notificationData?: { billId?: number; data?: { billId?: number } };
  };
  const rawId =
    body.billId ??
    body.notificationData?.billId ??
    body.notificationData?.data?.billId;

  if (!rawId || typeof rawId !== "number") {
    res.status(400).json({ error: "billId (number) is required" });
    return;
  }

  try {
    // Look up the bill name so we can log it meaningfully
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === rawId);
    const name = bill?.name ?? `Bill #${rawId}`;
    await markBillPaid(rawId, name, userName);
    req.log.info({ userName, billId: rawId, billName: name }, "[BILLS] Paid via /bills/paid notification action");
    res.json({ ok: true, dismissed: true, dismissTag: `bill-${rawId}` });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/paid error");
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
      pushCategoryId: "bill-action",
      pushData: { companionMessage: JSON.stringify({ billId, billName: name, amount: amount ?? "" }) },
    });

    req.log.info({ userName, billId, reminderId: reminder.id }, "[BILLS] Remind-tomorrow reminder created via notification action");
    res.json({ ok: true, reminderId: reminder.id });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/remind-tomorrow error");
    res.status(500).json({ error: "Failed to create tomorrow reminder" });
  }
});

// ── GET /api/bills — list all tracked bills for the authenticated user ─────────
router.get("/bills", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const bills = await getBills(userName);
    res.json({ bills });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/bills — create a bill directly (no chat parsing required) ───────
router.post("/bills", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { name, category, frequency, dueDay, dueMonths, amount, notes, autoPay } = req.body as {
    name: string; category: Category; frequency: Frequency;
    dueDay: number; dueMonths?: string | null; amount?: string; notes?: string; autoPay?: boolean;
  };
  if (!name || !category || !frequency || !dueDay) {
    res.status(400).json({ error: "name, category, frequency, dueDay are required" });
    return;
  }
  try {
    const result = await addBill(name, category, frequency, dueDay, dueMonths ?? null, amount, notes, userName, autoPay ?? false);
    if (result.alreadyExists) {
      res.json({ ok: true, alreadyExists: true });
    } else {
      res.json({ ok: true, bill: result.bill });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/bills/anomalies ──────────────────────────────────────────────────
// Scans Gmail for billing emails in the last 30 days, compares against stored
// history, and returns any charges that are >10% higher than the usual amount.
// Response: { anomalies: BillAnomaly[], count: number }
router.get("/bills/anomalies", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const anomalies = await scanForBillAnomalies(userName);
    req.log.info({ userName, count: anomalies.length }, "[BILLS] Anomaly scan complete");
    res.json({ anomalies, count: anomalies.length });
  } catch (err) {
    req.log.error({ err }, "[BILLS] GET /bills/anomalies error");
    res.status(500).json({ error: "Failed to scan for bill anomalies" });
  }
});

export default router;
