import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
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

let _lastCheckedDate: string | null = null;

async function checkBillReminders(): Promise<void> {
  const today = getLocalDateString();
  if (_lastCheckedDate === today) return;
  _lastCheckedDate = today;

  const bills = await getBills("David2");
  if (!bills.length) return;

  const now = new Date();

  for (const bill of bills) {
    const nextDue = computeNextDueDate(bill, now);
    const daysUntil = daysBetween(now, nextDue);

    if (daysUntil !== bill.reminderLeadDays) continue;

    // Don't re-fire if already reminded within the last 7 days
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

    const message = buildBillReminderMessage(upcoming);

    broadcast("reminder", {
      id: `bill-${bill.id}-${Date.now()}`,
      userName: "David",
      reminderText: message,
      speakText: message,
      isBill: true,
    });

    await sendPushToAll({
      title: "💳 Bill Reminder — Emma Peel",
      body: message,
      tag: `bill-${bill.id}`,
      url: "/",
      requireInteraction: true,
    }).catch(() => {});

    await markReminded(bill.id, today);

    logger.info(
      { billId: bill.id, name: bill.name, daysUntil },
      "Bill reminder fired"
    );
  }
}

export function startBillScheduler(): void {
  // Run every minute, but only actually execute once per day at 09:00 Central
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
