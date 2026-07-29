import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { markBillPaid, clearBillPaid, getBills, addBill, computeNextDueDate, computeCycleStartDate, type Category, type Frequency } from "../bills/billManager.js";

import { createReminder } from "../reminders/reminderManager.js";
import { scanForBillAnomalies } from "../bills/billAnomalyScanner.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

const router: IRouter = Router();

// ── Timezone helper ───────────────────────────────────────────────────────────
// Returns a UTC Date that represents `hourLocal:00:00` in the given timezone on `dateStr`.
// Probes the actual Intl offset rather than hardcoding it — immune to DST transitions.
function computeFireAt(dateStr: string, hourLocal: number, tz: string): Date {
  const approxUtc = new Date(`${dateStr}T${String(hourLocal).padStart(2, "0")}:00:00.000Z`);
  const localHour = parseInt(
    approxUtc.toLocaleTimeString("en-US", { timeZone: tz, hour: "2-digit", hour12: false }),
    10
  );
  return new Date(approxUtc.getTime() + (hourLocal - localHour) * 3_600_000);
}

// ── Shared bill enrichment ────────────────────────────────────────────────────
// Adds computed display fields to a raw Bill. Used by GET /bills and all paid
// endpoints so the native app can update local state without a re-fetch.
function enrichBill(b: Awaited<ReturnType<typeof getBills>>[number], now = new Date(), TZ = "UTC") {
  const nextDueDate = computeNextDueDate(b, now);
  const nextDueDateISO = nextDueDate.toLocaleDateString("en-CA", { timeZone: TZ });
  const nextDueDateLabel = nextDueDate.toLocaleDateString("en-US", { timeZone: TZ, month: "long", day: "numeric" });
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const [tY, tM, tD] = todayStr.split("-").map(Number);
  const [nY, nM, nD] = nextDueDateISO.split("-").map(Number);
  const daysUntilDue = Math.round((Date.UTC(nY, nM - 1, nD) - Date.UTC(tY, tM - 1, tD)) / 86400000);
  const cycleStart = computeCycleStartDate(b, now);
  const isPaid = b.paidThroughDate != null && b.paidThroughDate >= cycleStart;
  const isOverdue = !isPaid && daysUntilDue < 0;
  return { ...b, nextDueDateISO, nextDueDateLabel, daysUntilDue, isPaid, isOverdue };
}

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
    const { timezone } = await getUserLocationContext(userName);
    // Look up the bill name so we can log it meaningfully
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === billId);
    const name = bill?.name ?? `Bill #${billId}`;
    await markBillPaid(billId, name, userName);
    const updatedBills = await getBills(userName);
    const updatedBill = updatedBills.find((b) => b.id === billId);
    const enriched = updatedBill ? enrichBill(updatedBill, new Date(), timezone) : null;
    req.log.info({ userName, billId, billName: name }, "[BILLS] Paid via /bills/paid notification action");
    res.json({ ok: true, bill: enriched });
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
    const { timezone } = await getUserLocationContext(userName);

    const tomorrowDateStr = new Date(Date.now() + 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: timezone });
    const fireAt = computeFireAt(tomorrowDateStr, 8, timezone);

    const reminder = await createReminder({
      userName,
      reminderText: `Your ${name}${amtPart} payment — have you paid it yet?`,
      fireAt,
      timezone,
      pushCategoryId: "bill-action",
      pushData: {
        billId,
        billName: name,
        amount: amount ?? "",
        actionTaken: "/api/bills/paid",
        actionSnooze: "/api/bills/remind-tomorrow",
        companionMessage: {
          billId,
          billName: name,
          amount: amount ?? "",
          actionTaken: "/api/bills/paid",
          actionSnooze: "/api/bills/remind-tomorrow",
        },
      },
    });

    req.log.info({ userName, billId, reminderId: reminder.id }, "[BILLS] Remind-tomorrow reminder created via notification action");
    res.json({ ok: true, reminderId: reminder.id });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/remind-tomorrow error");
    res.status(500).json({ error: "Failed to create tomorrow reminder" });
  }
});

// ── POST /api/bills/:id/paid — mark a bill paid (in-app "Mark as Paid" button) ──
// The native app's bills.tsx screen calls this exact path — it existed
// nowhere on the server (only /bills/paid, billId-in-body, used by the
// notification action, was registered), so every in-app tap 404'd. The
// screen's optimistic local update then got silently reverted by the
// follow-up fetchBills() call, which re-fetched the real, still-unpaid
// server state — looked like "stays showing unpaid" with no error visible.
// Response: { ok: true, bill: enrichedBill }
router.post("/bills/:id/paid", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const billId = parseInt(req.params.id, 10);
  if (isNaN(billId)) { res.status(400).json({ error: "Invalid bill id" }); return; }
  try {
    const { timezone } = await getUserLocationContext(userName);
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === billId);
    const name = bill?.name ?? `Bill #${billId}`;
    await markBillPaid(billId, name, userName);
    const updatedBills = await getBills(userName);
    const updatedBill = updatedBills.find((b) => b.id === billId);
    const enriched = updatedBill ? enrichBill(updatedBill, new Date(), timezone) : null;
    req.log.info({ userName, billId, billName: name }, "[BILLS] Paid via in-app /bills/:id/paid button");
    res.json({ ok: true, bill: enriched });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/:id/paid error");
    res.status(500).json({ error: "Failed to mark bill as paid" });
  }
});

// ── POST /api/bills/:id/clear-paid — unmark a bill as paid this cycle ────────
// Clears paid_through_date so the bill reappears as unpaid.
// Response: { ok: true, bill: enrichedBill }
router.post("/bills/:id/clear-paid", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const billId = parseInt(req.params.id, 10);
  if (isNaN(billId)) { res.status(400).json({ error: "Invalid bill id" }); return; }
  try {
    const { timezone } = await getUserLocationContext(userName);
    await clearBillPaid(billId, userName);
    const bills = await getBills(userName);
    const bill = bills.find((b) => b.id === billId);
    const enriched = bill ? enrichBill(bill, new Date(), timezone) : null;
    req.log.info({ userName, billId }, "[BILLS] Cleared paid_through_date");
    res.json({ ok: true, bill: enriched });
  } catch (err) {
    req.log.error({ err }, "[BILLS] POST /bills/:id/clear-paid error");
    res.status(500).json({ error: "Failed to clear bill paid status" });
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
    const { timezone } = await getUserLocationContext(userName);
    const bills = await getBills(userName);
    const now = new Date();
    const enriched = bills.map((b) => enrichBill(b, now, timezone));
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
