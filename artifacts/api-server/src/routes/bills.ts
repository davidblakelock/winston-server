import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { markBillPaid, getBills, addBill, computeNextDueDate, computeCycleStartDate, type Category, type Frequency } from "../bills/billManager.js";

import { createReminder } from "../reminders/reminderManager.js";
import { scanForBillAnomalies } from "../bills/billAnomalyScanner.js";

const router: IRouter = Router();

// ── Timezone helper ───────────────────────────────────────────────────────────
// Returns a UTC Date that represents `hourCT:00:00` in America/Chicago on `dateStr`.
// Works correctly for both CDT (UTC-5) and CST (UTC-6) by probing the actual
// Intl offset rather than hardcoding it — immune to DST transitions.
function fireAtCT(dateStr: string, hourCT: number): Date {
  // Start with a naive UTC guess (treat CT time as UTC).
  const approxUtc = new Date(`${dateStr}T${String(hourCT).padStart(2, "0")}:00:00.000Z`);
  // Ask Intl what CT hour that UTC moment corresponds to.
  const ctHour = parseInt(
    approxUtc.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }),
    10
  );
  // Shift by the difference to land on the correct UTC equivalent.
  return new Date(approxUtc.getTime() + (hourCT - ctHour) * 3_600_000);
}

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

  // Coerce string → number (notification action data often stringifies numbers)
  const billId = typeof rawId === "string" ? parseInt(rawId, 10) : rawId;

  if (!billId || typeof billId !== "number" || isNaN(billId)) {
    res.status(400).json({ error: "billId (number) is required" });
    return;
  }

  try {
    // Look up the bill name so we can log it meaningfully
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === billId);
    const name = bill?.name ?? `Bill #${billId}`;
    await markBillPaid(billId, name, userName);
    req.log.info({ userName, billId, billName: name }, "[BILLS] Paid via /bills/paid notification action");
    res.json({ ok: true, dismissed: true, dismissTag: `bill-${billId}` });
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

    // Schedule for 8 AM tomorrow (Central Time)
    const tomorrowDateStr = new Date(Date.now() + 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const fireAt = fireAtCT(tomorrowDateStr, 8);

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

// ── POST /api/bills/:id/paid ──────────────────────────────────────────────────
// REST-style endpoint for the "Mark Paid ✓" notification action button.
// The native app calls this directly from the action handler using the billId
// surfaced in data.billId on the push notification.
// Response: { ok: true, dismissed: true, dismissTag: "bill-<id>" }
router.post("/bills/:id/paid", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid bill id" });
    return;
  }

  try {
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === id);
    const name = bill?.name ?? `Bill #${id}`;
    await markBillPaid(id, name, userName);
    req.log.info({ userName, billId: id, billName: name }, "[BILLS] Marked paid via REST action button");
    res.json({ ok: true, dismissed: true, dismissTag: `bill-${id}` });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/:id/paid error");
    res.status(500).json({ error: "Failed to mark bill as paid" });
  }
});

// ── POST /api/bills/:id/remind-tomorrow ───────────────────────────────────────
// REST-style endpoint for the "Remind Tomorrow" notification action button.
// Schedules a push reminder for 8 AM CT tomorrow. App stays closed.
// Response: { ok: true, reminderId: number, fireAt: string (ISO) }
router.post("/bills/:id/remind-tomorrow", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid bill id" });
    return;
  }

  try {
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === id);
    if (!bill) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }

    const nextDueDate = computeNextDueDate(bill);
    const dueDateStr = nextDueDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Schedule for 8 AM tomorrow (Central Time)
    const tomorrowDateStr2 = new Date(Date.now() + 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const fireAt = fireAtCT(tomorrowDateStr2, 8);

    const amtPart = bill.amount ? ` of ${bill.amount}` : "";
    const reminder = await createReminder({
      userName,
      reminderText: `Your ${bill.name}${amtPart} payment — have you paid it yet?`,
      fireAt,
      timezone: "America/Chicago",
      pushCategoryId: "bill-action",
      pushData: {
        companionMessage: JSON.stringify({ billId: id, billName: bill.name, amount: bill.amount ?? "" }),
        billId: id,
        dueDateISO: dueDateStr,
      },
    });

    req.log.info(
      { userName, billId: id, reminderId: reminder.id, fireAt: fireAt.toISOString() },
      "[BILLS] Remind-tomorrow reminder created via REST action button"
    );
    res.json({ ok: true, reminderId: reminder.id, fireAt: fireAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/:id/remind-tomorrow error");
    res.status(500).json({ error: "Failed to schedule tomorrow reminder" });
  }
});

// ── POST /api/bills/:id/remind-due-date ───────────────────────────────────────
// REST-style endpoint for the "Remind on due date" notification action button.
// Looks up the bill, computes its next due date, and schedules a push reminder
// for 9 AM CT on that day. The native app passes the dueDateISO from
// data.dueDateISO as a hint, but the server always recomputes to stay accurate.
// Response: { ok: true, reminderId: number, fireAt: string (ISO) }
router.post("/bills/:id/remind-due-date", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid bill id" });
    return;
  }

  try {
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === id);
    if (!bill) {
      res.status(404).json({ error: "Bill not found" });
      return;
    }

    // Compute the next due date in Central Time
    const nextDueDate = computeNextDueDate(bill);
    const dueDateStr = nextDueDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Build a fire time of 9 AM CT on the due date.
    const fireAt = fireAtCT(dueDateStr, 9);

    const amtPart = bill.amount ? ` of ${bill.amount}` : "";
    const reminder = await createReminder({
      userName,
      reminderText: `Your ${bill.name}${amtPart} payment — have you paid it yet?`,
      fireAt,
      timezone: "America/Chicago",
      pushCategoryId: "bill-action",
      pushData: {
        companionMessage: JSON.stringify({
          billId: id,
          billName: bill.name,
          amount: bill.amount ?? "",
          dueDateISO: dueDateStr,
        }),
        billId: id,
        dueDateISO: dueDateStr,
      },
    });

    req.log.info(
      { userName, billId: id, reminderId: reminder.id, fireAt: fireAt.toISOString() },
      "[BILLS] Remind-on-due-date reminder created via REST action button"
    );
    res.json({ ok: true, reminderId: reminder.id, fireAt: fireAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/:id/remind-due-date error");
    res.status(500).json({ error: "Failed to schedule due-date reminder" });
  }
});

// ── GET /api/bills — list all tracked bills for the authenticated user ─────────
// Returns each bill enriched with:
//   isPaid        — true only when the user explicitly tapped "Mark Paid" this cycle
//   isOverdue     — true when past due and NOT marked paid
//   nextDueDateISO — YYYY-MM-DD (CT)
//   nextDueDateLabel — human-readable "May 23"
//   daysUntilDue  — integer (negative = overdue)
router.get("/bills", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const bills = await getBills(userName);
    const now = new Date();
    const TZ = "America/Chicago";

    const enriched = bills.map((b) => {
      const nextDueDate = computeNextDueDate(b, now);
      const nextDueDateISO = nextDueDate.toLocaleDateString("en-CA", { timeZone: TZ });
      const nextDueDateLabel = nextDueDate.toLocaleDateString("en-US", {
        timeZone: TZ, month: "long", day: "numeric",
      });
      const todayStr = now.toLocaleDateString("en-CA", { timeZone: TZ });
      const [tY, tM, tD] = todayStr.split("-").map(Number);
      const [nY, nM, nD] = nextDueDateISO.split("-").map(Number);
      const daysUntilDue = Math.round(
        (Date.UTC(nY, nM - 1, nD) - Date.UTC(tY, tM - 1, tD)) / 86400000
      );
      const cycleStart = computeCycleStartDate(b, now);
      const isPaid = b.paidThroughDate != null && b.paidThroughDate >= cycleStart;
      const isOverdue = !isPaid && daysUntilDue < 0;
      return {
        ...b,
        nextDueDateISO,
        nextDueDateLabel,
        daysUntilDue,
        isPaid,
        isOverdue,
      };
    });

    res.json({ bills: enriched });
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
