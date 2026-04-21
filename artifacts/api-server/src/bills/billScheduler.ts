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

      if (daysUntil !== bill.reminderLeadDays) continue;

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
        url: "/",
        requireInteraction: true,
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
