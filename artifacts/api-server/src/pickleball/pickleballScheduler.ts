import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { logger } from "../lib/logger.js";
import {
  isTodayPickleballDay,
  getTodaySession,
} from "./pickleballManager.js";

const TZ = "America/Chicago";

function localTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

let _askedToday = false;
let _lastDay: string | null = null;

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

export function startPickleballScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const today = localDateStr();
      if (_lastDay !== today) {
        _askedToday = false;
        _lastDay = today;
      }

      if (_askedToday) return;
      if (!isTodayPickleballDay()) return;

      // Fire at 11:00am on pickleball days — after the typical session ends
      if (localTime() !== "11:00") return;

      // Only ask if we haven't already logged a session today
      const session = await getTodaySession();
      if (session) return; // Already logged — no need to ask

      _askedToday = true;

      const message = "How was pickleball this morning, David? Did you win?";

      broadcast("reminder", {
        id: `pickleball-checkin-${Date.now()}`,
        userName: "David",
        reminderText: message,
        speakText: message,
        isPickleball: true,
      });

      logger.info("Pickleball post-session check-in fired");
    } catch (err) {
      logger.error({ err }, "Pickleball scheduler error");
    }
  });

  logger.info("Pickleball scheduler started");
}
