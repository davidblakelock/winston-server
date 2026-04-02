import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { getAppUrl } from "../auth/sessionAuth.js";
import { logger } from "../lib/logger.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate } from "../tv/tvmaze.js";
import { preFetchMorningNews } from "../news/newsManager.js";

const TZ = "America/Chicago";

let _morningFiredDate: string | null = null;
let _newsPrefetchDate: string | null = null;

function getCurrentLocalTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getLocalDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

async function buildMorningBody(): Promise<string> {
  const base = "Emma Peel is ready for your morning briefing. Say good morning to start.";

  try {
    const watchedShows = await getWatchedShows();
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const todayEps = await fetchEpisodesForDate(new Date(), watchedIds);

    if (todayEps.length > 0) {
      const show = todayEps[0];
      const extraShows = todayEps.length > 1 ? ` (+${todayEps.length - 1} more)` : "";
      return `${base} Also — new ${show.showName} tonight${extraShows}!`;
    }
  } catch {
    // ignore, use base body
  }

  return base;
}

export function startMorningPushScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const localTime = getCurrentLocalTime();
      const today = getLocalDateString();

      // 5:50 AM — pre-fetch morning news so it's cached and instant at briefing time
      if (localTime === "05:50" && _newsPrefetchDate !== today) {
        _newsPrefetchDate = today;
        preFetchMorningNews().catch((err) =>
          logger.warn({ err }, "Background news pre-fetch error")
        );
      }

      // 6:00 AM — send morning push notification
      if (localTime !== "06:00") return;
      if (_morningFiredDate === today) return;
      _morningFiredDate = today;

      const body = await buildMorningBody();

      const appUrl = getAppUrl();
      await sendPushToAll({
        title: "Good morning, David ☀️",
        body,
        tag: "morning-briefing",
        url: `${appUrl}/?notification=morning`,
        requireInteraction: true,
      });

      logger.info("Morning briefing push notification sent");
    } catch (err) {
      logger.error({ err }, "Morning push scheduler error");
    }
  });

  logger.info("Morning push scheduler started");
}
