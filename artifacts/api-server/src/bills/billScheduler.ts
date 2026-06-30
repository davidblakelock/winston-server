import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { query } from "../db.js";
import {
  getBills,
  computeNextDueDate,
  computeCycleStartDate,
  buildBillReminderMessage,
  type UpcomingBill,
} from "./billManager.js";

const TZ = "America/Chicago";

function getLocalDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function getLocalTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function daysBetween(a: Date, b: Date): number {
  const tz = "America/Chicago";
  const aStr = a.toLocaleDateString("en-CA", { timeZone: tz });
  const bStr = b.toLocaleDateString("en-CA", { timeZone: tz });
  const [aY, aM, aD] = aStr.split("-").map(Number);
  const [bY, bM, bD] = bStr.split("-").map(Number);
  return Math.round((Date.UTC(bY, bM - 1, bD) - Date.UTC(aY, aM - 1, aD)) / 86400000);
}

function formatDueDateLabel(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "long",
    day: "numeric",
  });
}

let _lastCheckedDate: string | null = null;

async function checkBillReminders(): Promise<void> {
  const today = getLocalDateString();
  if (_lastCheckedDate === today) return;
  _lastCheckedDate = today;

  const users = await getActiveUsers().catch(() => []);
  if (!users.length) return;

  const now = new Date();

  for (const user of users) {
    const { userName } = user;
    const bills = await getBills(userName).catch(() => []);
    if (!bills.length) continue;

    const profile = await getProfile(userName).catch(() => null);
    const displayName = profile?.name ?? userName;

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
      const daysUntil = daysBetween(now, nextDueDate);

      // Only notify within the lead window
      if (daysUntil < 0 || daysUntil > bill.reminderLeadDays) continue;

      // Atomically claim the send slot in the DB BEFORE pushing.
      // This prevents double-fires across server restarts: if the UPDATE returns
      // 0 rows, another process (or a prior run in the same day) already claimed
      // it — skip. If it returns 1 row, we own the send and can safely push.
      // This replaces the old read-then-write pattern which could race across
      // restarts because _lastCheckedDate is in-memory and resets on each deploy.
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
        dueDateLabel: formatDueDateLabel(nextDueDate),
        isPaid: false,
        isOverdue: daysUntil < 0,
      };

      const body = buildBillReminderMessage(upcomingBill, displayName);

      const dueDateISO = nextDueDate.toISOString().split("T")[0];
      const amountLabel = bill.amount ? ` · $${bill.amount}` : "";

      sendPushToAll(
        {
          title: `${bill.name}${amountLabel} due ${daysUntil === 0 ? "today" : `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`}`,
          body,
          tag: `bill-${bill.id}`,
          notificationType: "bill",
          categoryIdentifier: "bill-action",
          requireInteraction: true,
          billId: bill.id,
          billName: bill.name,
          amount: bill.amount ?? "",
          dueDateISO,
          actionTaken: "/api/bills/paid",
          actionSnooze: "/api/bills/remind-tomorrow",
        },
        userName
      ).catch((err: unknown) => {
        logger.error({ err, billId: bill.id, userName }, "[BILLS] Expo push delivery failed");
      });

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
}

export function startBillScheduler(): void {
  // Run once at startup if already past 9 AM CT
  const startHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }),
    10
  );
  if (startHour >= 9) {
    setTimeout(() => checkBillReminders().catch(() => {}), 5000);
  }

  let _running = false;
  cron.schedule("0 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const localTime = getLocalTime();
      const [h] = localTime.split(":").map(Number);
      if (h < 9) return;
      await checkBillReminders();
    } catch (err) {
      logger.error({ err }, "Bill scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Bill scheduler started");
}
