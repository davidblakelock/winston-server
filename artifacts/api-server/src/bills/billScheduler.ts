import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile, type ActiveUser } from "../onboarding/onboardingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { query } from "../db.js";
import {
  getBills,
  computeNextDueDate,
  computeCycleStartDate,
  buildBillReminderMessage,
  type UpcomingBill,
} from "./billManager.js";

// TZ is resolved per-user from profile.timezone (the real stored device/profile
// timezone, not a location/GPS-derived guess) for both the fire-hour gate and
// all date math below.

function getLocalDateString(tz = "UTC"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function daysBetween(a: Date, b: Date, tz = "UTC"): number {
  const aStr = a.toLocaleDateString("en-CA", { timeZone: tz });
  const bStr = b.toLocaleDateString("en-CA", { timeZone: tz });
  const [aY, aM, aD] = aStr.split("-").map(Number);
  const [bY, bM, bD] = bStr.split("-").map(Number);
  return Math.round((Date.UTC(bY, bM - 1, bD) - Date.UTC(aY, aM - 1, aD)) / 86400000);
}

function formatDueDateLabel(d: Date, tz = "UTC"): string {
  return d.toLocaleDateString("en-US", {
    timeZone: tz,
    month: "long",
    day: "numeric",
  });
}

const TARGET_LOCAL_HOUR = 8;
// userName -> local date (in that user's own timezone) already checked
const _checkedToday = new Map<string, string>();

async function checkBillsForUser(userName: string, userTz: string): Promise<void> {
  const today = getLocalDateString(userTz);
  const bills = await getBills(userName).catch(() => []);
  if (!bills.length) return;

  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const now = new Date();

  for (const bill of bills) {
    // Skip auto-pay bills — they handle themselves
    if (bill.autoPay) {
      logger.info({ billId: bill.id, name: bill.name, userName }, "[BILLS] Auto-pay — skipping reminder");
      continue;
    }

    // Skip if user already marked this bill as paid this cycle
    if (bill.paidThroughDate) {
      const cycleStart = computeCycleStartDate(bill, now);
      if (bill.paidThroughDate >= cycleStart) {
        logger.info({ billId: bill.id, name: bill.name, userName }, "[BILLS] Already paid this cycle — skipping reminder");
        continue;
      }
    }

    const nextDueDate = computeNextDueDate(bill, now);
    const daysUntil = daysBetween(now, nextDueDate, userTz);

    // Only notify within the lead window
    if (daysUntil < 0 || daysUntil > bill.reminderLeadDays) continue;

    // Atomically claim the send slot in the DB BEFORE pushing.
    // This prevents double-fires across server restarts: if the UPDATE returns
    // 0 rows, another process (or a prior run in the same day) already claimed
    // it — skip. If it returns 1 row, we own the send and can safely push.
    const claimed = await query<{ id: number }>(
      `UPDATE financial_obligations
          SET last_reminded_date = $1
        WHERE id = $2
          AND (last_reminded_date IS NULL OR last_reminded_date < $1)
        RETURNING id`,
      [today, bill.id]
    );
    if (!claimed.rows.length) {
      logger.info(
        { billId: bill.id, name: bill.name, userName },
        "[BILLS] Already reminded today (atomic DB claim) — skipping"
      );
      continue;
    }

    const upcomingBill: UpcomingBill = {
      ...bill,
      nextDueDate,
      daysUntilDue: daysUntil,
      dueDateLabel: formatDueDateLabel(nextDueDate, userTz),
      isPaid: false,
      isOverdue: daysUntil < 0,
    };

    const body = buildBillReminderMessage(upcomingBill, displayName);

    const dueDateISO = nextDueDate.toISOString().split("T")[0];
    const amountLabel = bill.amount ? ` · $${bill.amount}` : "";

    sendFcmNotification({
      userName,
      notificationType: "bill",
      title: `${bill.name}${amountLabel} due ${daysUntil === 0 ? "today" : `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`}`,
      body,
      data: {
        billId: String(bill.id),
        billName: bill.name,
        amount: bill.amount ?? "",
        dueDateISO,
      },
    }).catch((err: unknown) => {
      logger.error({ err, billId: bill.id, userName }, "[BILLS] FCM push delivery failed");
    });

    logger.info(
      { billId: bill.id, name: bill.name, daysUntil, userName },
      "[BILLS] Bill reminder push sent"
    );
  }
}

async function runPerUserCheck(user: ActiveUser): Promise<void> {
  const tz = user.timezone ?? "UTC";
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
    10
  );
  if (localHour < TARGET_LOCAL_HOUR) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: tz });
  if (_checkedToday.get(user.userName) === today) return;
  _checkedToday.set(user.userName, today);

  await checkBillsForUser(user.userName, tz).catch((err) => {
    logger.error({ err, userName: user.userName }, "[BILLS] Per-user check failed");
  });
}

export function startBillScheduler(): void {
  let _running = false;
  cron.schedule("*/5 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => []);
      await Promise.allSettled(users.map((user) => runPerUserCheck(user)));
    } catch (err) {
      logger.error({ err }, "Bill scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Bill scheduler started — checks every 5 min, fires once per user at their local 8am");
}
