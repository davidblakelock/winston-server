import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile } from "../onboarding/onboardingManager.js";
import { query } from "../db.js";

const DEFAULT_LAT = 32.7767;
const DEFAULT_LON = -96.797;

// ── Google Weather publicAlerts endpoint ─────────────────────────────────────

interface GoogleWeatherAlert {
  alertId?: string;
  alertTitle?: { text?: string; languageCode?: string };
  eventType?: string;
  areaName?: string;
}

function buildAlertsUrl(lat: number, lon: number, apiKey: string): string {
  return `https://weather.googleapis.com/v1/publicAlerts:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lon}`;
}

// ── Severe event types to push notifications for ──────────────────────────────
// Using Google's eventType enum values (uppercase). All other alerts are silently skipped.
const SEVERE_EVENT_TYPES = new Set([
  "TORNADO",
  "FLASH_FLOOD",
  "SEVERE_THUNDERSTORM",
  "WINTER_STORM",
  "ICE_STORM",
  "BLIZZARD",
  "EXTREME_COLD",
  "EXCESSIVE_HEAT",
  "DUST_STORM",
  "HURRICANE",
  "TROPICAL_STORM",
  "TSUNAMI",
  "EARTHQUAKE",
]);

// Secondary keyword match on alertTitle.text for any event types not in the enum above
const SEVERE_TITLE_KEYWORDS = [
  "tornado",
  "flash flood",
  "severe thunderstorm",
  "winter storm",
  "ice storm",
  "extreme cold",
  "excessive heat",
  "dust storm",
  "hurricane",
  "tropical storm",
  "tsunami",
];

function isSevereAlert(alert: GoogleWeatherAlert): boolean {
  if (alert.eventType && SEVERE_EVENT_TYPES.has(alert.eventType)) return true;
  const title = (alert.alertTitle?.text ?? "").toLowerCase();
  return SEVERE_TITLE_KEYWORDS.some((kw) => title.includes(kw));
}

// ── Database-backed deduplication ─────────────────────────────────────────────

const _memCache = new Map<string, Set<string>>();

async function initAlertLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS weather_alert_log (
      id        integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      user_name text NOT NULL,
      alert_id  text NOT NULL,
      event     text,
      sent_at   timestamptz DEFAULT now(),
      UNIQUE (user_name, alert_id)
    )
  `);
}

async function wasAlreadySent(userName: string, alertId: string): Promise<boolean> {
  const cache = _memCache.get(userName);
  if (cache?.has(alertId)) return true;

  const { rows } = await query<{ id: number }>(
    `SELECT id FROM weather_alert_log WHERE user_name = $1 AND alert_id = $2 LIMIT 1`,
    [userName, alertId]
  );
  return rows.length > 0;
}

async function markSent(userName: string, alertId: string, event: string): Promise<void> {
  await query(
    `INSERT INTO weather_alert_log (user_name, alert_id, event)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_name, alert_id) DO NOTHING`,
    [userName, alertId, event]
  );
  if (!_memCache.has(userName)) _memCache.set(userName, new Set());
  _memCache.get(userName)!.add(alertId);
}

// ── Per-user alert check ──────────────────────────────────────────────────────

async function checkWeatherAlertsForUser(userName: string): Promise<void> {
  const apiKey = process.env.GOOGLE_WEATHER_API;
  if (!apiKey) {
    logger.warn("[WeatherAlerts] GOOGLE_WEATHER_API not configured");
    return;
  }

  const profile = await getProfile(userName).catch(() => null);
  const lat = profile?.latitude ?? DEFAULT_LAT;
  const lon = profile?.longitude ?? DEFAULT_LON;
  const city = profile?.city ?? "your area";

  const response = await fetch(buildAlertsUrl(lat, lon, apiKey), {
    headers: { "User-Agent": "Winston-AI-Companion/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    logger.warn({ status: response.status }, "[WeatherAlerts] Google API error");
    return;
  }

  const data = (await response.json()) as { weatherAlerts?: GoogleWeatherAlert[] };
  const alerts = data.weatherAlerts ?? [];

  for (const alert of alerts) {
    const alertId = alert.alertId;
    if (!alertId) continue;

    const alreadySent = await wasAlreadySent(userName, alertId).catch(() => false);
    if (alreadySent) continue;

    if (!isSevereAlert(alert)) continue;

    const eventTitle = alert.alertTitle?.text ?? alert.eventType ?? "Weather Alert";

    // Mark sent BEFORE pushing to avoid duplicates if push is slow
    await markSent(userName, alertId, eventTitle).catch((err) => {
      logger.warn({ err, alertId }, "[WeatherAlerts] Failed to mark alert as sent — may duplicate");
    });

    const body = `${eventTitle} in effect for ${alert.areaName ?? city}. Stay safe and check local conditions.`;

    await sendPushToAll({
      title: `⚠️ Weather Alert: ${eventTitle}`,
      body,
      tag: `weather-${userName}-${eventTitle.replace(/\s+/g, "-").toLowerCase()}`,
      requireInteraction: true,
      notificationType: "weather-alert",
      companionMessage: `There's a ${eventTitle} in effect for ${alert.areaName ?? city}. ${body}`,
      // Tell the native app to use device GPS when opening the weather screen
      // so the user sees weather for wherever they currently are, not just home.
      useCurrentLocation: true,
      alertLat: lat,
      alertLon: lon,
      alertCity: city,
    }, userName);

    logger.info({ eventTitle, alertId, userName }, "[WeatherAlerts] Push sent");
  }
}

export function startWeatherAlertScheduler(): void {
  initAlertLogTable().catch((err) => {
    logger.warn({ err }, "[WeatherAlerts] weather_alert_log table init failed");
  });

  cron.schedule("*/15 * * * *", async () => {
    try {
      const users = await getActiveUsers();
      if (users.length === 0) return;
      await Promise.allSettled(users.map((u) => checkWeatherAlertsForUser(u.userName)));
    } catch (err) {
      logger.debug({ err }, "[WeatherAlerts] Check failed (non-fatal)");
    }
  });

  logger.info("[WeatherAlerts] Scheduler started (Google Weather publicAlerts, every 15 min)");
}
