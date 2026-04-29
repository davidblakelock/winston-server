import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import {
  getBills,
  computeNextDueDate,
  buildBillReminderMessage,
  markReminded,
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
  const msPerDay = 86400000;
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bDay.getTime() - aDay.getTime()) / msPerDay);
}

// ── Urgent notification body (within 2 days) ──────────────────────────────────
// Formats a short, action-button-friendly message. The companion name is used
// in the push title rather than in the body for brevity.
function buildUrgentNotificationBody(bill: UpcomingBill): string {
  const amtPart = bill.amount ? ` of ${bill.amount}` : "";
  if (bill.daysUntilDue === 0) {
    return `Your ${bill.name}${amtPart} is due today. Paid?`;
  }
  if (bill.daysUntilDue === 1) {
    return `Your ${bill.name}${amtPart} is due tomorrow. Paid?`;
  }
  return `Your ${bill.name}${amtPart} is due in ${bill.daysUntilDue} days. Paid?`;
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
    const { userName, name: displayName, companionName } = user;
    const userDisplay = displayName ?? userName;
    const companion = companionName ?? "Winston";

    const bills = await getBills(userName).catch(() => []);
    if (!bills.length) continue;

    for (const bill of bills) {
      const nextDue = computeNextDueDate(bill, now);
      const daysUntil = daysBetween(now, nextDue);

      // Guard: skip bills already reminded within the last 7 days
      if (bill.lastRemindedDate) {
        const daysSinceLast = daysBetween(new Date(bill.lastRemindedDate + "T12:00:00"), now);
        if (daysSinceLast < 7) continue;
      }

      const upcoming: UpcomingBill = {
        ...bill,
        nextDueDate: nextDue,
        daysUntilDue: daysUntil,
        dueDateLabel: nextDue.toLocaleDateString("en-US", {
          timeZone: TZ,
          month: "long",
          day: "numeric",
        }),
      };

      // ── Within 2 days: urgent "Paid?" notification with action buttons ────────
      // Takes priority over the lead-days reminder if the due date is imminent.
      if (daysUntil >= 0 && daysUntil <= 2) {
        const notifBody = buildUrgentNotificationBody(upcoming);

        broadcast("reminder", {
          id: `bill-urgent-${bill.id}-${Date.now()}`,
          userName,
          reminderText: notifBody,
          speakText: buildBillReminderMessage(upcoming, userDisplay),
          isBill: true,
        });

        await sendPushToAll({
          title: `💳 Bill Due Soon — ${companion}`,
          body: notifBody,
          tag: `bill-${bill.id}`,
          notificationType: "bill-reminder",
          // "bill-action" category shows "Mark Paid ✓" and "Remind Me Tomorrow" buttons.
          // Native app must register this category via Notifications.setNotificationCategoryAsync.
          // Action handlers call:
          //   POST /api/bills/mark-paid   { billId, billName, amount }
          //   POST /api/bills/remind-tomorrow  { billId, billName, amount }
          categoryId: "bill-action",
          requireInteraction: true,
          // Pass structured data so native app action handlers have what they need
          companionMessage: JSON.stringify({ billId: bill.id, billName: bill.name, amount: bill.amount ?? "" }),
        }, userName).catch(() => {});

        await markReminded(bill.id, today);

        logger.info(
          { billId: bill.id, name: bill.name, daysUntil, userName },
          "Urgent bill reminder fired (within 2 days)"
        );
        continue; // Don't also fire the lead-days reminder
      }

      // ── Lead-days reminder: early warning at reminderLeadDays out ─────────────
      if (daysUntil !== bill.reminderLeadDays) continue;

      const message = buildBillReminderMessage(upcoming, userDisplay);

      broadcast("reminder", {
        id: `bill-${bill.id}-${Date.now()}`,
        userName,
        reminderText: message,
        speakText: message,
        isBill: true,
      });

      await sendPushToAll({
        title: `💳 Bill Reminder — ${companion}`,
        body: message,
        tag: `bill-${bill.id}`,
        notificationType: "bill-reminder",
        categoryId: "bill-action",
        requireInteraction: true,
        companionMessage: JSON.stringify({ billId: bill.id, billName: bill.name, amount: bill.amount ?? "" }),
      }, userName).catch(() => {});

      await markReminded(bill.id, today);

      logger.info(
        { billId: bill.id, name: bill.name, daysUntil, userName },
        "Bill reminder fired"
      );
    }
  }
}

export function startBillScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      if (getLocalTime() !== "09:00") return;
      await checkBillReminders();
    } catch (err) {
      logger.error({ err }, "Bill scheduler error");
    }
  });

  logger.info("Bill scheduler started");
}
