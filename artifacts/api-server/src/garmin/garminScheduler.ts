import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getGarminConnectedUsers, fetchAndStoreGarminData } from "./garminService.js";
import { fetchAndStoreFitData } from "../google/fit.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";

const TZ = "America/Chicago";

function localTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function syncAllGarminUsers(): Promise<void> {
  const users = await getGarminConnectedUsers().catch(() => []);
  if (!users.length) return;

  logger.info({ count: users.length }, "[Garmin] Starting daily health sync");

  for (const userName of users) {
    try {
      const data = await fetchAndStoreGarminData(userName);
      if (data) {
        logger.info(
          { userName, dataDate: data.dataDate, steps: data.steps, sleepHours: data.sleepHours },
          "[Garmin] Daily sync complete"
        );
      } else {
        logger.warn({ userName }, "[Garmin] No data returned during daily sync");
      }
    } catch (err) {
      logger.error({ userName, err }, "[Garmin] Daily sync error");
    }
  }
}

let _garminSyncedDate: string | null = null;
let _fitSyncedDate: string | null = null;

async function syncAllFitUsers(): Promise<void> {
  let users: Awaited<ReturnType<typeof getActiveUsers>> = [];
  try {
    users = await getActiveUsers();
  } catch {
    return;
  }
  for (const user of users) {
    try {
      const data = await fetchAndStoreFitData(user.userName);
      if (data && data.steps > 0) {
        logger.info(
          { userName: user.userName, date: data.date, steps: data.steps, activeMinutes: data.activeMinutes },
          "[Fit] Daily sync complete"
        );
      } else {
        logger.info({ userName: user.userName }, "[Fit] No steps data from Google Fit (or Google not connected)");
      }
    } catch (err) {
      logger.warn({ userName: user.userName, err }, "[Fit] Daily sync error");
    }
  }
}

export function startGarminScheduler(): void {
  cron.schedule("5 * * * * *", async () => {
    try {
      const t = localTime();
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });

      // 5:00 AM — Google Fit sync (before morning briefing pre-generation)
      if (t === "05:00" && _fitSyncedDate !== today) {
        _fitSyncedDate = today;
        syncAllFitUsers().catch((err) =>
          logger.warn({ err }, "[Fit] Scheduler sync error")
        );
      }

      // 6:00 AM — Garmin sync (device syncs overnight)
      if (t === "06:00" && _garminSyncedDate !== today) {
        _garminSyncedDate = today;
        await syncAllGarminUsers();
      }
    } catch (err) {
      logger.error({ err }, "[Garmin/Fit] Scheduler error");
    }
  });

  logger.info("[Garmin] Scheduler started — Garmin sync at 06:00, Fit sync at 05:00 Central");
}
