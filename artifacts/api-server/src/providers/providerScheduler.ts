import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { getProvidersWithUpcomingDue } from "./providerManager.js";

function daysUntil(nextDueDateStr: string, tz: string): number {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const [tY, tM, tD] = today.split("-").map(Number);
  const [nY, nM, nD] = nextDueDateStr.split("-").map(Number);
  return Math.round(
    (Date.UTC(nY, nM - 1, nD) - Date.UTC(tY, tM - 1, tD)) / 86400000
  );
}

const TARGET_LOCAL_HOUR = 9;
// userName -> local date (in that user's own timezone) already checked
const _checkedToday = new Map<string, string>();

async function checkProviderDueAlertsForUser(userName: string, tz: string): Promise<void> {
  try {
    const upcoming = await getProvidersWithUpcomingDue(userName, 7);
    for (const provider of upcoming) {
      if (!provider.nextDueDate) continue;
      const days = daysUntil(provider.nextDueDate, tz);
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

  await checkProviderDueAlertsForUser(user.userName, tz);
}

export function startProviderScheduler(): void {
  let _running = false;
  cron.schedule("*/5 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => []);
      await Promise.allSettled(users.map((user) => runPerUserCheck(user)));
    } catch (err) {
      logger.error({ err }, "[Providers] scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("[Providers] Due-date scheduler started — checks every 5 min, fires once per user at their local 9am");
}