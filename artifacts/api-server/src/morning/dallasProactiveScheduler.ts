/**
 * Proactive local content scheduler — once per day around 9 AM CT,
 * checks for high-priority local items (new restaurant openings, sports news)
 * and sends a gentle SSE + push notification to each active user.
 *
 * Phase 6: loops over all active users; uses their name in notifications;
 * only sends to users whose city matches the local content source (Dallas for now).
 */

import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { logger } from "../lib/logger.js";
import { getTodayHighPriorityItems, getLocalContentCity } from "./dallasContent.js";
import { query } from "../db.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";

const DALLAS_CITY_PATTERN = /dallas|tx|texas/i;

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
}

async function hasBeenSentToday(userName: string, key: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = $1 AND message_type = $2 AND sent_date = $3`,
      [userName, key, todayStr()]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markSent(userName: string, key: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING
       RETURNING user_name`,
      [userName, key, todayStr()]
    );
  } catch (err) {
    logger.warn({ err, userName }, "[Dallas Proactive] Failed to mark sent");
  }
}

function buildNotificationText(
  item: { source: string; headline: string; summary: string; priority: string },
  displayName: string
): string {
  const isRestaurant = item.priority === "high" && /restaurant|opening|opened|dining/i.test(item.headline + item.summary);
  const isSports = /rangers|cowboys|mavericks|stars|fc dallas/i.test(item.headline + item.summary);

  if (isRestaurant) {
    return `Hey ${displayName} — ${item.source} just wrote up a new spot that might interest you: ${item.headline}. ${item.summary ? item.summary.slice(0, 120) : ""}`.trim();
  }
  if (isSports) {
    return `${displayName} — quick local sports note from ${item.source}: ${item.headline}. ${item.summary ? item.summary.slice(0, 100) : ""}`.trim();
  }
  return `Hey ${displayName} — something local worth knowing from ${item.source}: ${item.headline}. ${item.summary ? item.summary.slice(0, 120) : ""}`.trim();
}

async function runDallasProactiveCheck(): Promise<void> {
  logger.info("[Dallas Proactive] Checking for high-priority items");

  let highItems: Awaited<ReturnType<typeof getTodayHighPriorityItems>>;
  try {
    highItems = await getTodayHighPriorityItems();
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] Failed to get high-priority items");
    return;
  }

  if (highItems.length === 0) {
    logger.info("[Dallas Proactive] No high-priority items today — skipping");
    return;
  }

  const top = highItems[0];
  const dedupKey = `dallas-proactive-${todayStr()}`;
  const contentCity = getLocalContentCity();

  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] Failed to load active users");
    return;
  }

  // Only notify users who are in a Dallas-area city (or have no city set — default is Dallas)
  const targetUsers = users.filter(
    (u) => !u.city || DALLAS_CITY_PATTERN.test(u.city)
  );

  if (targetUsers.length === 0) {
    logger.info("[Dallas Proactive] No Dallas-area users to notify");
    return;
  }

  for (const user of targetUsers) {
    const { userName } = user;
    const displayName = user.name ?? userName;

    if (await hasBeenSentToday(userName, dedupKey)) {
      logger.info({ userName }, "[Dallas Proactive] Already sent today — skipping");
      continue;
    }

    const text = buildNotificationText(top, displayName);
    if (!text) continue;

    try {
      broadcastToUser(userName, "proactive", { message: text, type: "dallas" });
      logger.info({ userName }, `[Dallas Proactive] SSE sent: "${text.slice(0, 80)}..."`);
    } catch (err) {
      logger.warn({ err, userName }, "[Dallas Proactive] SSE broadcast failed");
    }

    // Push notifications suppressed — Dallas content surfaces in morning briefing only
    await markSent(userName, dedupKey);
  }
}

export function startDallasProactiveScheduler(): void {
  // Run once at 9:15 AM CT — after the morning briefing has been delivered
  // so users aren't doubled-up with content right at wake-up.
  cron.schedule("15 9 * * *", () => {
    void runDallasProactiveCheck();
  });

  logger.info("[Dallas Proactive] Scheduler started (runs daily 9:15 AM CT)");
}
