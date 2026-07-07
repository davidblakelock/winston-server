/**
 * localContentNotifier.ts
 *
 * Sends push notifications for high-relevance local content items.
 * Called from the background scheduler after scanLocalContent().
 * Batches notifications — max 2 per run to avoid overwhelming the user.
 */

import { logger } from "../lib/logger.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import {
  getPendingNotifications,
  markNotified,
} from "./localContentManager.js";

const CATEGORY_EMOJIS: Record<string, string> = {
  concert: "🎵",
  restaurant: "🍽️",
  event: "📅",
  sports: "🏆",
  news: "📰",
};

const CATEGORY_LABELS: Record<string, string> = {
  concert: "Live Music",
  restaurant: "New Restaurant",
  event: "Local Event",
  sports: "Sports",
  news: "Local News",
};

/**
 * Send push notifications for pending local content items.
 * Maximum 2 notifications per call to avoid overwhelming the user.
 * Returns the number of notifications sent.
 */
export async function notifyLocalContent(
  userName: string,
  maxNotifications = 2
): Promise<number> {
  const pending = await getPendingNotifications(userName, 70);
  if (pending.length === 0) return 0;

  // Take the top items by relevance score, cap at maxNotifications
  const toNotify = pending.slice(0, maxNotifications);
  let sent = 0;

  for (const item of toNotify) {
    const emoji = CATEGORY_EMOJIS[item.category] ?? "📍";
    const label = CATEGORY_LABELS[item.category] ?? "In Your City";

    const title = `${emoji} ${label} in ${item.city}`;
    const body = item.headline;

    try {
      await sendFcmNotification({
        userName,
        notificationType: "local_content",
        title,
        body,
        data: {
          action: "send_message",
          // Pre-fill a chat message so user can ask Winston for more details
          message: `Tell me more about: ${item.headline}`,
          localContentId: String(item.id),
        },
      });

      await markNotified(item.id);
      sent++;

      logger.info(
        { userName, city: item.city, category: item.category, headline: item.headline, score: item.relevanceScore },
        "[LocalContent] Notification sent"
      );
    } catch (err) {
      logger.warn({ err, id: item.id }, "[LocalContent] Notification failed");
    }
  }

  return sent;
}
