import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import {
  getBills,
  computeNextDueDate,
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

let _lastCheckedDate: string | null = null;

// Bill push notifications are disabled — bill reminders are handled exclusively
// by the morning briefing. This scheduler runs to log upcoming bills for
// observability only; no push or SSE is sent from here.
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

    for (const bill of bills) {
      const nextDue = computeNextDueDate(bill, now);
      const daysUntil = daysBetween(now, nextDue);

      if (daysUntil >= 0 && daysUntil <= bill.reminderLeadDays) {
        logger.info(
          { billId: bill.id, name: bill.name, daysUntil, userName },
          "[BILLS] Bill upcoming — morning briefing will handle notification"
        );
      }
    }
  }
}

export function startBillScheduler(): void {
  const startHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }),
    10
  );
  if (startHour >= 9) {
    setTimeout(() => checkBillReminders().catch(() => {}), 5000);
  }

  cron.schedule("* * * * *", async () => {
    try {
      const localTime = getLocalTime();
      const [h] = localTime.split(":").map(Number);
      if (h < 9) return;
      await checkBillReminders();
    } catch (err) {
      logger.error({ err }, "Bill scheduler error");
    }
  });

  logger.info("Bill scheduler started");
}
