import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import { getWatchedShows, backfillMissingTvmazeIds } from "./showManager.js";
import { fetchEpisodesForDate, type ScheduledEpisode } from "./tvmaze.js";
import { sendFcmNotification } from "../push/fcmSender.js";


// ── Dedup table ───────────────────────────────────────────────────────────────

async function initTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS tv_episode_notifications (
      id           SERIAL PRIMARY KEY,
      user_name    TEXT    NOT NULL,
      tvmaze_id    INTEGER NOT NULL,
      episode_label TEXT   NOT NULL,
      notified_date DATE   NOT NULL DEFAULT CURRENT_DATE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_name, tvmaze_id, episode_label)
    )
  `);
}

async function wasNotifiedToday(
  userName: string,
  tvmazeId: number,
  episodeLabel: string
): Promise<boolean> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM tv_episode_notifications
     WHERE user_name = $1 AND tvmaze_id = $2 AND episode_label = $3 AND notified_date = $4`,
    [userName, tvmazeId, episodeLabel, today]
  );
  return rows.length > 0;
}

async function markNotified(
  userName: string,
  tvmazeId: number,
  episodeLabel: string
): Promise<void> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  await query(
    `INSERT INTO tv_episode_notifications (user_name, tvmaze_id, episode_label, notified_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_name, tvmaze_id, episode_label) DO NOTHING`,
    [userName, tvmazeId, episodeLabel, today]
  );
}

// ── Per-user episode check ────────────────────────────────────────────────────

async function checkEpisodesForUser(userName: string): Promise<void> {
  const backfilled = await backfillMissingTvmazeIds(userName).catch((err) => {
    logger.warn({ err, userName }, "[TVEpisode] backfillMissingTvmazeIds failed");
    return 0;
  });
  if (backfilled > 0) {
    logger.info({ userName, backfilled }, "[TVEpisode] Resolved previously-unmatched show(s) to a tvmaze ID");
  }

  const shows = await getWatchedShows(userName);
  const watchedIds = shows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
  if (!watchedIds.length) return;

  let episodes: ScheduledEpisode[];
  try {
    episodes = await fetchEpisodesForDate(new Date(), watchedIds);
  } catch (err) {
    logger.warn({ err, userName }, "[TVEpisode] fetchEpisodesForDate failed — skipping");
    return;
  }

  if (!episodes.length) {
    logger.info({ userName }, "[TVEpisode] No new episodes today");
    return;
  }

  for (const ep of episodes) {
    const alreadySent = await wasNotifiedToday(userName, ep.showId, ep.episodeLabel).catch(() => false);
    if (alreadySent) {
      logger.info({ userName, show: ep.showName, ep: ep.episodeLabel }, "[TVEpisode] Already notified — skipping");
      continue;
    }

    const title = ep.title ? ` — "${ep.title}"` : "";
    const when = ep.airtime ? ` at ${ep.airtime}` : "";
    const network = ep.network ?? "streaming";

    await sendFcmNotification({
      userName,
      notificationType: "tv-episode",
      title: `New ${ep.showName} today 📺`,
      body: `${ep.episodeLabel}${title} is now on ${network}${when}.`,
    }).catch((err) => {
      logger.warn({ err, userName, show: ep.showName }, "[TVEpisode] Push send failed");
    });

    await markNotified(userName, ep.showId, ep.episodeLabel).catch((err) => {
      logger.warn({ err, userName }, "[TVEpisode] markNotified failed");
    });

    logger.info({ userName, show: ep.showName, ep: ep.episodeLabel, network }, "[TVEpisode] Episode push sent");
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Fires once per user, per their own local day, once their local hour reaches
// TARGET_LOCAL_HOUR (streaming services have all dropped new episodes by then).
// Ticking every 5 min and gating on ">= target hour" (rather than an exact-hour
// cron) means a restart or delayed tick still catches the day's check — no
// separate startup catch-up block needed.

const TARGET_LOCAL_HOUR = 9;
// userName -> local date (in that user's own timezone) already checked
const _checkedToday = new Map<string, string>();

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

  await checkEpisodesForUser(user.userName).catch((err) => {
    logger.warn({ err, userName: user.userName }, "[TVEpisode] Per-user check failed");
  });
}

export async function startTvEpisodeScheduler(): Promise<void> {
  try {
    await initTable();
    logger.info("[TVEpisode] Dedup table ready");
  } catch (err) {
    logger.warn({ err }, "[TVEpisode] Failed to init dedup table — scheduler will still start");
  }

  let _running = false;
  cron.schedule("*/5 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers();
      await Promise.allSettled(users.map((user) => runPerUserCheck(user)));
    } catch (err) {
      logger.warn({ err }, "[TVEpisode] Failed to load users — skipping");
    } finally {
      _running = false;
    }
  });

  logger.info("[TVEpisode] Scheduler started — checks every 5 min, fires once per user at their local 9am");
}
