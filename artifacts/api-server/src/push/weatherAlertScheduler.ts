// ── Weather Alert Scheduler ───────────────────────────────────────────────────
// Polls the NOAA/NWS public alerts API every 15 minutes.
// NWS API is free, no API key required, returns stable URN alert IDs,
// and includes full headline + description + instruction text.
//
// Deduplication: each alert URN is stored in weather_alert_log once per user.
// A notification is ONLY sent when a new alertId (URN) is seen for the first time.
// The scheduler NEVER re-fires the same alert — even if it polls 100 times while
// the alert is active.

import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile } from "../onboarding/onboardingManager.js";
import { query } from "../db.js";

const DEFAULT_LAT = 32.7767;
const DEFAULT_LON = -96.797;

// ── NWS API types ─────────────────────────────────────────────────────────────

interface NWSAlertProperties {
  id: string;          // URN — stable, unique per event
  event: string;       // e.g. "Tornado Warning"
  headline?: string;   // e.g. "Tornado Warning issued April 29 at 6PM CDT"
  description?: string;
  instruction?: string;
  severity: string;    // "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown"
  urgency: string;     // "Immediate" | "Expected" | "Future" | "Past" | "Unknown"
  certainty: string;   // "Observed" | "Likely" | "Possible" | "Unlikely"
  areaDesc?: string;   // e.g. "Dallas County"
  expires?: string;    // ISO date-time string
  status?: string;     // "Actual" | "Exercise" | "System" | "Test" | "Draft"
  messageType?: string;// "Alert" | "Update" | "Cancel"
}

interface NWSFeature {
  id: string;
  properties: NWSAlertProperties;
}

// ── Severity filter ───────────────────────────────────────────────────────────
// Notify for: Extreme severity OR (Severe + Immediate urgency).
// Also always notify for specific life-threatening event types regardless.

const ALWAYS_NOTIFY_EVENTS = new Set([
  "Tornado Warning",
  "Tornado Emergency",
  "Flash Flood Emergency",
  "Flash Flood Warning",
  "Severe Thunderstorm Warning",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Blizzard Warning",
  "Excessive Heat Warning",
  "Extreme Cold Warning",
  "Dust Storm Warning",
  "Hurricane Warning",
  "Hurricane Watch",
  "Tropical Storm Warning",
  "Tsunami Warning",
  "Tsunami Watch",
  // Air quality — NWS reports these with Severity: Unknown / Urgency: Unknown
  // so they are never caught by the severity filter; must be explicit.
  "Air Quality Alert",
  "Air Quality Advisory",
  "Smoke Advisory",
  "Dense Smoke Advisory",
  "Ozone Action Day Statement",
  "Hazardous Weather Outlook",
]);

function isSevereAlert(props: NWSAlertProperties): boolean {
  // Skip test/exercise messages
  if (props.status && props.status !== "Actual") return false;
  // Skip cancellations (messageType "Cancel" means the alert was lifted)
  if (props.messageType === "Cancel") return false;
  // Always notify for life-threatening event types
  if (ALWAYS_NOTIFY_EVENTS.has(props.event)) return true;
  // Extreme severity → always notify
  if (props.severity === "Extreme") return true;
  // Severe + Immediate urgency → notify
  if (props.severity === "Severe" && props.urgency === "Immediate") return true;
  return false;
}

// ── Database-backed deduplication ─────────────────────────────────────────────
// Keyed on the stable NWS alert URN. Once stored, never re-fires.

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
  // Add full_text and area columns so the chat handler can inject NWS details
  await query(`ALTER TABLE weather_alert_log ADD COLUMN IF NOT EXISTS full_text text`);
  await query(`ALTER TABLE weather_alert_log ADD COLUMN IF NOT EXISTS area text`);
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

async function markSent(
  userName: string,
  alertId: string,
  event: string,
  fullText?: string,
  area?: string
): Promise<void> {
  await query(
    `INSERT INTO weather_alert_log (user_name, alert_id, event, full_text, area)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_name, alert_id) DO NOTHING
     RETURNING user_name`,
    [userName, alertId, event, fullText ?? null, area ?? null]
  );
  if (!_memCache.has(userName)) _memCache.set(userName, new Set());
  _memCache.get(userName)!.add(alertId);
}

// ── Export: fetch most recent alert details for chat context injection ─────────
// Called by chatHandlerCore when a weather-alert message is detected.
// Returns the full NWS text + event name from the most recent alert sent within
// the last 24 hours, or null if none exists.
export async function getRecentAlertContext(
  userName: string
): Promise<{ event: string; fullText: string; area: string } | null> {
  const { rows } = await query<{ event: string; full_text: string; area: string }>(
    `SELECT event, full_text, area
     FROM weather_alert_log
     WHERE user_name = $1
       AND full_text IS NOT NULL
       AND sent_at > NOW() - INTERVAL '24 hours'
     ORDER BY sent_at DESC
     LIMIT 1`,
    [userName]
  );
  if (!rows.length || !rows[0].full_text) return null;
  return {
    event:    rows[0].event   ?? "Weather Alert",
    fullText: rows[0].full_text,
    area:     rows[0].area    ?? "your area",
  };
}

// ── NWS API fetch ─────────────────────────────────────────────────────────────

async function fetchNWSAlerts(lat: number, lon: number): Promise<NWSFeature[]> {
  // NWS requires 4 decimal places of precision and a descriptive User-Agent
  const url = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "WinstonAICompanion/1.0 (https://winston-companion--davidblakelock.replit.app)",
      "Accept": "application/geo+json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    logger.warn({ status: response.status, url }, "[WeatherAlerts] NWS API error");
    return [];
  }

  const data = (await response.json()) as { features?: NWSFeature[] };
  return data.features ?? [];
}

// ── Per-user alert check ──────────────────────────────────────────────────────

async function checkWeatherAlertsForUser(userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  const lat = profile?.latitude ?? DEFAULT_LAT;
  const lon = profile?.longitude ?? DEFAULT_LON;
  const city = profile?.city ?? "your area";

  let features: NWSFeature[];
  try {
    features = await fetchNWSAlerts(lat, lon);
  } catch (err) {
    logger.warn({ err }, "[WeatherAlerts] NWS fetch failed");
    return;
  }

  for (const feature of features) {
    const props = feature.properties;
    const alertId = props.id;

    if (!alertId) continue;
    if (!isSevereAlert(props)) continue;

    const alreadySent = await wasAlreadySent(userName, alertId).catch(() => false);
    if (alreadySent) continue;

    const areaLabel = props.areaDesc ?? city;
    const headline = props.headline ?? `${props.event} in effect for ${areaLabel}`;

    // Include the full NWS description + instruction so the native app can show it
    const fullAlertText = [
      headline,
      props.description ? `\n${props.description.trim()}` : "",
      props.instruction ? `\nINSTRUCTIONS: ${props.instruction.trim()}` : "",
    ].filter(Boolean).join("");

    // Mark sent BEFORE pushing to avoid duplicates if push is slow or retried
    await markSent(userName, alertId, props.event, fullAlertText, areaLabel).catch((err) => {
      logger.warn({ err, alertId }, "[WeatherAlerts] Failed to mark alert as sent — may duplicate");
    });

    // Short body for the notification banner (push char limit ~110 chars)
    const notifBody = headline.length > 110 ? `${headline.slice(0, 107)}…` : headline;

    await sendPushToAll({
      title: `⚠️ ${props.event}`,
      body: notifBody,
      tag: `weather-${userName}-${alertId.replace(/[^a-zA-Z0-9]/g, "-")}`,
      requireInteraction: true,
      notificationType: "weather-alert",
      // Full NWS text for the native weather screen
      alertHeadline: headline,
      alertDescription: props.description ?? "",
      alertInstruction: props.instruction ?? "",
      alertEvent: props.event,
      alertArea: areaLabel,
      alertExpires: props.expires ?? "",
      // autoSendMessage causes the app to immediately send this as the user's message
      // when the notification is tapped — Winston gives contextual safety guidance.
      autoSendMessage: `There's a ${props.event} in effect for ${areaLabel}. What should I know and are there any actions I should take?`,
      companionMessage: fullAlertText,
      // Open to the weather screen at the user's saved location
      useCurrentLocation: false,
      alertLat: lat,
      alertLon: lon,
      alertCity: city,
    }, userName);

    logger.info({ event: props.event, alertId, area: areaLabel, userName }, "[WeatherAlerts] Push sent");
  }
}

// ── Scheduler (every 15 minutes) ─────────────────────────────────────────────

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

  logger.info("[WeatherAlerts] Scheduler started (NWS public alerts API, every 15 min, dedup by alert URN)");
}
