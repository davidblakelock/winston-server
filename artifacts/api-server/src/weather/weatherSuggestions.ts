import type { CachedWeather } from "./weatherCache.js";
import type { CalendarEvent } from "../google/calendar.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type WeatherSuggestionType =
  | "rain_warning"
  | "heat_warning"
  | "cold_warning"
  | "severe_weather"
  | "outdoor_activity_alert";

export interface WeatherSuggestion {
  type: WeatherSuggestionType;
  title: string;
  message: string;
  eventTitle?: string;
  severity: "info" | "warning" | "alert";
}

// ── Outdoor activity keywords ──────────────────────────────────────────────────

const OUTDOOR_KEYWORDS = [
  "golf", "pickleball", "tennis", "run", "walk", "hike", "bike", "cycling",
  "park", "outdoor", "outside", "patio", "pool", "swim", "game", "match",
  "tailgate", "bbq", "barbecue", "beach", "lake", "boat", "fishing", "yard",
  "garden", "mow", "lawn", "soccer", "baseball", "football", "softball",
];

function isOutdoorEvent(title: string): boolean {
  const lower = title.toLowerCase();
  return OUTDOOR_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Severe weather conditions ─────────────────────────────────────────────────

const SEVERE_CONDITIONS = [
  "thunderstorm", "tornado", "hurricane", "blizzard", "ice storm",
  "severe", "hail", "flood", "warning", "watch",
];

function isSevereWeather(condition: string): boolean {
  const lower = condition.toLowerCase();
  return SEVERE_CONDITIONS.some((kw) => lower.includes(kw));
}

// ── Main suggestion builder ───────────────────────────────────────────────────

/**
 * Cross-references today's weather with calendar events to generate actionable suggestions.
 * Called at briefing delivery time after both weather and calendar are available.
 */
export function getWeatherSuggestions(
  weather: CachedWeather,
  events: CalendarEvent[],
): WeatherSuggestion[] {
  const suggestions: WeatherSuggestion[] = [];
  const todayEvents = events.filter((e) => {
    if (!e.startIso) return e.allDay === true;
    const start = new Date(e.startIso);
    const today = new Date();
    return start.toDateString() === today.toDateString();
  });

  const { condition, precipChance, high, low } = weather;

  // ── Severe weather override ─────────────────────────────────────────────────
  if (isSevereWeather(condition)) {
    suggestions.push({
      type: "severe_weather",
      title: "Severe Weather Alert",
      message: `Severe weather conditions (${condition}) — review any outdoor plans today.`,
      severity: "alert",
    });
    return suggestions; // severe weather supercedes everything else
  }

  // ── Rain warning for outdoor events ───────────────────────────────────────
  if (precipChance >= 40) {
    const outdoorEvents = todayEvents.filter((e) => isOutdoorEvent(e.summary ?? ""));
    if (outdoorEvents.length > 0) {
      for (const ev of outdoorEvents) {
        suggestions.push({
          type: "rain_warning",
          title: "Rain Likely — Outdoor Event",
          message: `${precipChance}% chance of rain today. "${ev.summary}" may be affected — consider an umbrella or backup plan.`,
          eventTitle: ev.summary ?? undefined,
          severity: "warning",
        });
      }
    } else if (precipChance >= 60) {
      suggestions.push({
        type: "rain_warning",
        title: "Rain Likely Today",
        message: `${precipChance}% chance of rain — don't forget an umbrella.`,
        severity: "info",
      });
    }
  }

  // ── Heat warning ───────────────────────────────────────────────────────────
  if (high >= 95) {
    const outdoorEvents = todayEvents.filter((e) => isOutdoorEvent(e.summary ?? ""));
    if (outdoorEvents.length > 0) {
      for (const ev of outdoorEvents) {
        suggestions.push({
          type: "heat_warning",
          title: "Extreme Heat — Outdoor Event",
          message: `High of ${high}°F today. "${ev.summary}" — stay hydrated and consider early morning timing.`,
          eventTitle: ev.summary ?? undefined,
          severity: "warning",
        });
      }
    } else {
      suggestions.push({
        type: "heat_warning",
        title: "Extreme Heat Today",
        message: `High of ${high}°F — stay hydrated and limit outdoor exposure during peak afternoon hours.`,
        severity: "info",
      });
    }
  } else if (high >= 85) {
    const outdoorEvents = todayEvents.filter((e) => isOutdoorEvent(e.summary ?? ""));
    for (const ev of outdoorEvents) {
      suggestions.push({
        type: "outdoor_activity_alert",
        title: "Hot Day — Outdoor Activity",
        message: `High of ${high}°F for "${ev.summary}" — stay hydrated.`,
        eventTitle: ev.summary ?? undefined,
        severity: "info",
      });
    }
  }

  // ── Cold warning ──────────────────────────────────────────────────────────
  if (low <= 32) {
    suggestions.push({
      type: "cold_warning",
      title: "Freezing Temperatures",
      message: `Low of ${low}°F tonight — dress warmly and watch for ice.`,
      severity: "info",
    });
  }

  return suggestions;
}
