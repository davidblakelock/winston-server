import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { fetchTodayEvents, toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

async function hasAlertBeenSent(eventId: string, dateStr: string, userName: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = $1 AND message_type = $2 AND sent_date = $3`,
      [userName, `calendar-alert-${eventId}`, dateStr]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventId: string, dateStr: string, userName: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING`,
      [userName, `calendar-alert-${eventId}`, dateStr]
    );
  } catch (err) {
    logger.warn({ err }, "[CAL-ALERT] Failed to mark alert sent");
  }
}

async function runCalendarAlertCheckForUser(userName: string): Promise<void> {
  let events: CalendarEvent[] | null;
  try {
    events = await fetchTodayEvents(userName);
  } catch {
    return;
  }
  if (!events || events.length === 0) return;

  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const companionName = profile?.companionName ?? "Your Companion";

  const now = new Date();
  const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const today = localDateStr();

  for (const event of events) {
    if (!event.id || !event.startIso || event.allDay) continue;

    const eventStart = new Date(event.startIso);
    const eventStartCT = toChicagoTime(eventStart);
    const nowCT = toChicagoTime(now);
    const twoHoursFromNowCT = toChicagoTime(twoHoursFromNow);

    if (eventStartCT.getTime() <= nowCT.getTime() || eventStartCT.getTime() > twoHoursFromNowCT.getTime()) continue;

    const alreadySent = await hasAlertBeenSent(event.id, today, userName);
    if (alreadySent) continue;

    await markAlertSent(event.id, today, userName);

    const eventTimeStr = eventStart.toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const minutesAway = Math.round((eventStartCT.getTime() - nowCT.getTime()) / 60000);
    const timeContext = minutesAway <= 30
      ? `in ${minutesAway} minutes`
      : `at ${eventTimeStr}`;

    const speakText = `Hey ${displayName}, just a heads-up — you have ${event.summary} ${timeContext}. Want me to remind you when to leave based on traffic?`;

    broadcastToUser(userName, "reminder", {
      id: `calendar-alert-${event.id}-${Date.now()}`,
      userName,
      reminderText: speakText,
      speakText,
      isCalendarAlert: true,
    });

    await sendPushToAll({
      title: `📅 Upcoming — ${event.summary}`,
      body: `${event.summary} ${timeContext}. Tap to open ${companionName}.`,
      tag: `cal-alert-${event.id}`,
      requireInteraction: false,
    }, userName).catch(() => {});

    logger.info(
      { event: event.summary, time: eventTimeStr, minutesAway, userName },
      "[CAL-ALERT] Proactive 2-hour event alert sent"
    );
  }
}

async function runCalendarAlertCheck(): Promise<void> {
  try {
    const users = await getActiveUsers();
    if (users.length === 0) return;
    await Promise.allSettled(users.map((u) => runCalendarAlertCheckForUser(u.userName)));
  } catch (err) {
    logger.warn({ err }, "[CAL-ALERT] Failed to load active users");
  }
}

export function startCalendarAlertScheduler(): void {
  cron.schedule(
    "0 8-21 * * *",
    async () => {
      try {
        await runCalendarAlertCheck();
      } catch (err) {
        logger.error({ err }, "Calendar alert scheduler error");
      }
    },
    { timezone: TZ }
  );
  logger.info("Calendar alert scheduler (2-hour window) started");
}
