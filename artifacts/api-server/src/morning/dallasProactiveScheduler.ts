/**
 * Proactive Dallas content scheduler — once per day around 9 AM CT,
 * checks for high-priority local items (new restaurant openings in David's
 * preferred neighborhoods, Rangers/Cowboys news) and sends a gentle SSE +
 * push notification if something particularly relevant came through.
 */

import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getTodayHighPriorityItems } from "./dallasContent.js";
import { query } from "../db.js";

const TZ = "America/Chicago";
const USER = "David";

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

async function hasBeenSentToday(key: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = $1 AND message_type = $2 AND sent_date = $3`,
      [USER, key, todayStr()]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markSent(key: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING`,
      [USER, key, todayStr()]
    );
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] Failed to mark sent");
  }
}

/** Build a warm, conversational notification text for the item */
function buildNotificationText(item: { source: string; headline: string; summary: string; priority: string }): string {
  const isRestaurant = item.priority === "high" && /restaurant|opening|opened|dining/i.test(item.headline + item.summary);
  const isSports = /rangers|cowboys|mavericks|stars|fc dallas/i.test(item.headline + item.summary);

  if (isRestaurant) {
    return `Hey David — ${item.source} just wrote up a new spot that might interest you: ${item.headline}. ${item.summary ? item.summary.slice(0, 120) : ""}`.trim();
  }
  if (isSports) {
    return `David — quick local sports note from ${item.source}: ${item.headline}. ${item.summary ? item.summary.slice(0, 100) : ""}`.trim();
  }
  return `Hey David — something local worth knowing from ${item.source}: ${item.headline}. ${item.summary ? item.summary.slice(0, 120) : ""}`.trim();
}

async function runDallasProactiveCheck(): Promise<void> {
  logger.info("[Dallas Proactive] Checking for high-priority items to notify about");

  let highItems: Awaited<ReturnType<typeof getTodayHighPriorityItems>>;
  try {
    highItems = await getTodayHighPriorityItems();
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] Failed to get high-priority items");
    return;
  }

  if (highItems.length === 0) {
    logger.info("[Dallas Proactive] No high-priority Dallas items today — skipping");
    return;
  }

  // Send at most 1 proactive notification per day (the best high-priority item)
  const top = highItems[0];
  const dedupKey = `dallas-proactive-${todayStr()}`;

  if (await hasBeenSentToday(dedupKey)) {
    logger.info("[Dallas Proactive] Already sent today — skipping");
    return;
  }

  const text = buildNotificationText(top);
  if (!text) return;

  // SSE to all connected clients
  try {
    broadcastToUser(USER, "proactive", { message: text, type: "dallas" });
    logger.info(`[Dallas Proactive] SSE sent: "${text.slice(0, 80)}..."`);
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] SSE broadcast failed");
  }

  // Push notification
  try {
    await sendPushToAll(USER, "Winston — What's Happening in Dallas", text);
    logger.info("[Dallas Proactive] Push sent");
  } catch (err) {
    logger.warn({ err }, "[Dallas Proactive] Push failed (non-fatal)");
  }

  await markSent(dedupKey);
}

export function startDallasProactiveScheduler(): void {
  // Run once at 9:15 AM CT — after the morning briefing has been delivered
  // so David isn't doubled-up with content right at wake-up.
  cron.schedule("15 9 * * *", () => {
    void runDallasProactiveCheck();
  }, { timezone: TZ });

  logger.info("[Dallas Proactive] Scheduler started (runs daily 9:15 AM CT)");
}
