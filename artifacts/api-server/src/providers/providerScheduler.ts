import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { getProvidersWithUpcomingDue } from "./providerManager.js";

function daysUntil(nextDueDateStr: string): number {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  const [tY, tM, tD] = today.split("-").map(Number);
  const [nY, nM, nD] = nextDueDateStr.split("-").map(Number);
  return Math.round(
    (Date.UTC(nY, nM - 1, nD) - Date.UTC(tY, tM - 1, tD)) / 86400000
  );
}

let _lastCheckedDate: string | null = null;

async function checkProviderDueAlerts(): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  if (_lastCheckedDate === today) return;
  _lastCheckedDate = today;

  const users = await getActiveUsers().catch(() => []);
  for (const { userName } of users) {
    try {
      const upcoming = await getProvidersWithUpcomingDue(userName, 7);
      for (const provider of upcoming) {
        if (!provider.nextDueDate) continue;
        const days = daysUntil(provider.nextDueDate);
        if (days < 0 || days > 7) continue;
        const daysLabel = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
        await sendFcmNotification({
          userName,
          notificationType: "provider-reminder",
          title: "Appointment Due",
          body: `Your appointment with ${provider.name}${provider.company ? ` (${provider.company})` : ""} is ${daysLabel}. Want me to help schedule it?`,
          data: { action: "navigate", screen: "/providers" },
        });
        logger.info(
          { userName, providerId: provider.id, name: provider.name, daysLabel },
          "[Providers] Due-date push sent"
        );
      }
    } catch (err) {
      logger.warn({ err, userName }, "[Providers] checkProviderDueAlerts error for user");
    }
  }
}

export function startProviderScheduler(): void {
  const startHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", hour12: false }),
    10
  );
  if (startHour >= 9) {
    setTimeout(() => checkProviderDueAlerts().catch(() => {}), 6000);
  }

  cron.schedule(
    "0 9 * * *",
    async () => {
      try { await checkProviderDueAlerts(); }
      catch (err) { logger.error({ err }, "[Providers] scheduler error"); }
    }
  );

  logger.info("[Providers] Due-date scheduler started (daily 9 AM UTC)");
}