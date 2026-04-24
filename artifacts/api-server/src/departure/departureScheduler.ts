import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
import {
  estimateDriveTime,
  shouldFireAlert,
  buildDepartureAlertMessage,
  extractEventLocation,
} from "./departureManager.js";
import { fetchTodayEvents } from "../google/calendar.js";
import { query } from "../db.js";

// ── Schema migration: add user_name to departure_alert_log if missing ─────────
query(`ALTER TABLE departure_alert_log ADD COLUMN IF NOT EXISTS user_name text NOT NULL DEFAULT 'davidblakelock'`)
  .catch(() => {});

const TZ = "America/Chicago";

async function getCompanionName(userName: string): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  return profile?.companionName ?? "Your Companion";
}

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── In-memory set to avoid double-firing ─────────────────────────────────────
const _alertedToday = new Set<string>();

async function hasAlertBeenSent(eventTitle: string, eventDate: string, userName: string): Promise<boolean> {
  const key = `${userName}::${eventTitle}::${eventDate}`;
  if (_alertedToday.has(key)) return true;

  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM departure_alert_log
       WHERE event_title = $1 AND event_date = $2 AND user_name = $3`,
      [eventTitle, eventDate, userName]
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventTitle: string, eventDate: string, userName: string): Promise<void> {
  const key = `${userName}::${eventTitle}::${eventDate}`;
  _alertedToday.add(key);

  try {
    await query(
      `INSERT INTO departure_alert_log (event_title, event_date, user_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [eventTitle, eventDate, userName]
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

// ── Per-user check ────────────────────────────────────────────────────────────
async function checkDepartureAlertsForUser(userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  const displayName = profile?.name ?? userName;
  const homeAddress = profile?.homeAddress ?? ((profile?.rawData as CollectedData)?.homeAddress) ?? "";
  const homeLat = (profile?.homeLatitude && profile.homeLatitude !== 0 ? profile.homeLatitude : null)
    ?? (profile?.latitude && profile.latitude !== 0 ? profile.latitude : null)
    ?? 32.7767;
  const homeLon = (profile?.homeLongitude && profile.homeLongitude !== 0 ? profile.homeLongitude : null)
    ?? (profile?.longitude && profile.longitude !== 0 ? profile.longitude : null)
    ?? -96.7970;

  if (!homeAddress) {
    logger.warn({ userName }, "Departure check skipped — no home address in profile");
    return;
  }

  let events: Awaited<ReturnType<typeof fetchTodayEvents>>;
  try {
    events = await fetchTodayEvents(userName);
  } catch {
    return;
  }

  if (!events) return;

  const now = new Date();
  const today = localDateStr();

  for (const event of events) {
    if (!event.summary || event.allDay || !event.startIso) continue;
    const start = new Date(event.startIso);

    const minutesUntilEvent = (start.getTime() - now.getTime()) / 60000;
    // Pre-filter: allow up to 4 hours out so long drives (up to ~3.5h) are covered.
    if (minutesUntilEvent < 0 || minutesUntilEvent > 240) continue;

    const location = extractEventLocation({
      summary: event.summary,
      location: event.location,
      description: event.description,
    });
    if (!location) {
      logger.info({ event: event.summary, userName }, "Departure check: event has no location — skipping");
      continue;
    }

    const alreadySent = await hasAlertBeenSent(event.summary, today, userName);
    if (alreadySent) continue;

    const drive = await estimateDriveTime(location, homeAddress, homeLat, homeLon);
    if (!drive) continue;

    const fire = shouldFireAlert(start, drive.durationMinutes, now);
    if (!fire) continue;

    const message = buildDepartureAlertMessage(
      event.summary,
      start,
      drive.durationMinutes,
      location,
      drive.source === "google-maps",
      displayName
    );

    const companionName = await getCompanionName(userName);

    const mapsUrl =
      `https://www.google.com/maps/dir/?api=1` +
      `&origin=${encodeURIComponent(homeAddress)}` +
      `&destination=${encodeURIComponent(location)}` +
      `&travelmode=driving`;

    const eventTimeStr = start.toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const roundedMins = Math.round(drive.durationMinutes / 5) * 5;
    const pushBody = `~${roundedMins} min drive · ${eventTimeStr}${location.length < 60 ? ` · ${location}` : ""}`;

    broadcastToUser(userName, "reminder", {
      id: `departure-${event.summary}-${Date.now()}`,
      userName,
      reminderText: message,
      speakText: message,
      isDeparture: true,
    });

    await sendPushToAll({
      title: `🚗 Leave now — ${event.summary}`,
      body: pushBody,
      tag: `departure-${userName}-${event.summary}`,
      url: mapsUrl,          // used by web push click action
      mapsUrl,               // passed to native app via Expo data so it can open Maps
      notificationType: "departure",
      requireInteraction: true,
    }, userName).catch(() => {});

    await markAlertSent(event.summary, today, userName);

    logger.info(
      { event: event.summary, driveMinutes: drive.durationMinutes, source: drive.source, userName },
      "Departure alert fired"
    );
  }
}

// ── Main scheduler check ──────────────────────────────────────────────────────
async function checkDepartureAlerts(): Promise<void> {
  clearIfNewDay();
  try {
    const users = await getActiveUsers();
    if (users.length === 0) return;
    await Promise.allSettled(users.map((u) => checkDepartureAlertsForUser(u.userName)));
  } catch (err) {
    logger.warn({ err }, "Departure scheduler: failed to load active users");
  }
}

export function startDepartureScheduler(): void {
  cron.schedule("*/2 * * * *", async () => {
    try {
      await checkDepartureAlerts();
    } catch (err) {
      logger.error({ err }, "Departure scheduler error");
    }
  });

  logger.info("Departure alert scheduler started");
}
