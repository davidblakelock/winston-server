import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { getGarminConnectedUsers, fetchAndStoreGarminData } from "./garminService.js";

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

let _syncedDate: string | null = null;

export function startGarminScheduler(): void {
  // Run at 6:00 AM Central every day — Garmin syncs from device overnight
  cron.schedule("* * * * *", async () => {
    try {
      if (localTime() !== "06:00") return;
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      if (_syncedDate === today) return;
      _syncedDate = today;
      await syncAllGarminUsers();
    } catch (err) {
      logger.error({ err }, "[Garmin] Scheduler error");
    }
  });

  logger.info("[Garmin] Scheduler started — daily sync at 06:00 Central");
}
