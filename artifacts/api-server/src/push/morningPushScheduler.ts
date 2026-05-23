import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate } from "../tv/tvmaze.js";
import { preFetchMorningNews, preFetchDailyMotivation, checkMiddayNews } from "../news/newsManager.js";
import { preFetchMorningBriefing } from "../morning/briefingPregenerate.js";
import {
  getStaticBriefingContext,
  loadStaticContextFromDb,
  claimMorningPushSlot,
  releaseMorningPushSlot,
  wasPushSentToday,
} from "../morning/briefingCache.js";
import { wasApifyDailyFlagSet, setApifyDailyFlag } from "../lib/apifyCache.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_WAKE_TIME = "06:00";

// How many minutes before wake time to start pre-fetching.
const NEWS_LEAD_MINUTES = 25;
const BRIEFING_LEAD_MINUTES = 20;

// How many minutes after wake time we will still attempt to send the push.
// 120 minutes covers deployment-triggered restarts that land after the wake window.
// For a 6:00 AM wake time this keeps the window open until 8:00 AM — late enough
// to catch any restart caused by a deployment, DB blip, or container recycle.
const WAKE_WINDOW_MINUTES = 120;

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

// Returns how many minutes localTime is past wakeTime (negative if before).
function minutesSinceWake(localTime: string, wakeTime: string): number {
  const [lh, lm] = localTime.split(":").map(Number);
  const [wh, wm] = wakeTime.split(":").map(Number);
  return (lh * 60 + lm) - (wh * 60 + wm);
}

// ── Per-user state tracking ────────────────────────────────────────────────────
// Note: morningPushDone is now DB-backed via wasPushSentToday() / markPushSent().
// These maps track the pre-fetch actions (news/briefing) which are fire-and-forget.

const prefetchDone: Map<string, string>     = new Map();
const newsPrefetchDone: Map<string, string> = new Map();
const middayCheckDone: Map<string, string>  = new Map();

// ── Push body ──────────────────────────────────────────────────────────────────

async function buildMorningBody(user: ActiveUser): Promise<string> {
  const base = `Your morning briefing is ready — tap to open.`;
  try {
    const watchedShows = await getWatchedShows(user.userName);
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const todayEps = await fetchEpisodesForDate(new Date(), watchedIds);
    if (todayEps.length > 0) {
      const show = todayEps[0];
      const extra = todayEps.length > 1 ? ` (+${todayEps.length - 1} more)` : "";
      return `Your morning briefing is ready — tap to open. New ${show.showName} today${extra}!`;
    }
  } catch {
    // ignore — use base body
  }
  return base;
}

// ── Send push for a user ───────────────────────────────────────────────────────

async function sendMorningPush(user: ActiveUser, wakeTime: string): Promise<void> {
  const { userName } = user;

  // Try to restore an already-generated briefing from DB before anything else.
  // This prevents duplicate Apify/Claude calls after server restarts.
  let staticCtx = getStaticBriefingContext(userName);
  if (!staticCtx) {
    await loadStaticContextFromDb(userName).catch(() => false);
    staticCtx = getStaticBriefingContext(userName);
    if (staticCtx) {
      logger.info({ userName }, "[MorningPush] Briefing restored from DB cache");
    }
  }

  // Atomically claim the send slot — prevents double-send across restarts.
  // Fire the push AT wake time regardless of whether the briefing is ready.
  // The app fetches briefing on-demand if cache is cold; the push fires on time.
  const claimed = await claimMorningPushSlot(userName);
  if (!claimed) {
    logger.info({ userName }, "[MorningPush] Push slot already claimed — skipping (prevents double-send)");
    return;
  }

  try {
    const body = await buildMorningBody(user);
    const displayName = user.name ?? userName;
    const result = await sendPushToAll({
      title: `Good morning, ${displayName} ☀️`,
      body,
      tag: "morning-briefing",
      notificationType: "morning-briefing",
      autoSendMessage: "good morning",
      requireInteraction: true,
    }, userName);

    if (result.sent === 0) {
      // Push failed (network error, no valid tokens, etc.) — release the slot
      // so the next scheduler tick retries rather than silently giving up.
      logger.warn(
        { userName, wakeTime, sent: result.sent, failed: result.failed },
        "[MorningPush] Push delivery failed — releasing slot for retry next tick"
      );
      await releaseMorningPushSlot(userName).catch(() => {});
      return;
    }

    logger.info(
      { userName, wakeTime, briefingReady: !!staticCtx },
      "[MorningPush] Morning push sent"
    );
  } catch (err) {
    logger.error({ err, userName }, "[MorningPush] Failed to send morning push");
    await releaseMorningPushSlot(userName).catch(() => {});
    return;
  }

  // If briefing wasn't cached, generate it now in the background so it's
  // ready when the user taps the notification (usually a few seconds later).
  if (!staticCtx) {
    logger.info({ userName }, "[MorningPush] Briefing not cached — generating in background after push");
    preFetchMorningBriefing(userName).catch((err) =>
      logger.warn({ err, userName }, "[MorningPush] Background briefing pre-gen failed")
    );
  }
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
      preFetchMorningNews(userName).catch((err) =>
        logger.warn({ err, userName }, "[MorningPush] News pre-fetch error")
      );
      preFetchDailyMotivation(userName).catch((err) =>
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

    // Within the 30-minute wake window: send push if not already sent today.
    // sendMorningPush fires the push immediately at wake time — it no longer
    // waits for the briefing to be ready, so the notification always arrives on time.
    const minsSince = minutesSinceWake(localTime, wakeTime);
    if (minsSince >= 0 && minsSince <= WAKE_WINDOW_MINUTES && !wasPushSentToday(userName)) {
      await sendMorningPush(user, wakeTime);
    }

    // 12:00 PM local time: check for significant breaking news since morning briefing.
    // Guard is now DB-backed so server restarts don't cause duplicate midday Apify runs.
    if (localTime === "12:00" && middayCheckDone.get(userName) !== today) {
      middayCheckDone.set(userName, today); // in-memory fast-path
      const dbFlagKey = `midday_check_done:${userName}`;
      wasApifyDailyFlagSet(dbFlagKey, today).then((alreadyDone) => {
        if (alreadyDone) {
          logger.info({ userName, today }, "[MiddayNews] Skipped — DB flag already set for today");
          return;
        }
        setApifyDailyFlag(dbFlagKey, today).catch(() => {});
        checkMiddayNews(userName)
          .then(async (story) => {
            if (!story) return; // Nothing significant — send nothing
            await sendPushToAll({
              title: "Breaking News",
              body:  story,
              tag:   `midday-news-${today}`,
              notificationType: "midday-news",
            }, userName);
            logger.info({ userName, story: story.slice(0, 80) }, "[MiddayNews] Push sent");
          })
          .catch((err) => logger.warn({ err, userName }, "[MiddayNews] Check error"));
      }).catch((err) => logger.warn({ err, userName }, "[MiddayNews] DB flag check error"));
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

  for (const user of users) {
    const { userName } = user;
    // Mark pre-fetch as done so the cron doesn't double-fire on the same calendar day
    const today = new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });
    prefetchDone.set(userName, today);
    newsPrefetchDone.set(userName, today);

    // CRITICAL: Check DB for today's static context before spending tokens on regeneration.
    // loadStaticContextFromDb also restores push_sent_at so we don't re-send.
    const alreadyCached = await loadStaticContextFromDb(userName).catch(() => false);
    if (alreadyCached) {
      logger.info({ userName }, "[MorningPush] Startup — static context restored from DB, skipping pre-generation");

      // If we're inside the wake window AND the push hasn't been sent yet (restart
      // happened before the push could fire), send it now immediately.
      const wakeTime = user.wakeTime ?? DEFAULT_WAKE_TIME;
      const localTime = new Date().toLocaleTimeString("en-US", {
        timeZone: user.timezone ?? DEFAULT_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const minsSince = minutesSinceWake(localTime, wakeTime);
      if (minsSince >= 0 && minsSince <= WAKE_WINDOW_MINUTES && !wasPushSentToday(userName)) {
        logger.info(
          { userName, minsSince },
          "[MorningPush] Startup — within wake window and push not sent — sending now"
        );
        // Small delay to let the rest of startup finish first
        setTimeout(() => {
          sendMorningPush(user, wakeTime).catch((err) =>
            logger.error({ err, userName }, "[MorningPush] Startup push send failed")
          );
        }, 5000);
      }
      continue;
    }

    // Only pre-generate on startup if we're inside the morning window (05:00–07:30 CT).
    // A midnight restart should NOT trigger a pre-gen — it would use overnight news
    // and that stale briefing would be served at 6 AM instead of fresh content.
    // The scheduled cron (at preFetchTime each morning) handles the real pre-gen.
    const startupLocalTime = new Date().toLocaleTimeString("en-US", {
      timeZone: DEFAULT_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const startupHour = parseInt(startupLocalTime.split(":")[0]!, 10);
    const inMorningWindow = startupHour >= 5 && startupHour < 8;

    if (!inMorningWindow) {
      logger.info({ userName, startupLocalTime }, "[MorningPush] Startup — outside morning window, skipping pre-gen (cron will handle it at 5:40 AM CT)");
    } else {
      logger.info({ userName }, "[MorningPush] Startup — in morning window, no DB cache found, pre-generating briefing");
      preFetchMorningBriefing(userName).catch((err) =>
        logger.warn({ err, userName }, "[MorningPush] Startup briefing error")
      );
    }
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export function startMorningPushScheduler(): void {
  void startupPrefetch();

  let _running = false;
  // Every minute: check each active user's wake_time
  cron.schedule("30 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      await runPerUserChecks();
    } finally {
      _running = false;
    }
  });

  logger.info("[MorningPush] Scheduler started — running per-user checks every minute");
}
