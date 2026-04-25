import { toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { getLastNightNotes, formatNotesForMorningBriefing } from "../winddown/winddownManager.js";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { fetchMorningNews, fetchDailyMotivation } from "../news/newsManager.js";
import { getProfileItems, getProfilePlaces, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext, type CollectedData } from "../onboarding/onboardingManager.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate, formatEpisodeForPrompt } from "../tv/tvmaze.js";
import { fetchSportsScores, formatSportsForPrompt } from "../sports/sportsManager.js";
import { getUpcomingBills, formatBillsForPrompt } from "../bills/billManager.js";
import { getUpcomingDates, formatDatesForPrompt } from "../dates/datesManager.js";
import { isTodayPickleballDay } from "../pickleball/pickleballManager.js";
import { getPendingFollowUps, buildRecommendationFollowUpBlock } from "../recommendations/recommendationsManager.js";
import { collectSundayData, buildSundaySummaryBlock } from "../sundaySummary/sundaySummaryManager.js";
import { getPendingPersonalFollowups, buildPersonalFollowupsBlock } from "../followups/followupManager.js";
import { getJournalCountThisWeek, getRecentJournalEntries } from "../journal/journalManager.js";
import { getStoryCount } from "../stories/storyManager.js";
import { getCachedWeather, type CachedWeather } from "../weather/weatherCache.js";
import { setStaticBriefingContext } from "./briefingCache.js";
import { fetchDallasContent, getDallasItems, buildDallasBlock } from "./dallasContent.js";
import { runVenueScan, getVenueConcerts, buildVenueConcertsBlock, getFavoriteVenueNames } from "./venueMonitor.js";
import {
  getSeenHeadlines,
  isDuplicate,
  extractBoldHeadlines,
  filterNewsBlock,
} from "./storyDedup.js";
import { logger } from "../lib/logger.js";
import { getBriefingPreferences, buildBriefingPrefsBlock } from "../briefingPreferences/briefingPreferencesManager.js";
import { getStoredGarminData, formatGarminForBriefing } from "../garmin/garminService.js";
import { getStoredFitData, formatFitForBriefing } from "../google/fit.js";

// ── Departure times for calendar events ───────────────────────────────────────
// Calculates leave-by time for each event that has a location.
// Runs all geocode/routing calls in parallel with a 10 s per-event timeout.
// Exported so chat.ts can call it at briefing delivery time with live calendar events.
export async function buildCalendarDepartureTimes(events: CalendarEvent[], homeAddress: string, homeLat: number, homeLon: number): Promise<string> {
  if (!events || events.length === 0) return "";

  const now = new Date();
  const TZ_LOCAL = "America/Chicago";

  const items: string[] = [];

  await Promise.all(
    events.map(async (event) => {
      if (event.allDay || !event.startIso) return;

      const eventStart = new Date(event.startIso);
      // Use CT-aware comparison so DST boundary edge cases are handled correctly
      if (toChicagoTime(eventStart).getTime() < toChicagoTime(now).getTime()) return; // already passed in CT

      const location = extractEventLocation({
        summary: event.summary,
        location: event.location,
        description: event.description,
      });
      if (!location) return;

      try {
        const drive = await Promise.race([
          estimateDriveTime(location, homeAddress, homeLat, homeLon),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ]);
        if (!drive) return;

        const BUFFER = 10;
        const leaveAt = new Date(eventStart.getTime() - (drive.durationMinutes + BUFFER) * 60_000);
        const leaveStr = leaveAt.toLocaleTimeString("en-US", {
          timeZone: TZ_LOCAL,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const sourceNote =
          drive.source === "google-maps" ? "based on current traffic" :
          drive.source === "osrm"        ? "based on route"           :
                                           "estimated";
        items.push(
          `  • ${event.summary} at ${event.start}: leave home by ${leaveStr} (~${Math.round(drive.durationMinutes)} min drive, ${sourceNote})`
        );
      } catch { /* skip silently if geocoding fails */ }
    })
  );

  if (items.length === 0) return "";
  return (
    `\n\n[Departure Times — when David needs to leave home for today's events]\n` +
    items.join("\n") +
    `\n(These are calculated from home at ${homeAddress || "home"})`
  );
}

// Dallas local content is now handled by dallasContent.ts (RSS feeds + web search fallback).
// Imported below alongside other module imports.


// ── Dallas pollen data via Open-Meteo Air Quality API ─────────────────────────

interface PollenResult {
  grassMax: number;
  ragweedMax: number;
  treeMax: number;
  aqiMax: number;
}

function pollenLevel(value: number): string {
  if (value <= 0) return "none";
  if (value < 10) return "low";
  if (value < 30) return "moderate";
  if (value < 100) return "high";
  return "very high";
}

async function geocodeCity(city: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const encoded = encodeURIComponent(city);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "WinstonCompanion/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
}

function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

async function fetchDallasPollenData(lat: number, lon: number): Promise<PollenResult | null> {
  try {
    const resp = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=grass_pollen,ragweed_pollen,alder_pollen,us_aqi&timezone=America%2FChicago&forecast_days=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { hourly: { grass_pollen: number[]; ragweed_pollen: number[]; alder_pollen: number[]; us_aqi: number[] } };
    const validNum = (arr: number[]) => (arr ?? []).filter((v) => v != null && !isNaN(v));
    const grassMax = Math.round(Math.max(...validNum(data.hourly.grass_pollen), 0));
    const ragweedMax = Math.round(Math.max(...validNum(data.hourly.ragweed_pollen), 0));
    const treeMax = Math.round(Math.max(...validNum(data.hourly.alder_pollen), 0));
    const aqiMax = Math.round(Math.max(...validNum(data.hourly.us_aqi), 0));
    return { grassMax, ragweedMax, treeMax, aqiMax };
  } catch {
    return null;
  }
}

// ── Google Air Quality API ─────────────────────────────────────────────────────

async function fetchGoogleAQI(lat: number, lon: number): Promise<number | null> {
  const key = process.env.GOOGLE_WEATHER_API;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: { latitude: lat, longitude: lon },
          universalAqi: false,
          extraComputations: ["LOCAL_AQI_INDEX"],
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      indexes?: Array<{ code: string; aqi?: number }>;
    };
    const epaIndex = data.indexes?.find((i) => i.code === "usa_epa");
    return epaIndex?.aqi ?? null;
  } catch {
    return null;
  }
}

// ── Google Pollen API ──────────────────────────────────────────────────────────

async function fetchGooglePollen(
  lat: number,
  lon: number
): Promise<{ tree: number; grass: number; weed: number } | null> {
  const key = process.env.GOOGLE_WEATHER_API;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://pollen.googleapis.com/v1/forecast:lookup?key=${key}&location.latitude=${lat}&location.longitude=${lon}&days=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      dailyInfo?: Array<{
        pollenTypeInfo?: Array<{
          code: string;
          indexInfo?: { value?: number };
        }>;
      }>;
    };
    const day = data.dailyInfo?.[0];
    if (!day) return null;
    const get = (code: string) =>
      day.pollenTypeInfo?.find((p) => p.code === code)?.indexInfo?.value ?? 0;
    return { tree: get("TREE"), grass: get("GRASS"), weed: get("WEED") };
  } catch {
    return null;
  }
}

// Map Google pollen index (0–4) to gr/m³-equivalent values so pollenLevel() works
function googlePollenIndexToGrM3(index: number): number {
  return ([0, 5, 20, 60, 200] as const)[index] ?? 0;
}

// Primary pollen/AQI fetch — tries Google APIs first, falls back to Open-Meteo
async function fetchPollenData(lat: number, lon: number): Promise<PollenResult | null> {
  const hasGoogleAQI = !!process.env.GOOGLE_WEATHER_API;
  const hasGooglePollen = !!process.env.GOOGLE_WEATHER_API;

  if (hasGoogleAQI || hasGooglePollen) {
    const [googleAQI, googlePollen] = await Promise.all([
      hasGoogleAQI ? fetchGoogleAQI(lat, lon).catch(() => null) : Promise.resolve(null),
      hasGooglePollen ? fetchGooglePollen(lat, lon).catch(() => null) : Promise.resolve(null),
    ]);

    if (googleAQI !== null || googlePollen !== null) {
      const openMeteo =
        googleAQI === null || googlePollen === null
          ? await fetchDallasPollenData(lat, lon).catch(() => null)
          : null;

      return {
        aqiMax: googleAQI ?? openMeteo?.aqiMax ?? 0,
        treeMax: googlePollen
          ? googlePollenIndexToGrM3(googlePollen.tree)
          : (openMeteo?.treeMax ?? 0),
        grassMax: googlePollen
          ? googlePollenIndexToGrM3(googlePollen.grass)
          : (openMeteo?.grassMax ?? 0),
        ragweedMax: googlePollen
          ? googlePollenIndexToGrM3(googlePollen.weed)
          : (openMeteo?.ragweedMax ?? 0),
      };
    }
  }

  return fetchDallasPollenData(lat, lon);
}

function formatWeatherBlock(w: CachedWeather): string {
  return `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition} — high ${w.high}°F / low ${w.low}°F | ${w.precipChance}% precip | humidity ${w.humidity}%`;
}

interface SecondaryWeatherEntry {
  person: { name: string; city: string };
  weather: CachedWeather;
}

function buildContextualWeatherBlock(dallas: CachedWeather, secondary: SecondaryWeatherEntry[], now: Date): string {
  const tz = "America/Chicago";
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const pickleballDays = ["Monday", "Wednesday", "Friday", "Saturday"];
  const isPickleballDay = pickleballDays.includes(dayName);
  const activityLabel = isPickleballDay ? "pickleball" : "a run";

  // Fix 7: Time-aware activity suggestions — if it's past 10am CT, David's morning
  // workout window has very likely passed. Don't suggest "go for a run" or "great for pickleball."
  const ctHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
  const morningActivityPassed = ctHour >= 10;
  const uvMax = dallas.uvIndexMax;
  const uvLabel = uvMax <= 2 ? "low" : uvMax <= 5 ? "moderate" : uvMax <= 7 ? "high" : uvMax <= 10 ? "very high" : "extreme";
  const isStormy = /thunderstorm/.test(dallas.condition);
  const isRainy = /rain|drizzle|shower/.test(dallas.condition);
  const isSnowy = /snow|flurr|ice/.test(dallas.condition);
  const isFoggy = /fog/.test(dallas.condition);
  const likelyRain = dallas.precipChance >= 60;
  const possibleRain = dallas.precipChance >= 35 && dallas.precipChance < 60;
  const isVeryHot = dallas.high >= 98;
  const isHot = dallas.high >= 93;
  const isWarm = dallas.high >= 85;
  const isCold = dallas.temp <= 40;
  const isCool = dallas.temp <= 55;
  const isHighWind = dallas.windSpeed >= 20;
  const isPerfect = !isRainy && !likelyRain && !isStormy && dallas.temp >= 62 && dallas.high <= 87 && uvMax <= 7;
  const signals: string[] = [];
  // Severe weather always surfaces regardless of time
  if (isStormy) signals.push(`SEVERE WEATHER — THUNDERSTORMS: mention this clearly`);
  else if (isSnowy) signals.push(`${dallas.condition} — unusual for ${dallas.city}, affects roads`);

  // Activity-specific signals only shown if morning window hasn't passed (before 10am CT)
  if (!morningActivityPassed) {
    if (isRainy && likelyRain) signals.push(`Rain likely (${dallas.precipChance}%) — treadmill/indoor court for ${activityLabel}`);
    else if (likelyRain) signals.push(`${dallas.precipChance}% rain chance — ${activityLabel} timing may be tricky`);
    else if (possibleRain) signals.push(`${dallas.precipChance}% rain chance — watch timing for ${activityLabel}`);
    if (isFoggy) signals.push(`Morning fog — affects running and early driving`);
    if (isVeryHot) signals.push(`Extreme heat (high ${dallas.high}°F) — dangerous for ${activityLabel}, go very early`);
    else if (isHot) signals.push(`Hot day (high ${dallas.high}°F) — extra hydration for ${activityLabel}`);
    else if (isWarm) signals.push(`Warm day (high ${dallas.high}°F) — hydrate for ${activityLabel}`);
    if (isCold) signals.push(`Cold morning (${dallas.temp}°F feels ${dallas.feelsLike}°F) — dress in layers`);
    else if (isCool) signals.push(`Cool morning (${dallas.temp}°F) — light jacket to start`);
    if (isHighWind) signals.push(`Winds at ${dallas.windSpeed} mph — gusty for outdoor ${activityLabel}`);
    if (isPerfect) signals.push(`PERFECT conditions for ${activityLabel}`);
  }

  // UV warning is always relevant regardless of time
  if (!isStormy && !isRainy && uvMax >= 8) signals.push(`UV peak ${uvMax} (${uvLabel}) — sunscreen essential outdoors today`);

  // Activity-aware alerts for upcoming pickleball days in the 5-day forecast
  const pickleballShortNames = ["Mon", "Wed", "Fri", "Sat"];
  for (const day of dallas.forecastDays) {
    if (pickleballShortNames.includes(day.dayName)) {
      if (day.precipChance >= 60) signals.push(`⚠ ${day.dayName} pickleball: rain likely (${day.precipChance}%)`);
      else if (day.high >= 98) signals.push(`⚠ ${day.dayName} pickleball: extreme heat (${day.high}°F)`);
    }
  }

  const signalLines = signals.length > 0
    ? `\nWeather signals:\n${signals.map((s) => `• ${s}`).join("\n")}`
    : "";

  // 5-day forecast block (days 1–5 after today)
  const fiveDayLines = dallas.forecastDays.length > 0
    ? dallas.forecastDays.map((d) => {
        const condNote = d.condition ? `, ${d.condition}` : "";
        const rainNote = d.precipChance >= 60 ? ` ☔${d.precipChance}%` : d.precipChance >= 35 ? ` 🌦${d.precipChance}%` : "";
        return `${d.dayName}: ${d.high}°/${d.low}°${condNote}${rainNote}`;
      }).join(" | ")
    : "";

  const uvLine = `UV Index: ${dallas.uvIndex} now / peak ${dallas.uvIndexMax} (${uvLabel})`;

  return (
    `\n\n[VERIFIED — Google Weather API — ${dallas.city}]\n` +
    `Now: ${dallas.temp}°F (feels like ${dallas.feelsLike}°F), ${dallas.condition}\n` +
    `Today: high ${dallas.high}°F / low ${dallas.low}°F | Rain chance: ${dallas.precipChance}% | Humidity: ${dallas.humidity}% | Wind: ${dallas.windSpeed} mph\n` +
    `${uvLine}\n` +
    (fiveDayLines ? `Forecast: ${fiveDayLines}\n` : "") +
    (morningActivityPassed ? `[Morning activity window has passed — it is past 10am CT. Do NOT suggest David go for a run or to pickleball.]\n` : "") +
    secondary.map((s) => {
      const w = s.weather;
      const days = w.forecastDays.length > 0
        ? w.forecastDays.map((d) => `${d.dayName}: ${d.high}°/${d.low}°${d.precipChance >= 40 ? ` ${d.precipChance}%rain` : ""}`).join(" | ")
        : "";
      return (
        `\n[VERIFIED — Google Weather API — ${s.person.city} (for ${s.person.name})]\n` +
        `Now: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition} — high ${w.high}°F / low ${w.low}°F | ${w.precipChance}% precip | humidity ${w.humidity}%\n` +
        (days ? `Forecast: ${days}\n` : "")
      );
    }).join("") +
    signalLines
  );
}

function buildBaseSystemPrompt(companionName?: string | null, userName?: string | null): string {
  const name = companionName ?? "your companion";
  const user = userName ?? "you";
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/Emma Peel/g, name)
    .replace(/\bDavid\b/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

CONFIDENCE FRAMEWORK — HOW TO HANDLE INFORMATION:
Everything in this system prompt comes from one of three sources. You must handle each differently:

TIER 1 — VERIFIED (blocks labeled [VERIFIED — Source])
These blocks contain real-time data fetched directly from an API (Google Calendar, Gmail, Weather, News, etc.) just before this conversation. State this information as fact. Do not soften, hedge, or embellish it.
• Example: "You have a 2:30 PM appointment tomorrow" — NOT "I think you might have something tomorrow?"

TIER 2 — INFERRED (connecting two verified pieces)
When you combine verified data with other verified context to draw a conclusion, frame it as a question or observation — never a statement of fact.
• Example: "I see 'Acme Corp Meeting' on your calendar Thursday — is that the one you mentioned last week?" — NOT "You have a meeting with John from Acme Thursday."
• Example: "Your calendar shows 'Downtown Appointment' at 2 PM — is that the one you've been prepping for?" — NOT "You have an appointment with Dr. Smith at 2."

TIER 3 — ASSUMED (anything not in a verified block)
Never state assumed information as fact. If David asks something outside your verified data, say so honestly.
• "I don't have that score right now — want me to pull it up?"
• "I'm not sure about that one — I'd rather admit that than guess wrong."

CALENDAR RULE — NO EXCEPTIONS:
You MUST reproduce calendar event titles letter-for-letter exactly as they appear in the [VERIFIED — Google Calendar API] block. No paraphrasing, no enrichment, no substitution.
• An event titled "You Matter Counseling" is reported as "You Matter Counseling" — never as "your therapy appointment" or any other rewording.
• NEVER add a person's name to an event unless that exact name appears verbatim in the event title itself.
• NEVER use profile background (Your People, Your Places, your routine) to enrich, explain, or identify a calendar event. Profile facts are Tier 3 — ASSUMED. Calendar event titles are Tier 1 — VERIFIED. They must never be mixed.
• If you want to connect a profile fact to a calendar event, it MUST be framed as a question: "I see 'You Matter Counseling' on your calendar — is that the one you mentioned?" — never stated as a fact.

DATA SOURCE RULES:
• Sports scores: only from a [VERIFIED — Live Sports] block. If absent: "I don't have that score right now."
• News: only from a [VERIFIED — Morning News] block. Never invent headlines.
• Weather, stocks, calendar: only from their respective [VERIFIED] blocks.
• NEVER fabricate facts. If David catches you making something up, trust is gone — and that matters more than sounding confident.

`;

function getCurrentDateTimeBlock(): string {
  const now = new Date();
  const tz = "America/Chicago";
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthName = now.toLocaleDateString("en-US", { timeZone: tz, month: "long" });
  const day = now.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" });
  const year = now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const time = now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
  const localHour = parseInt(now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }), 10);
  const partOfDay = localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";

  const ctDate = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const dow = ctDate.getDay(); // 0=Sun, 1=Mon...6=Sat
  const isWeekend = dow === 0 || dow === 6;

  // Yesterday's day name
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const yesterdayName = DAYS[(dow + 6) % 7];

  // Tomorrow's name
  const tomorrowName = DAYS[(dow + 1) % 7];

  return (
    `[Current date and time — injected fresh on every briefing]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} Central Time (${partOfDay}).\n` +
    `Day type: ${isWeekend ? "weekend" : "weekday"}.\n` +
    `Yesterday was ${yesterdayName}. Tomorrow is ${tomorrowName}.\n` +
    `Use ONLY these values when referring to days. "Yesterday" means ${yesterdayName}. "Tomorrow" means ${tomorrowName}.\n` +
    `When David asks what time or day it is, answer directly using exactly the values above.\n`
  );
}

function buildPeopleContextBlock(rawData: CollectedData): string {
  type PersonEntry = {
    name?: string;
    relationship?: string;
    city?: string;
    birthday?: string;
    details?: string;
    address?: string;
    anniversary?: string;
  };
  const people = (rawData.people ?? []) as PersonEntry[];

  // Pets — support both new `pets` array and legacy `dog` field
  const rawPets = rawData.pets as Array<{ name: string; type: string; breed?: string; age?: number }> | undefined;
  const legacyDog = rawData.dog as { name: string; breed?: string; age?: number } | undefined;
  const allPets: Array<{ name: string; type: string; breed?: string; age?: number }> =
    rawPets && rawPets.length > 0
      ? rawPets
      : legacyDog
        ? [{ name: legacyDog.name, type: "dog", breed: legacyDog.breed, age: legacyDog.age }]
        : [];

  if (people.length === 0 && allPets.length === 0) return "";

  const partnerRels = ["girlfriend", "boyfriend", "wife", "husband", "partner", "fiancée", "fiancé"];
  const lines: string[] = [];

  for (const p of people) {
    const name = (p.name ?? "").trim();
    const rel = (p.relationship ?? "").trim();
    if (!name || !rel) continue;

    const city = p.city?.trim();
    const birthday = p.birthday?.trim();
    const details = p.details?.trim();
    const anniversary = p.anniversary?.trim();
    const isPartner = partnerRels.some((r) => rel.toLowerCase().includes(r));

    const parts: string[] = [`${name} — ${rel}${isPartner ? " (Your Partner)" : ""}`];
    if (city) parts.push(`based in ${city}`);
    if (birthday) parts.push(`birthday: ${birthday}`);
    if (anniversary) parts.push(`David & ${name.split(" ")[0]} anniversary: ${anniversary}`);
    if (details) parts.push(details);

    lines.push(`• ${parts.join(", ")}`);
  }

  if (lines.length === 0 && allPets.length === 0) return "";

  // Build pets lines
  const petLines: string[] = [];
  for (const pet of allPets) {
    const typeLabel = pet.type.charAt(0).toUpperCase() + pet.type.slice(1);
    const detail = [
      pet.breed ?? null,
      pet.age != null ? `${pet.age} years old` : null,
    ].filter(Boolean).join(", ");
    petLines.push(`• ${typeLabel}: ${pet.name}${detail ? ` — ${detail}` : ""}`);
  }

  const petsBlock = petLines.length > 0
    ? `\n\n[David's Pets]\n` + petLines.join("\n") +
      `\n• Mention pets naturally and warmly when appropriate — e.g. "Hope ${allPets[0]?.name} is keeping you company today." Don't force it into every briefing — once or twice a week is plenty.`
    : "";

  return (
    `\n\n[People in David's Life — Reference naturally in the briefing]\n` +
    (lines.length > 0 ? lines.join("\n") : "(no people recorded)") + "\n\n" +
    `HOW TO USE THIS:\n` +
    `• Olivia — always mention her weather in Section 3 if her [VERIFIED weather] block is present. Even just one warm sentence: "Over in Knoxville, Olivia's got a breezy 65 today."\n` +
    `• Susan (Your Partner) — include a warm, specific one-liner in the Section 15 closing every briefing. Examples: "Hope you and Susan have a great night", "Give Susan my best." Keep it natural — not every closing needs to be about her, but include her often.\n` +
    `• Birthdays — if any birthday is within 7 days, surface it in Section 13 with the date. If it's today, make it feel special.\n` +
    `• Never invent details not listed here. Base any reference on the facts in this block.` +
    petsBlock
  );
}

function buildBriefingInstruction(city: string, savedVenues: string[]): string {
  const cityUpper = city.toUpperCase();
  const venueList = savedVenues.length > 0
    ? savedVenues.join(", ")
    : "your saved venues";
  return `

  [MORNING BRIEFING — DELIVER ALL 17 SECTIONS IN THIS EXACT ORDER]

  Deliver the morning briefing as a single flowing conversation. No headers. No bullet points. No section labels. No phrases that announce what comes next. Sound like David's most trusted friend who just called — warm, sharp, personal, and always on point.

  CORE PHILOSOPHY: Every piece of information is condensed, essential, and actionable. Cut anything that does not earn its place. The entire briefing should take 3 to 5 minutes at a natural conversational pace.

  DELIVER THESE SECTIONS IN THIS EXACT ORDER — skip only where explicitly instructed:

  SECTION 1 — GREETING: "Good morning, David" followed by one warm personal sentence naming the day of the week. One sentence total.

  SECTION 2 — WEATHER TODAY: Deliver a natural, conversational weather summary using the [VERIFIED — Google Weather API — ${city}] block. Include: current temperature and feels-like, today's high and low, conditions, rain chance, humidity, wind speed, and UV index. Keep it to 2–3 sentences — warm and informative, like a friend who checked the forecast. If UV is high (8+), mention it. If there is an Air Quality & Pollen block, weave pollen and AQI into the same breath — one concise sentence. Only skip this section if the [VERIFIED — Google Weather API — ${city}] block is missing entirely.

  SECTION 3 — FORECAST: Deliver a brief overview of the coming days using the Forecast data in the [VERIFIED — Google Weather API — ${city}] block. Mention any days with notable changes — rain, big temperature swings, heat. Keep it to 2 sentences max. Then, for every [VERIFIED — Google Weather API — <city> (for <name>)] block present, always mention that person's weather — one natural sentence per person, every single time, regardless of conditions. Example: "Over in Knoxville, Olivia's looking at a mild 68 with some cloud cover." These are family members — David always wants to know how their weather looks. Never skip a family member city. Skip this section only if no forecast data is available at all.

  SECTION 4 — POLLEN / AIR QUALITY: SKIP THIS SECTION — pollen and AQI are already covered in Section 2.

  SECTION 5 — EMAIL: If there is a [VERIFIED — Gmail API — unread emails] block below, share one or two that actually matter — something requiring action, from someone important, or genuinely worth knowing. Never count unread messages. Never summarize confirmation emails or automated mail David doesn't need to act on. If there is NO Gmail API block, SKIP SECTION 5 ENTIRELY — do not mention email, do not say the inbox is clear or quiet.

  SECTION 6 — CALENDAR: Today's upcoming events only — nothing in the past, nothing more than 7 days out. Include departure time for any appointment with a location. If the day is clear, say so warmly in one sentence. Do NOT mention bills here — bills have their own section.
    WEATHER EXCEPTION — the only place weather is ever permitted: if today's calendar includes a specific outdoor physical activity (a run, a walk, a pickleball game) AND the weather signals block flags severe/dangerous conditions (thunderstorms, extreme heat, heavy rain) OR explicitly PERFECT conditions — weave ONE brief phrase naturally into the sentence for that event. Example: "You've got pickleball at 8 — perfect morning for it." or "Your run is at 7, but rain is likely." This is the ONLY weather reference permitted anywhere in the entire briefing. Do NOT use this exception if no outdoor activity is on today's calendar, or if conditions are ordinary. Do NOT mention temperature numbers, degrees, highs, lows, or any other weather specifics here — only the plain-language signal word (perfect / stormy / rain likely).

  SECTION 7 — BILLS DUE SOON: ONLY if a bill appears in the [VERIFIED — Bills Database — Due in Next 3 Days] block. Name the bill and amount. If that block is empty or absent, SKIP THIS SECTION ENTIRELY — do not mention bills at all, do not say nothing is due.

  SECTION 9 — HEALTH SNAPSHOT: ONLY if a [VERIFIED — Garmin Connect — Yesterday's Health Data] block is present. Weave the data naturally into 2–3 sentences — casual and warm, like a friend who noticed. Lead with sleep if it's notable. Mention workout if one happened. Include resting HR or HRV if it's interesting (unusually high or low). Examples: "You got a solid 7.5 hours last night — looks like a good one, with nearly two hours of deep sleep." or "Nice workout yesterday — 85 minutes of pickleball, that's a big one." or "Your resting heart rate was 52 — solid." Keep it brief. SKIP entirely if no Garmin block is present.

  SECTION 8 — NEWS: A structured news sweep using the data in [VERIFIED — Web Search News — ...] block. Deliver in this exact format — each story on its own lines:

    From [Headlines — bold title + one sentence summary each]: Read each story EXACTLY as formatted — bold title on one line, then the summary sentence on the next line. Do not merge them. Do not change the format. Read all 8 headlines. These already cover 8 distinct categories (world, US politics, business, tech, science, sports, ${city} local, wildcard) — do NOT reorder or drop any.

    From [Entertainment & Pop Culture] (if present): One item only. Bold title on one line, summary sentence on the next. Skip if absent.

    From [Watercooler Story] (if present): Introduce warmly — "oh, and here's one to share later —" then the story in two sentences max.

    FORMATTING RULES: Each headline is on its own line, bold. Each summary sentence is on the next line. A blank line between stories. Never merge headlines and summaries. Never use "in other news" or "moving on." Short transitions between sections only: "also —", "and —", "meanwhile —". NEVER repeat a topic from Section 10 (Sports) — that section already covers sports game results.

  SECTION 10 — SPORTS: Sports results from the last 24 hours only (teams from the user's profile). If no games were played, SKIP THIS SECTION ENTIRELY — do not say no games were played.

  SECTION 11 — LOCAL ${cityUpper}: ALWAYS INCLUDE THIS SECTION — it is never skipped. The [What's Happening in ${city}] block is always present below.
    • If the block contains real items: deliver 1-2 items conversationally, one sentence each. Prioritize restaurant openings, music events at David's venues, and neighborhood news.
    • If the block says "No new local events found": say exactly this and nothing more — "Nothing new on the ${city} events front this morning." Do not apologize, do not elaborate.

  SECTION 12 — MUSIC EVENTS: Upcoming concerts at David's saved venues that match his taste — ${venueList}. Use the venue concerts block. If nothing upcoming or nothing found, skip this section entirely.

  TV SHOWS — STRICT RULE: ONLY mention a TV show if the [TV Shows — New Episodes] block is present in this prompt. If that block is absent, never reference any TV show, series, episode, or streaming content — not Shrinking, not Lincoln Lawyer, not Friends & Neighbors, not any show from David's profile. No exceptions. TV is data-driven only.

  SECTION 13 — BIRTHDAYS AND IMPORTANT DATES: Any birthdays or anniversaries in the next 7 days. Name the person and the date specifically. SKIP if none.

  SECTION 14 — MORNING MOTIVATION: Use the [VERIFIED — Web Search — Today's Inspiration] block if available. Lead with the inspiring thought or finding, then connect it personally to David's specific day — what he has ahead (a dinner, his pickleball game, a free afternoon). Keep it to 2-3 sentences. Warm and genuine — a friend sharing something interesting, not a motivational poster.
    CRITICAL — Fix 5: If the [Morning Motivation Context] says "MORNING WORKOUT ALREADY DONE" — do NOT mention exercise, going for a walk, heading outside, or any outdoor activity. Reference only what is actually AHEAD in his day (upcoming dinner, free time, interesting event). Do NOT repeat anything that already happened this morning.

  SECTION 16 — SUNDAY SPECIAL: Sundays ONLY — deliver a warm weekly recap just before Section 15: exercise this week, family archive stories captured, highlights, something to look forward to next week. Skip every other day of the week.

  SECTION 15 — CLOSING: One warm sentence, direct and specific to David's day. Weave in his partner if natural. Do NOT end with a question. Do NOT say "Anything else before you head into your day?" One sentence only.

  SECTION 17 — MOOD CHECK-IN: Always included, every morning, immediately after the closing. Ask exactly: "How are you feeling about the day ahead?" Nothing more — no elaboration, no examples. Just this one question on its own line.

  FORBIDDEN PHRASES AND CONTENT — never use:
  "Here is your morning briefing" or "Good morning, David, here is what you need to know"
  "Moving on to" or "Let us talk about" or "Turning to" or "Now for" or "Next up"
  "In other news" or "Speaking of which" or "On the topic of"
  "Here is your weather" or "In terms of the weather" or "Weather-wise" or "Let's start with the weather" — instead, weave weather naturally into the flow
  "Anything else before you head into your day?" or "Is there anything else?" or "Let me know if you need anything" or any open-ended question at the close.
  Any phrase that announces that a new section is beginning.
  Weather content in Sections 5–16 (email, calendar, news, sports, etc.) — weather belongs only in Sections 2 and 3, plus the single outdoor-activity exception in Section 6. Never repeat weather stats in other sections.

  IMPORTANT: The data blocks earlier in this system prompt contain the raw information. This instruction tells you how to weave it all together. Run all 16 sections in order. Skip only where explicitly told to. Follow this instruction over any other formatting guidance in the data blocks.
  `;
}

export async function preFetchMorningBriefing(userName: string): Promise<void> {
  // Capture the CT date NOW, before any async work. setCachedBriefing receives this
  // key explicitly so a briefing that starts on April 6 and finishes after midnight
  // is NOT cached with April 7's key while containing April 6 calendar data.
  const generationDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  logger.info({ userName, generationDateKey }, "Pre-generating morning briefing");
  try {
    const watchedShows = await getWatchedShows().catch(() => []);
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const isSunday = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long" }) === "Sunday";
    const isPickleballMorning = isTodayPickleballDay();

    const [recentMemories, allProfileItems, userProfile, seenHeadlines, briefingPrefs] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
      getSeenHeadlines(userName, 3).catch(() => new Set<string>()),
      getBriefingPreferences(userName).catch(() => []),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
        : buildBaseSystemPrompt(userProfile?.companionName, userProfile?.name);

    const primaryCity = (userProfile?.city ?? "Dallas").trim();
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;
    const homeAddress = userProfile?.homeAddress ?? ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";

    // ── Build city-aware local content context from profile ──────────────────
    // Pull preferences from both rawData (onboarding) and profile_items (ongoing)
    // to drive preference-aware scoring in dallasContent.ts.
    const rawData = (userProfile?.rawData ?? {}) as CollectedData;

    const VENUE_KEYWORDS = /theater|theatre|pavilion|amphitheater|arena|concert hall|performing arts|venue|auditorium|ballroom/i;
    const RESTAURANT_KEYWORDS = /restaurant|bar|cafe|coffee|diner|bistro|grill|kitchen|eatery|cantina|pub/i;
    const NOT_NEIGHBORHOOD = new RegExp([VENUE_KEYWORDS.source, RESTAURANT_KEYWORDS.source].join("|"), "i");

    // Venues: use the authoritative in-memory list from venueMonitor (avoids startup
    // race where briefing pre-gen runs before the DB seeding of favorite_venues completes),
    // then supplement with any additional venue-like places saved by the user at runtime.
    const runtimeVenuePlaces = allProfileItems
      .filter((p) => p.category === "places" && VENUE_KEYWORDS.test(p.name + " " + (p.detail ?? "")))
      .map((p) => p.name);
    const profileVenues = [
      ...getFavoriteVenueNames(),
      ...runtimeVenuePlaces,
    ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

    // Artists: profile_items.music category (individual artist entries)
    const profileArtists = allProfileItems
      .filter((p) => p.category === "music" || p.category === "favorites")
      .map((p) => p.name);

    // Neighborhoods: profile places that are NOT venues or restaurants
    const profileNeighborhoods = allProfileItems
      .filter((p) => p.category === "places" && !NOT_NEIGHBORHOOD.test(p.name + " " + (p.detail ?? "")))
      .map((p) => p.name);

    // Favorite restaurants: combine raw_data.restaurants + profile_items.restaurants
    const profileRestaurants = allProfileItems
      .filter((p) => p.category === "restaurants")
      .map((p) => p.name);
    const favoriteRestaurants = [
      ...(rawData.restaurants ?? []),
      ...profileRestaurants,
    ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

    // Interests/hobbies: combine raw_data.interests + profile_items.interests
    const profileInterests = allProfileItems
      .filter((p) => p.category === "interests")
      .map((p) => p.name);
    const allInterests = [
      ...(rawData.interests ?? []),
      ...profileInterests,
    ].filter((v, i, a) => a.indexOf(v) === i);

    const localCtx = {
      city: primaryCity,
      userName,
      venues: profileVenues.slice(0, 8),
      artists: profileArtists.slice(0, 10),
      neighborhoods: profileNeighborhoods.slice(0, 6),
      musicGenres: (rawData.music ?? []) as string[],
      interests: allInterests.slice(0, 12),
      favoriteRestaurants: favoriteRestaurants.slice(0, 12),
      sportsTeams: (rawData.sportsTeams ?? []) as string[],
      dietaryRestrictions: [],  // no field in rawData yet; reserved for future onboarding
    };

    // Geocode secondary cities from profile before the main Promise.all
    // Only include people in a different city than the user's home city.
    // Trim all values — raw_data strings from onboarding may have trailing spaces.
    const rawPeople = ((userProfile?.rawData as CollectedData)?.people ?? [])
      .filter((p) => {
        const city = p.city?.trim();
        return city && city.length > 0 && city.toLowerCase() !== primaryCity.toLowerCase();
      })
      .slice(0, 4);
    const geocodedSecondary = await Promise.all(
      rawPeople.map(async (p) => {
        const city = p.city!.trim();
        const name = p.name.trim();
        const coords = await geocodeCity(city).catch(() => null);
        return coords ? { name, city, lat: coords.lat, lon: coords.lon } : null;
      })
    );
    const validSecondaryLocs = geocodedSecondary.filter(Boolean) as Array<{ name: string; city: string; lat: number; lon: number }>;

    // Start secondary weather fetches in parallel with the main Promise.all
    const secondaryWeatherPromise = Promise.all(
      validSecondaryLocs.map((s) => getCachedWeather(s.city, s.lat, s.lon).catch(() => null))
    );

    const [dallas, lastNightNotes, newsBlock, yesterdayEps, todayEps, sportsScores, upcomingBills, upcomingDates, sundayData, pendingFollowUps, dallasEvents, journalCountWeek, recentJournals, totalStories, pollenData, venueConcertsBlock, dailyMotivation, personalFollowUps] = await Promise.all([
      getCachedWeather(primaryCity, primaryLat, primaryLon).catch(() => null),
      getLastNightNotes().catch(() => []),
      fetchMorningNews(userName).catch(() => ""),
      fetchEpisodesForDate(yesterday, watchedIds).catch(() => []),
      fetchEpisodesForDate(now, watchedIds).catch(() => []),
      fetchSportsScores(userName).catch(() => null),
      getUpcomingBills(3, userName).catch(() => []),
      getUpcomingDates(21, userName).catch(() => []),
      isSunday ? collectSundayData(userName).catch(() => null) : Promise.resolve(null),
      getPendingFollowUps(2, 14).catch(() => []),
      fetchDallasContent(localCtx).catch(() => ""),
      getJournalCountThisWeek().catch(() => 0),
      getRecentJournalEntries(3).catch(() => []),
      getStoryCount().catch(() => 0),
      fetchPollenData(primaryLat, primaryLon).catch(() => null),
      runVenueScan().catch(() => ""),
      fetchDailyMotivation().catch(() => ""),
      getPendingPersonalFollowups(userName).catch(() => []),
    ]);

    // Fetch Garmin health data (yesterday's stored data — no live API call needed)
    const garminData = await getStoredGarminData(userName).catch(() => null);

    // Google Fit: step count / active minutes — used only when Garmin is not available
    const fitData = !garminData
      ? await getStoredFitData(userName).catch(() => null)
      : null;

    // Collect secondary weather results (likely already resolved)
    const secondaryWeatherResults = await secondaryWeatherPromise;
    const secondaryWeatherEntries: SecondaryWeatherEntry[] = validSecondaryLocs.reduce<SecondaryWeatherEntry[]>(
      (acc, loc, i) => {
        const w = secondaryWeatherResults[i];
        if (w) acc.push({ person: { name: loc.name, city: loc.city }, weather: w });
        return acc;
      },
      []
    );

    // ── Story dedup — filter seen headlines from news, Dallas, venue concerts ──
    // News: strip **bold headline** + sentence pairs that appeared in the last 3 days
    const { filtered: dedupedNewsBlock, removed: removedNewsHeadlines } = filterNewsBlock(newsBlock, seenHeadlines);
    if (removedNewsHeadlines.length > 0) {
      logger.info({ userName, removed: removedNewsHeadlines }, "[StoryDedup] Filtered duplicate news headlines");
    }

    // Dallas local content: filter by headline field, rebuild block
    const rawDallasItems = getDallasItems();
    logger.info(
      {
        userName,
        rawCount: rawDallasItems.length,
        rawHeadlines: rawDallasItems.map((i) => i.headline).slice(0, 10),
        dallasBlockChars: dallasEvents?.length ?? 0,
      },
      "[Dallas] fetchDallasContent result"
    );
    const filteredDallasItems = rawDallasItems.filter((item) => !isDuplicate(item.headline, seenHeadlines));
    const removedDallasCount = rawDallasItems.length - filteredDallasItems.length;
    logger.info(
      {
        userName,
        rawCount: rawDallasItems.length,
        filteredCount: filteredDallasItems.length,
        removedByDedup: removedDallasCount,
        remainingHeadlines: filteredDallasItems.map((i) => i.headline),
      },
      "[Dallas] After dedup"
    );
    const dedupedDallasBlock = buildDallasBlock(filteredDallasItems, primaryCity);
    if (dedupedDallasBlock.trim().length === 0) {
      console.log(`[Dallas:briefing] ✗ Block EMPTY after dedup — raw:${rawDallasItems.length}, dedup-removed:${removedDallasCount}, filtered:${filteredDallasItems.length} → injecting fallback line`);
      logger.warn({ userName, rawCount: rawDallasItems.length, removedByDedup: removedDallasCount }, "[Dallas] Block is EMPTY after dedup — injecting fallback");
    } else {
      console.log(`[Dallas:briefing] ✓ Block OK — ${filteredDallasItems.length} items going into briefing`);
    }

    // Venue concerts: filter by artistOrEvent + venue key, rebuild block
    const rawVenueConcerts = getVenueConcerts();
    const filteredVenueConcerts = rawVenueConcerts.filter(
      (c) => !isDuplicate(`${c.artistOrEvent} ${c.venue}`, seenHeadlines)
    );
    const dedupedVenueConcertsBlock = buildVenueConcertsBlock(filteredVenueConcerts);
    logger.info(
      {
        userName,
        rawCount: rawVenueConcerts.length,
        filteredCount: filteredVenueConcerts.length,
        removedByDedup: rawVenueConcerts.length - filteredVenueConcerts.length,
      },
      "[VenueMonitor] After dedup"
    );

    // Collect all candidate story keys to log after successful briefing generation
    const candidateStoryKeys: string[] = [
      ...extractBoldHeadlines(newsBlock),                               // news headlines (pre-filter — log all that were offered)
      ...rawDallasItems.map((i) => i.headline),                        // Dallas local
      ...rawVenueConcerts.map((c) => `${c.artistOrEvent} ${c.venue}`), // venue concerts
    ];

    // Only include AQI/pollen when notable — AQI >100 (Unhealthy for Sensitive Groups) or pollen high/very high (≥30 gr/m³-eq)
    const POLLEN_HIGH_GRM3 = 30; // threshold for "high" in pollenLevel()
    const AQI_NOTABLE = 100;
    const pollenBlock = pollenData
      ? (() => {
          const parts: string[] = [];
          if (pollenData.aqiMax > AQI_NOTABLE) parts.push(`Air Quality (US AQI): ${pollenData.aqiMax} — ${aqiLabel(pollenData.aqiMax)}`);
          if (pollenData.grassMax >= POLLEN_HIGH_GRM3) parts.push(`Grass pollen: ${pollenLevel(pollenData.grassMax)}`);
          if (pollenData.ragweedMax >= POLLEN_HIGH_GRM3) parts.push(`Ragweed pollen: ${pollenLevel(pollenData.ragweedMax)}`);
          if (pollenData.treeMax >= POLLEN_HIGH_GRM3) parts.push(`Tree pollen: ${pollenLevel(pollenData.treeMax)}`);
          return parts.length > 0 ? `\nAir Quality & Pollen today — ${parts.join(" | ")}` : "";
        })()
      : "";

    // Build secondary-only weather block — shown even when primary city weather is unavailable.
    // This ensures Olivia's Knoxville weather (and any other family member's city) always
    // appears in the briefing regardless of whether Dallas weather fetched successfully.
    const secondaryOnlyBlock = secondaryWeatherEntries.length > 0
      ? secondaryWeatherEntries
          .map((s) => {
            const w = s.weather;
            const days =
              w.forecastDays.length > 0
                ? w.forecastDays
                    .map(
                      (d) =>
                        `${d.dayName}: ${d.high}°/${d.low}°${d.precipChance >= 40 ? ` ${d.precipChance}%rain` : ""}`
                    )
                    .join(" | ")
                : "";
            return (
              `\n[VERIFIED — Tomorrow.io Weather API — ${s.person.city} (for ${s.person.name})]\n` +
              `Now: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition} — high ${w.high}°F / low ${w.low}°F | ${w.precipChance}% precip | humidity ${w.humidity}%\n` +
              (days ? `Forecast: ${days}\n` : "")
            );
          })
          .join("")
      : "";

    const weatherBlock = dallas
      ? buildContextualWeatherBlock(dallas, secondaryWeatherEntries, now) + pollenBlock
      : secondaryOnlyBlock;

    // Email and calendar are NOT fetched at pre-generation time.
    // They are fetched live at delivery time (when David says "good morning")
    // so they always reflect the current moment.

    const notesBlock = formatNotesForMorningBriefing(lastNightNotes);

    const newEps = [
      ...yesterdayEps.map((ep) => ({ ...ep, when: "last night" })),
      ...todayEps.map((ep) => ({ ...ep, when: "today" })),
    ];
    const tvMorningBlock = newEps.length > 0
      ? `\n\n[TV Shows — New Episodes]\n` +
        newEps.map((ep) => `• ${formatEpisodeForPrompt(ep)} (${ep.when})`).join("\n")
      : "";


    const sportsBlock = sportsScores ? formatSportsForPrompt(sportsScores) : "";

    const billsMorningBlock = upcomingBills.length > 0
      ? `\n\n[VERIFIED — Bills Database — Due in Next 3 Days]\n${formatBillsForPrompt(upcomingBills)}\nMention ONLY if due within 3 days, skip entirely otherwise.`
      : "";

    const datesBlock = upcomingDates.length > 0
      ? `\n\n[VERIFIED — Dates Database — Upcoming Birthdays & Anniversaries]\n${formatDatesForPrompt(upcomingDates)}`
      : "";

    const sundaySummaryBlock = isSunday && sundayData ? buildSundaySummaryBlock(sundayData) : "";

    const pickleballMorningBlock = isPickleballMorning && !sundaySummaryBlock
      ? `\n\n[Schedule Note]\nToday is a pickleball day for David (Mon/Wed/Fri/Sat schedule).`
      : "";

    const recFollowUpBlock = pendingFollowUps.length > 0
      ? buildRecommendationFollowUpBlock(pendingFollowUps)
      : "";

    // Use dedup-filtered Dallas block. If empty (all filtered or fetch failed),
    // inject a fallback marker so Claude delivers the "no events" line rather than silently skipping.
    const dallasEventsBlock = dedupedDallasBlock.trim().length > 0
      ? dedupedDallasBlock
      : `\n\n[What's Happening in ${primaryCity}]\nNo new local events found for today. In Section 11, say exactly: "Nothing new on the ${primaryCity} events front this morning." Do not skip this section silently.`;

    // morningWorkoutDone is always false at pre-generation time (5 AM) — no workout
    // has completed yet. This is computed from live calendar at delivery time if needed.
    const morningWorkoutDone = false;

    const motivationContextBlock = (() => {
      const tz = "America/Chicago";
      const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
      const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(dayName);
      const recentJournalSnippet = recentJournals.length > 0
        ? recentJournals.slice(0, 2).map(j => j.content.substring(0, 150)).join(" / ")
        : "";
      let block = `\n\n[Morning Motivation Context]\n`;
      block += `• Today is ${dayName}${isPickleballDay ? " — a pickleball day" : ""}\n`;
      if (morningWorkoutDone) block += `• MORNING WORKOUT ALREADY DONE — do NOT suggest exercise, a walk, or outdoor activity in the closing. Reference what is ahead instead.\n`;
      block += `• Journal entries this week: ${journalCountWeek}\n`;
      if (recentJournalSnippet) block += `• Recent journal themes: "${recentJournalSnippet}"\n`;
      block += `• Total family archive stories captured: ${totalStories}\n`;

      if (dailyMotivation) {
        block += `\n[VERIFIED — Web Search — Today's Inspiration]\n${dailyMotivation}\n`;
        block += `Use the above inspiration as the foundation for Section 15. Personalize it with something specific to David's day — upcoming events, the people in his life. Keep it to 2-3 sentences. Warm, genuine, not preachy.`;
      } else {
        block += `Use this context to craft a specific, warm 2-3 sentence motivating thought — reference upcoming events or journal themes. Morning only — do NOT suggest evening activities or memory recording.`;
      }
      return block;
    })();

    const profileContextBlock = buildProfileContext(
      userProfile ?? null,
      (userProfile?.rawData ?? {}) as CollectedData
    );

    const peopleContextBlock = buildPeopleContextBlock((userProfile?.rawData ?? {}) as CollectedData);

    // ── Split the system prompt into preamble (before email+calendar slot) ──────
    // and suffix (after email+calendar slot, through MASTER_BRIEFING_INSTRUCTION).
    // At delivery time, chat.ts inserts live gmailBlock + calendarBlock between them.
    const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, userName);
    const preamble = getCurrentDateTimeBlock() + "\n" + corePrompt + profileContextBlock +
      memoryBlock + dynamicProfileBlock + prefsBlock + notesBlock + peopleContextBlock + weatherBlock;

    const garminBlock = garminData ? formatGarminForBriefing(garminData) : "";
    const fitBlock = fitData ? formatFitForBriefing(fitData) : "";

    const personalFollowUpsBlock = buildPersonalFollowupsBlock(personalFollowUps);

    const suffix = garminBlock + fitBlock + tvMorningBlock + sportsBlock + billsMorningBlock + datesBlock +
      sundaySummaryBlock + pickleballMorningBlock + recFollowUpBlock + personalFollowUpsBlock + motivationContextBlock +
      dallasEventsBlock + dedupedVenueConcertsBlock + dedupedNewsBlock + buildBriefingInstruction(primaryCity, localCtx.venues ?? []);

    // Log which static sections have data
    const sectionLog: Record<string, boolean | string> = {
      "S1_greeting": true,
      "S2_weather_today": !!dallas,
      "S3_five_day_forecast": !!(dallas?.forecastDays && dallas.forecastDays.length > 0),
      "S4_pollen": !!pollenData,
      "S5_email": "live-at-delivery",
      "S6_calendar": "live-at-delivery",
      "S7_bills_3day": upcomingBills.length > 0,
      "S8_news": dedupedNewsBlock.length > 0,
      "S10_sports": !!(sportsScores),
      "S11_local_dallas": filteredDallasItems.length > 0 ? `${filteredDallasItems.length} items` : `EMPTY (fallback — raw:${rawDallasItems.length})`,
      "S12_music_events": filteredVenueConcerts.length > 0 ? `${filteredVenueConcerts.length} concerts` : "EMPTY",
      "S13_birthdays": upcomingDates.length > 0,
      "S14_motivation": true,
      "S16_sunday_special": isSunday,
    };
    logger.info({ userName, sections: sectionLog }, "[BRIEFING SECTIONS] Static data availability per section (email+calendar fetched live at delivery)");

    setStaticBriefingContext(userName, {
      preamble,
      suffix,
      candidateStoryKeys,
      dateKey: generationDateKey,
      builtAt: Date.now(),
    });

    logger.info(
      { userName, preambleChars: preamble.length, suffixChars: suffix.length, dateKey: generationDateKey },
      "Static briefing context cached — email and calendar will be fetched live at delivery"
    );
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing static context");
  }
}
