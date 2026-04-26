import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate } from "../tv/tvmaze.js";
import { preFetchMorningNews, preFetchDailyMotivation } from "../news/newsManager.js";
import { preFetchMorningBriefing } from "../morning/briefingPregenerate.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_WAKE_TIME = "06:00";
// How many minutes before wake time to start pre-fetching.
// 20 min gives Claude plenty of time to finish before the notification fires,
// even after a cold server restart.
const NEWS_LEAD_MINUTES = 25;
const BRIEFING_LEAD_MINUTES = 20;

// ── Local time helpers ─────────────────────────────────────────────────────────

function getCurrentTimeForUser(user: ActiveUser): string {
  const tz = user.timezone ?? DEFAULT_TZ;
  return new Date().toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getLocalDateForUser(user: ActiveUser): string {
  const tz = user.timezone ?? DEFAULT_TZ;
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function subtractMinutes(timeStr: string, mins: number): string {
  const [hStr, mStr] = timeStr.split(":");
  const totalMin = (parseInt(hStr, 10) * 60 + parseInt(mStr, 10) + 1440 - mins) % 1440;
  const h = Math.floor(totalMin / 60).toString().padStart(2, "0");
  const m = (totalMin % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Per-user state tracking ────────────────────────────────────────────────────
// Maps userName → last date string for which we fired each action.

const prefetchDone: Map<string, string> = new Map();
const newsPrefetchDone: Map<string, string> = new Map();
const morningPushDone: Map<string, string> = new Map();

// ── Push body ──────────────────────────────────────────────────────────────────

async function buildMorningBody(user: ActiveUser): Promise<string> {
  const companionName = user.companionName ?? "Winston";
  const base = `${companionName} is ready for your morning briefing. Say good morning to start.`;
  try {
    const watchedShows = await getWatchedShows();
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const todayEps = await fetchEpisodesForDate(new Date(), watchedIds);
    if (todayEps.length > 0) {
      const show = todayEps[0];
      const extra = todayEps.length > 1 ? ` (+${todayEps.length - 1} more)` : "";
      return `${base} Also — new ${show.showName} tonight${extra}!`;
    }
  } catch {
    // ignore — use base body
  }
  return base;
}

// ── Per-tick logic ─────────────────────────────────────────────────────────────

async function runPerUserChecks(): Promise<void> {
  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[MorningPush] Failed to load active users — skipping tick");
    return;
  }

  for (const user of users) {
    const { userName } = user;
    const wakeTime = user.wakeTime ?? DEFAULT_WAKE_TIME;
    const preFetchTime = subtractMinutes(wakeTime, BRIEFING_LEAD_MINUTES);
    const newsTime = subtractMinutes(wakeTime, NEWS_LEAD_MINUTES);
    const localTime = getCurrentTimeForUser(user);
    const today = getLocalDateForUser(user);

    // 25 min before wake: pre-fetch news + motivation (once per user per day)
    if (localTime === newsTime && newsPrefetchDone.get(userName) !== today) {
      newsPrefetchDone.set(userName, today);
      preFetchMorningNews().catch((err) =>
        logger.warn({ err, userName }, "[MorningPush] News pre-fetch error")
      );
      preFetchDailyMotivation().catch((err) =>
        logger.warn({ err, userName }, "[MorningPush] Motivation pre-fetch error")
      );
    }

    // 20 min before wake: pre-generate full Claude briefing (once per user per day)
    if (localTime === preFetchTime && prefetchDone.get(userName) !== today) {
      prefetchDone.set(userName, today);
      logger.info({ userName, preFetchTime }, "[MorningPush] Pre-generating briefing");
      preFetchMorningBriefing(userName).catch((err) =>
        logger.warn({ err, userName }, "[MorningPush] Briefing pre-generate error")
      );
    }

    // At wake time: send morning push (once per user per day)
    if (localTime === wakeTime && morningPushDone.get(userName) !== today) {
      morningPushDone.set(userName, today);
      try {
        const body = await buildMorningBody(user);
        const displayName = user.name ?? userName;
        await sendPushToAll({
          title: `Good morning, ${displayName} ☀️`,
          body,
          tag: "morning-briefing",
          notificationType: "morning-briefing",
          requireInteraction: true,
        }, userName);
        logger.info({ userName, wakeTime }, "[MorningPush] Morning push sent");
      } catch (err) {
        logger.error({ err, userName }, "[MorningPush] Failed to send morning push");
      }
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────

async function startupPrefetch(): Promise<void> {
  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[MorningPush] Startup — failed to load users; defaulting to David");
    users = [{ userName: NATIVE_STORED_NAME, name: NATIVE_STORED_NAME, city: "Dallas", timezone: DEFAULT_TZ, wakeTime: DEFAULT_WAKE_TIME, companionName: null }];
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });

  for (const user of users) {
    const { userName } = user;
    // Mark as done so the cron doesn't double-fire on the same calendar day
    prefetchDone.set(userName, today);
    newsPrefetchDone.set(userName, today);
    logger.info({ userName }, "[MorningPush] Startup — pre-generating briefing");
    preFetchMorningBriefing(userName).catch((err) =>
      logger.warn({ err, userName }, "[MorningPush] Startup briefing error")
    );
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export function startMorningPushScheduler(): void {
  // Always pre-generate on startup so the briefing is ready within ~2 minutes
  // after any fresh deployment, regardless of time of day.
  void startupPrefetch();

  // Every minute: check each active user's wake_time
  cron.schedule("* * * * *", () => {
    void runPerUserChecks();
  });

  logger.info("[MorningPush] Scheduler started — running per-user checks every minute");
}
