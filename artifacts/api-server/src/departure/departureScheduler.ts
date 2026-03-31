import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import {
  estimateDriveTime,
  shouldFireAlert,
  buildDepartureAlertMessage,
  extractEventLocation,
} from "./departureManager.js";
import { fetchTodayEvents } from "../google/calendar.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── In-memory set to avoid double-firing ─────────────────────────────────────
const _alertedToday = new Set<string>();

async function hasAlertBeenSent(eventTitle: string, eventDate: string): Promise<boolean> {
  const key = `${eventTitle}::${eventDate}`;
  if (_alertedToday.has(key)) return true;

  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM departure_alert_log
       WHERE event_title = $1 AND event_date = $2`,
      [eventTitle, eventDate]
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventTitle: string, eventDate: string): Promise<void> {
  const key = `${eventTitle}::${eventDate}`;
  _alertedToday.add(key);

  try {
    await query(
      `INSERT INTO departure_alert_log (event_title, event_date)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [eventTitle, eventDate]
    );
  } catch {}
}

// ── Clear in-memory set at midnight ──────────────────────────────────────────
let _lastDay: string | null = null;
function clearIfNewDay() {
  const today = localDateStr();
  if (_lastDay !== today) {
    _alertedToday.clear();
    _lastDay = today;
  }
}

// ── Main check ────────────────────────────────────────────────────────────────
async function checkDepartureAlerts(): Promise<void> {
  clearIfNewDay();

  // Only check if Google Calendar is available (we need events with locations)
  let events: Awaited<ReturnType<typeof fetchTodayEvents>>;
  try {
    events = await fetchTodayEvents();
  } catch {
    return; // No calendar access — skip silently
  }

  if (!events) return;

  const now = new Date();
  const today = localDateStr();

  for (const event of events) {
    if (!event.summary) continue;

    // Only process future events (within next 2 hours)
    const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
    if (!start) continue;

    const minutesUntilEvent = (start.getTime() - now.getTime()) / 60000;
    if (minutesUntilEvent < 0 || minutesUntilEvent > 120) continue;

    // Get location from event
    const location = extractEventLocation({
      summary: event.summary,
      location: (event as { location?: string }).location,
      description: (event as { description?: string }).description,
    });

    if (!location) continue;

    const alreadySent = await hasAlertBeenSent(event.summary, today);
    if (alreadySent) continue;

    // Estimate drive time
    const drive = await estimateDriveTime(location);
    if (!drive) continue;

    const fire = shouldFireAlert(start, drive.durationMinutes, now);
    if (!fire) continue;

    const message = buildDepartureAlertMessage(
      event.summary,
      start,
      drive.durationMinutes,
      location,
      drive.source === "osrm"
    );

    broadcast("reminder", {
      id: `departure-${event.summary}-${Date.now()}`,
      userName: "David",
      reminderText: message,
      speakText: message,
      isDeparture: true,
    });

    await sendPushToAll({
      title: "🚗 Time to Leave — Emma Peel",
      body: message,
      tag: `departure-${event.summary}`,
      url: "/",
      requireInteraction: true,
    }).catch(() => {});

    await markAlertSent(event.summary, today);

    logger.info(
      { event: event.summary, driveMinutes: drive.durationMinutes, source: drive.source },
      "Departure alert fired"
    );
  }
}

export function startDepartureScheduler(): void {
  // Check every 2 minutes
  cron.schedule("*/2 * * * *", async () => {
    try {
      await checkDepartureAlerts();
    } catch (err) {
      logger.error({ err }, "Departure scheduler error");
    }
  });

  logger.info("Departure alert scheduler started");
}
