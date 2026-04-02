import cron from "node-cron";
import { sendPushToAll } from "./pushManager.js";
import { logger } from "../lib/logger.js";

const NWS_ALERTS_URL =
  "https://api.weather.gov/alerts/active?point=32.7767,-96.7970&status=actual&message_type=alert";

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

const _sentAlertIds = new Set<string>();

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

export function startWeatherAlertScheduler(): void {
  // Check every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    try {
      const response = await fetch(NWS_ALERTS_URL, {
        headers: { "User-Agent": "Winston-AI-Companion/1.0 (emma@winston.app)" },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return;

      const data = (await response.json()) as { features: Array<{ id: string; properties: NWSAlert["properties"] }> };
      const features = data.features ?? [];

      for (const feature of features) {
        const id = feature.id;
        if (_sentAlertIds.has(id)) continue;

        const { event, headline, expires, severity, urgency } = feature.properties;

        // Only fire for severe/extreme events
        const isSevere =
          SEVERE_EVENTS.some((e) => event.toLowerCase().includes(e.toLowerCase())) ||
          (severity === "Extreme" && urgency === "Immediate");

        if (!isSevere) continue;

        // Check if the alert is still valid
        const expiresAt = new Date(expires);
        if (expiresAt < new Date()) continue;

        _sentAlertIds.add(id);

        const body = headline
          ? headline.replace(/^\w+,?\s*/, "").slice(0, 120)
          : `${event} in effect for Dallas. Stay safe and check local conditions.`;

        await sendPushToAll({
          title: `⚠️ Weather Alert: ${event}`,
          body,
          tag: `weather-${event.replace(/\s+/g, "-").toLowerCase()}`,

          requireInteraction: true,
        });

        logger.info({ event, alertId: id }, "Weather alert push sent");
      }
    } catch (err) {
      // Silently handle — network issues shouldn't crash the scheduler
      logger.debug({ err }, "Weather alert check failed (non-fatal)");
    }
  });

  logger.info("Weather alert scheduler started");
}
