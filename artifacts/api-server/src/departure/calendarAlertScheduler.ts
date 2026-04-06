import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { fetchTodayEvents, toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

async function hasAlertBeenSent(eventId: string, dateStr: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = 'David' AND message_type = $1 AND sent_date = $2`,
      [`calendar-alert-${eventId}`, dateStr]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventId: string, dateStr: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ('David', $1, $2)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING`,
      [`calendar-alert-${eventId}`, dateStr]
    );
  } catch (err) {
    logger.warn({ err }, "[CAL-ALERT] Failed to mark alert sent");
  }
}

async function runCalendarAlertCheck(): Promise<void> {
  let events: CalendarEvent[] | null;
  try {
    events = await fetchTodayEvents();
  } catch {
    return;
  }
  if (!events || events.length === 0) return;

  const now = new Date();
  const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const today = localDateStr();

  for (const event of events) {
    if (!event.id || !event.startIso || event.allDay) continue;

    const eventStart = new Date(event.startIso);
    // Use CT-converted times for comparison to correctly handle DST boundaries
    const eventStartCT = toChicagoTime(eventStart);
    const nowCT = toChicagoTime(now);
    const twoHoursFromNowCT = toChicagoTime(twoHoursFromNow);

    // Only alert for events starting within the next 2 hours that haven't started yet
    if (eventStartCT.getTime() <= nowCT.getTime() || eventStartCT.getTime() > twoHoursFromNowCT.getTime()) continue;

    const alreadySent = await hasAlertBeenSent(event.id, today);
    if (alreadySent) continue;

    await markAlertSent(event.id, today);

    // Format time in CT 12-hour format for display to David
    const eventTimeStr = eventStart.toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    // Minutes until event calculated from CT-aware timestamps
    const minutesAway = Math.round((eventStartCT.getTime() - nowCT.getTime()) / 60000);
    const timeContext = minutesAway <= 30
      ? `in ${minutesAway} minutes`
      : `at ${eventTimeStr}`;

    const speakText = `Hey David, just a heads-up — you have ${event.summary} ${timeContext}. Want me to remind you when to leave based on traffic?`;

    broadcastToUser("David", "reminder", {
      id: `calendar-alert-${event.id}-${Date.now()}`,
      userName: "David",
      reminderText: speakText,
      speakText,
      isCalendarAlert: true,
    });

    await sendPushToAll({
      title: `📅 Upcoming — ${event.summary}`,
      body: `${event.summary} ${timeContext}. Tap to open Winston.`,
      tag: `cal-alert-${event.id}`,
      requireInteraction: false,
    }).catch(() => {});

    logger.info(
      { event: event.summary, time: eventTimeStr, minutesAway },
      "[CAL-ALERT] Proactive 2-hour event alert sent"
    );
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
