import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile } from "../onboarding/onboardingManager.js";

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

// Per-user sent alert ID sets to avoid duplicate pushes
const _sentAlertIds = new Map<string, Set<string>>();

function getUserSentIds(userName: string): Set<string> {
  if (!_sentAlertIds.has(userName)) _sentAlertIds.set(userName, new Set());
  return _sentAlertIds.get(userName)!;
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
  const sentIds = getUserSentIds(userName);

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
    if (sentIds.has(id)) continue;

    const { event, headline, expires, severity, urgency } = feature.properties;

    const isSevere =
      SEVERE_EVENTS.some((e) => event.toLowerCase().includes(e.toLowerCase())) ||
      (severity === "Extreme" && urgency === "Immediate");

    if (!isSevere) continue;

    const expiresAt = new Date(expires);
    if (expiresAt < new Date()) continue;

    sentIds.add(id);

    const body = headline
      ? headline.replace(/^\w+,?\s*/, "").slice(0, 120)
      : `${event} in effect for ${city}. Stay safe and check local conditions.`;

    await sendPushToAll({
      title: `⚠️ Weather Alert: ${event}`,
      body,
      tag: `weather-${userName}-${event.replace(/\s+/g, "-").toLowerCase()}`,
      requireInteraction: true,
    }, userName);

    logger.info({ event, alertId: id, userName }, "Weather alert push sent");
  }
}

export function startWeatherAlertScheduler(): void {
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
