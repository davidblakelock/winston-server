import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile } from "../onboarding/onboardingManager.js";
import { query } from "../db.js";

const DEFAULT_LAT = 32.7767;
const DEFAULT_LON = -96.797;

function buildNwsAlertsUrl(lat: number, lon: number): string {
  return `https://api.weather.gov/alerts/active?point=${lat},${lon}&status=actual&message_type=alert`;
}

const SEVERE_EVENTS = [
  "Tornado Warning",
  "Tornado Watch",
  "Severe Thunderstorm Warning",
  "Flash Flood Warning",
  "Flash Flood Emergency",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Extreme Cold Warning",
  "Excessive Heat Warning",
  "Dust Storm Warning",
];

// ── Database-backed deduplication ─────────────────────────────────────────────
// In-memory set is gone — all deduplication is now in the DB so server restarts
// (deployments, crashes, etc.) never re-send an alert that was already pushed.
// We also keep an in-process cache to avoid a DB round-trip on every poll.
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
  // Fast in-process check first
  const cache = _memCache.get(userName);
  if (cache?.has(alertId)) return true;

  // DB check — source of truth across restarts
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM weather_alert_log WHERE user_name = $1 AND alert_id = $2 LIMIT 1`,
    [userName, alertId]
  );
  return rows.length > 0;
}

async function markSent(userName: string, alertId: string, event: string): Promise<void> {
  // Write to DB
  await query(
    `INSERT INTO weather_alert_log (user_name, alert_id, event)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_name, alert_id) DO NOTHING`,
    [userName, alertId, event]
  );
  // Update in-process cache
  if (!_memCache.has(userName)) _memCache.set(userName, new Set());
  _memCache.get(userName)!.add(alertId);
}

interface NWSAlert {
  id: string;
  properties: {
    event: string;
    headline?: string;
    description: string;
    effective: string;
    expires: string;
    severity: string;
    urgency: string;
  };
}

async function checkWeatherAlertsForUser(userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  const lat = profile?.latitude ?? DEFAULT_LAT;
  const lon = profile?.longitude ?? DEFAULT_LON;
  const city = profile?.city ?? "your area";

  const nwsUrl = buildNwsAlertsUrl(lat, lon);
  const response = await fetch(nwsUrl, {
    headers: { "User-Agent": "Winston-AI-Companion/1.0 (winston@winston.app)" },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) return;

  const data = (await response.json()) as { features: Array<{ id: string; properties: NWSAlert["properties"] }> };
  const features = data.features ?? [];

  for (const feature of features) {
    const id = feature.id;

    // Skip if already sent — DB-backed check survives server restarts
    const alreadySent = await wasAlreadySent(userName, id).catch(() => false);
    if (alreadySent) continue;

    const { event, headline, expires, severity, urgency } = feature.properties;

    const isSevere =
      SEVERE_EVENTS.some((e) => event.toLowerCase().includes(e.toLowerCase())) ||
      (severity === "Extreme" && urgency === "Immediate");

    if (!isSevere) continue;

    const expiresAt = new Date(expires);
    if (expiresAt < new Date()) continue;

    // Mark sent BEFORE pushing — avoids duplicate if push itself is slow
    await markSent(userName, id, event).catch((err) => {
      logger.warn({ err, alertId: id }, "Failed to mark weather alert as sent — may duplicate");
    });

    const body = headline
      ? headline.replace(/^\w+,?\s*/, "").slice(0, 120)
      : `${event} in effect for ${city}. Stay safe and check local conditions.`;

    await sendPushToAll({
      title: `⚠️ Weather Alert: ${event}`,
      body,
      tag: `weather-${userName}-${event.replace(/\s+/g, "-").toLowerCase()}`,
      requireInteraction: true,
      notificationType: "weather-alert",
      companionMessage: `There's a ${event} in effect for ${city}. ${body}`,
    }, userName);

    logger.info({ event, alertId: id, userName }, "Weather alert push sent");
  }
}

export function startWeatherAlertScheduler(): void {
  // Create the deduplication table before the first poll
  initAlertLogTable().catch((err) => {
    logger.warn({ err }, "weather_alert_log table init failed — alert deduplication may not work across restarts");
  });

  cron.schedule("*/15 * * * *", async () => {
    try {
      const users = await getActiveUsers();
      if (users.length === 0) return;
      await Promise.allSettled(users.map((u) => checkWeatherAlertsForUser(u.userName)));
    } catch (err) {
      logger.debug({ err }, "Weather alert check failed (non-fatal)");
    }
  });

  logger.info("Weather alert scheduler started");
}
