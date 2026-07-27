import cron from "node-cron";
import { sendFcmNotification } from "./fcmSender.js";
import { logger } from "../lib/logger.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate } from "../tv/tvmaze.js";
import { checkMiddayNews } from "../news/newsManager.js";
import {
  loadStaticContextFromDb,
  claimMorningPushSlot,
  releaseMorningPushSlot,
  wasPushSentToday,
} from "../morning/briefingCache.js";
import { wasApifyDailyFlagSet, setApifyDailyFlag } from "../lib/apifyCache.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const DEFAULT_TZ = "UTC"; // Scheduler runs in UTC; each user has their own timezone in profile
const DEFAULT_WAKE_TIME = "06:00";

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

// Returns how many minutes localTime is past wakeTime (negative if before).
function minutesSinceWake(localTime: string, wakeTime: string): number {
  const [lh, lm] = localTime.split(":").map(Number);
  const [wh, wm] = wakeTime.split(":").map(Number);
  return (lh * 60 + lm) - (wh * 60 + wm);
}

// ── Per-user state tracking ────────────────────────────────────────────────────
// Note: morningPushDone is now DB-backed via wasPushSentToday().

const middayCheckDone: Map<string, string>  = new Map();

const _retryCount = new Map<string, number>();
const MAX_PUSH_RETRIES = 5;

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
    const result = await sendFcmNotification({
      userName,
      notificationType: "morning-briefing",
      title: `Good morning, ${displayName} ☀️`,
      body,
      // Must match the phrasing the system prompt requires to fire
      // [ACTION:morning_rundown] ("morning run down, morning briefing, or
      // daily briefing") — a plain "Good morning" greeting doesn't clear that
      // bar, so tapping the notification produced a generic reply instead of
      // the actual rundown.
      data: { action: "send_message", message: "Give me my morning briefing" },
    });

    if (result.sent === 0) {
      // Push failed (network error, no valid tokens, etc.) — release the slot
      // so the next scheduler tick retries rather than silently giving up,
      // unless we've already hit the max retry limit for today.
      const retries = (_retryCount.get(userName) ?? 0) + 1;
      if (retries >= MAX_PUSH_RETRIES) {
        logger.warn({ userName, retries }, "[MorningPush] Max retries reached — giving up for today");
        _retryCount.delete(userName);
        // Don't release slot — leave push_sent_at set so we don't retry again today
      } else {
        _retryCount.set(userName, retries);
        logger.info(
          { userName, wakeTime, sent: result.sent, failed: result.failed, retries },
          "[MorningPush] Push delivery failed — releasing slot for retry next tick"
        );
        await releaseMorningPushSlot(userName).catch(() => {});
      }
      return;
    }

    _retryCount.delete(userName);
    logger.info({ userName, wakeTime }, "[MorningPush] Morning push sent");
  } catch (err) {
    logger.error({ err, userName }, "[MorningPush] Failed to send morning push");
    const retries = (_retryCount.get(userName) ?? 0) + 1;
    if (retries >= MAX_PUSH_RETRIES) {
      logger.warn({ userName, retries }, "[MorningPush] Max retries reached — giving up for today");
      _retryCount.delete(userName);
      // Don't release slot — leave push_sent_at set so we don't retry again today
    } else {
      _retryCount.set(userName, retries);
      logger.info({ userName, retries }, "[MorningPush] Push delivery failed — releasing slot for retry next tick");
      await releaseMorningPushSlot(userName).catch(() => {});
    }
    return;
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
    const localTime = getCurrentTimeForUser(user);
    const today = getLocalDateForUser(user);

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
            await sendFcmNotification({
              userName,
              notificationType: "midday-news",
              title: "Breaking News",
              body: story,
            });
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
    users = [{ userName: NATIVE_STORED_NAME, name: NATIVE_STORED_NAME, city: null, timezone: DEFAULT_TZ, wakeTime: DEFAULT_WAKE_TIME, companionName: null }];
  }

  for (const user of users) {
    const { userName } = user;

    // Restore push-sent state from DB (survives restarts) so we don't re-send.
    await loadStaticContextFromDb(userName).catch(() => false);

    // If we're inside the wake window AND the push hasn't been sent yet (restart
    // happened before the push could fire), send it now immediately rather than
    // waiting for the next per-minute tick.
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
  }
}

// ── On-demand push: called when a push token is freshly registered ─────────────
// If the user opens the app during the wake window and the morning push was never
// delivered (because no token was registered at 6 AM), send it now immediately.

export async function maybeSendMorningPushOnTokenRegistration(userName: string): Promise<void> {
  if (wasPushSentToday(userName)) return;

  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch {
    return;
  }

  const user = users.find((u) => u.userName === userName);
  if (!user) return;

  const wakeTime = user.wakeTime ?? DEFAULT_WAKE_TIME;
  const localTime = getCurrentTimeForUser(user);
  const minsSince = minutesSinceWake(localTime, wakeTime);

  if (minsSince >= 0 && minsSince <= WAKE_WINDOW_MINUTES) {
    logger.info(
      { userName, minsSince },
      "[MorningPush] Token registered during wake window — sending missed morning push"
    );
    sendMorningPush(user, wakeTime).catch((err) =>
      logger.warn({ err, userName }, "[MorningPush] Token-triggered push failed")
    );
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
