import cron from "node-cron";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { getWatchedShows } from "./showManager.js";
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

export async function startTvEpisodeScheduler(): Promise<void> {
  try {
    await initTable();
    logger.info("[TVEpisode] Dedup table ready");
  } catch (err) {
    logger.warn({ err }, "[TVEpisode] Failed to init dedup table — scheduler will still start");
  }

  // 9:00 AM CT daily — streaming services have all dropped by this time
  cron.schedule("0 9 * * *", async () => {
    logger.info("[TVEpisode] Daily check starting");
    let users;
    try {
      users = await getActiveUsers();
    } catch (err) {
      logger.warn({ err }, "[TVEpisode] Failed to load users — skipping");
      return;
    }
    for (const user of users) {
      await checkEpisodesForUser(user.userName).catch((err) => {
        logger.warn({ err, userName: user.userName }, "[TVEpisode] Per-user check failed");
      });
    }
  });

  // Startup catch-up: if the server starts after 9 AM CT and today's check hasn't run yet,
  // fire it now. Dedup prevents double-sends if it already ran in an earlier instance.
  const nowHour = parseInt(
    new Date().toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", hour12: false }),
    10
  );
  if (nowHour >= 9 && nowHour < 20) {
    logger.info({ nowHour }, "[TVEpisode] Startup catch-up — running today's episode check");
    getActiveUsers()
      .then((users) =>
        Promise.all(users.map((u) => checkEpisodesForUser(u.userName).catch(() => {})))
      )
      .catch((err) => logger.warn({ err }, "[TVEpisode] Startup catch-up failed"));
  }

  logger.info("[TVEpisode] Scheduler started — runs daily at 9:00 AM CT");
}
