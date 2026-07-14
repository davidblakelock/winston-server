/**
 * Proactive event scheduler — once per day around 9 AM CT, finds the single
 * best upcoming local event for each active user (via apifyEventsManager's
 * Ticketmaster search, personalized to their favorite artists/interests) and
 * sends a push notification + SSE broadcast if a genuine match is found.
 *
 * Dedup is keyed on (user_name, event name + date) via proactive_message_log,
 * not just the calendar day the check ran on — so a second show by the same
 * artist on a different date still gets notified, but the same show never
 * fires twice even across multiple daily runs while it remains upcoming.
 */

import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { getActiveUsers, getProfile, type ActiveUser } from "../onboarding/onboardingManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { fetchBestLocalEvent, type LocalEvent } from "../events/apifyEventsManager.js";

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function eventKey(event: LocalEvent): string {
  return `event:${event.name}:${event.dateISO}`;
}

// Checks whether this exact event (by name + date) has EVER been notified to
// this user — deliberately not scoped to today's date, so the same show
// never fires twice across multiple daily runs while it remains upcoming.
async function hasEventBeenNotified(userName: string, key: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = $1 AND message_type = $2`,
      [userName, key]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markEventNotified(userName: string, key: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING
       RETURNING user_name`,
      [userName, key, todayStr()]
    );
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Event] Failed to mark sent");
  }
}

async function checkUserForEvent(user: ActiveUser): Promise<void> {
  const { userName } = user;

  const profile = await getProfile(userName).catch(() => null);
  const location = await getUserLocationContext(userName).catch(() => null);
  const city = location?.city ?? profile?.city ?? "";
  if (!city) {
    logger.info({ userName }, "[Proactive Event] No known city — skipping");
    return;
  }

  const favoriteArtists = profile?.favoriteArtists ?? [];
  const userInterests = [
    ...(profile?.sportsTeams ? profile.sportsTeams.split(",").map((s) => s.trim()) : []),
    ...(profile?.hobbies ?? []),
    ...(profile?.musicGenres ?? []),
  ].filter(Boolean);

  const result = await fetchBestLocalEvent(city, userInterests, userName, favoriteArtists);
  const event = result.event;
  if (!event) return;

  const key = eventKey(event);
  if (await hasEventBeenNotified(userName, key)) {
    logger.info({ userName, event: event.name }, "[Proactive Event] Already notified for this event — skipping");
    return;
  }

  const eventDateLabel = event.date || event.dateISO;
  const title = `🎵 ${event.name} is coming to ${city}!`;
  const saleInfo = event.ticketSaleDate ? ` Tickets go on sale ${event.ticketSaleDate}.` : "";
  const body = `${eventDateLabel} at ${event.venue}.${saleInfo}`;

  const message =
    `Tell me more about ${event.name} at ${event.venue} on ${eventDateLabel}. ` +
    `Are tickets available? Ticket sale date is ${event.ticketSaleDate ?? "not known"}. Should I set a reminder?`;

  try {
    await sendFcmNotification({
      userName,
      notificationType: "proactive_event",
      title,
      body,
      data: {
        action: "send_message",
        message,
        eventName: event.name,
        venue: event.venue,
        date: eventDateLabel,
        ticketUrl: event.url,
        ticketSaleDate: event.ticketSaleDate ?? "",
      },
    });
    logger.info({ userName, event: event.name }, "[Proactive Event] Push sent");
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Event] Push send failed");
  }

  try {
    broadcastToUser(userName, "proactive", { message: body, type: "event" });
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Event] SSE broadcast failed");
  }

  await markEventNotified(userName, key);
}

async function runProactiveEventCheck(): Promise<void> {
  logger.info("[Proactive Event] Checking for personalized local events");

  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[Proactive Event] Failed to load active users");
    return;
  }

  for (const user of users) {
    try {
      await checkUserForEvent(user);
    } catch (err) {
      logger.warn({ err, userName: user.userName }, "[Proactive Event] Per-user check failed");
    }
  }
}

export function startProactiveEventScheduler(): void {
  // Run once at 9:15 AM CT — after the morning briefing has been delivered
  // so users aren't doubled-up with content right at wake-up.
  cron.schedule("15 9 * * *", () => {
    void runProactiveEventCheck();
  });

  logger.info("[Proactive Event] Scheduler started (runs daily 9:15 AM CT)");
}
