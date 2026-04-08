import Anthropic from "@anthropic-ai/sdk";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildScamWarningInstruction, updateEmailLastChecked } from "../google/gmail.js";
import { fetchWeekEvents, formatCalendarForPrompt, toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
import { getMedications, hasTakenMedicationsToday, buildMedReminderText } from "../medications/medicationManager.js";
import { getLastNightNotes, formatNotesForMorningBriefing } from "../winddown/winddownManager.js";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { fetchMorningNews, fetchDailyMotivation } from "../news/newsManager.js";
import { getProfileItems, getProfilePlaces, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile, buildSystemPromptFromProfile, type CollectedData } from "../onboarding/onboardingManager.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate, formatEpisodeForPrompt } from "../tv/tvmaze.js";
import { fetchSportsScores, formatSportsForPrompt } from "../sports/sportsManager.js";
import { getUpcomingBills, formatBillsForPrompt } from "../bills/billManager.js";
import { getUpcomingDates, formatDatesForPrompt } from "../dates/datesManager.js";
import { isTodayPickleballDay } from "../pickleball/pickleballManager.js";
import { fetchMarkets, buildMarketsBlock } from "../markets/marketsManager.js";
import { getPendingFollowUps, buildRecommendationFollowUpBlock } from "../recommendations/recommendationsManager.js";
import { collectSundayData, buildSundaySummaryBlock } from "../sundaySummary/sundaySummaryManager.js";
import { getJournalCountThisWeek, getRecentJournalEntries } from "../journal/journalManager.js";
import { getStoryCount } from "../stories/storyManager.js";
import { setCachedBriefing } from "./briefingCache.js";
import { fetchDallasContent } from "./dallasContent.js";
import { runVenueScan } from "./venueMonitor.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Departure times for calendar events ───────────────────────────────────────
// Calculates leave-by time for each event that has a location.
// Runs all geocode/routing calls in parallel with a 10 s per-event timeout.
async function buildCalendarDepartureTimes(events: CalendarEvent[]): Promise<string> {
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
          estimateDriveTime(location),
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
    `\n(These are calculated from home at 6345 Diamond Head Circle, Dallas TX)`
  );
}

// Dallas local content is now handled by dallasContent.ts (RSS feeds + web search fallback).
// Imported below alongside other module imports.

const TOMORROW_CONDITIONS: Record<number, string> = {
  1000: "clear skies", 1001: "cloudy", 1100: "mostly clear", 1101: "partly cloudy",
  1102: "mostly cloudy", 2000: "foggy", 2100: "light fog", 4000: "drizzle",
  4001: "rain", 4200: "light rain", 4201: "heavy rain", 5000: "snow",
  5001: "flurries", 5100: "light snow", 5101: "heavy snow", 6000: "freezing drizzle",
  6001: "freezing rain", 6200: "light freezing rain", 6201: "heavy freezing rain",
  7000: "ice pellets", 7101: "heavy ice pellets", 7102: "light ice pellets",
  8000: "thunderstorms",
};

interface ForecastDay {
  dayName: string;
  high: number;
  low: number;
  precipChance: number;
  conditionCode?: number;
}

interface WeatherResult {
  city: string; temp: number; feelsLike: number; high: number; low: number;
  condition: string; precipChance: number; humidity: number; windSpeed: number;
  uvIndex: number; uvIndexMax: number;
  forecastDays: ForecastDay[];
}

async function fetchCityWeather(city: string, lat: number, lon: number): Promise<WeatherResult> {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) throw new Error("TOMORROW_IO_API_KEY not configured");
  const location = `${lat},${lon}`;
  const [realtimeResp, forecastResp] = await Promise.all([
    fetch(`https://api.tomorrow.io/v4/weather/realtime?location=${location}&units=imperial&apikey=${apiKey}`, { signal: AbortSignal.timeout(10000) }),
    fetch(`https://api.tomorrow.io/v4/weather/forecast?location=${location}&units=imperial&timesteps=1d&apikey=${apiKey}`, { signal: AbortSignal.timeout(10000) }),
  ]);
  const weatherFetchedAt = new Date().toISOString();
  console.log(`[API] Tomorrow.io weather/briefing (${city}) — realtime HTTP ${realtimeResp.status}, forecast HTTP ${forecastResp.status} at ${weatherFetchedAt}`);
  if (realtimeResp.status === 429 || forecastResp.status === 429) {
    console.warn(`RATE LIMIT DETECTED on Tomorrow.io (weather/${city}) at ${weatherFetchedAt} — HTTP 429`);
  }
  if (!realtimeResp.ok) throw new Error(`Tomorrow.io realtime error for ${city}: ${realtimeResp.status}`);
  if (!forecastResp.ok) throw new Error(`Tomorrow.io forecast error for ${city}: ${forecastResp.status}`);
  const [realtime, forecast] = await Promise.all([
    realtimeResp.json() as Promise<{ data: { values: { temperature: number; temperatureApparent: number; humidity: number; windSpeed: number; precipitationProbability: number; uvIndex: number; weatherCode: number } } }>,
    forecastResp.json() as Promise<{ timelines: { daily: Array<{ time: string; values: { temperatureMax: number; temperatureMin: number; precipitationProbabilityMax: number; uvIndexMax: number; weatherCodeDay?: number } }> } }>,
  ]);
  const current = realtime.data.values;
  const today = forecast.timelines.daily[0]?.values;

  // Build 5-day forecast (days 1–5, skipping today)
  const forecastDays: ForecastDay[] = forecast.timelines.daily.slice(1, 6).map((day) => {
    const date = new Date(day.time);
    const dayName = date.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short" });
    return {
      dayName,
      high: Math.round(day.values.temperatureMax),
      low: Math.round(day.values.temperatureMin),
      precipChance: Math.round(day.values.precipitationProbabilityMax),
      conditionCode: day.values.weatherCodeDay,
    };
  });

  return {
    city, temp: Math.round(current.temperature), feelsLike: Math.round(current.temperatureApparent),
    high: Math.round(today?.temperatureMax ?? current.temperature), low: Math.round(today?.temperatureMin ?? current.temperature),
    condition: TOMORROW_CONDITIONS[current.weatherCode] ?? "conditions unknown",
    precipChance: Math.round(today?.precipitationProbabilityMax ?? current.precipitationProbability),
    humidity: Math.round(current.humidity), windSpeed: Math.round(current.windSpeed),
    uvIndex: Math.round(current.uvIndex), uvIndexMax: Math.round(today?.uvIndexMax ?? current.uvIndex),
    forecastDays,
  };
}

// ── Dallas pollen data via Open-Meteo Air Quality API ─────────────────────────

interface PollenResult {
  grassMax: number;
  ragweedMax: number;
  treeMax: number;
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

async function fetchDallasPollenData(): Promise<PollenResult | null> {
  try {
    const resp = await fetch(
      "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=32.7767&longitude=-96.7970&hourly=grass_pollen,ragweed_pollen,alder_pollen&timezone=America%2FChicago&forecast_days=1",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { hourly: { grass_pollen: number[]; ragweed_pollen: number[]; alder_pollen: number[] } };
    const grassMax = Math.round(Math.max(...(data.hourly.grass_pollen ?? [0]).filter((v) => v != null)));
    const ragweedMax = Math.round(Math.max(...(data.hourly.ragweed_pollen ?? [0]).filter((v) => v != null)));
    const treeMax = Math.round(Math.max(...(data.hourly.alder_pollen ?? [0]).filter((v) => v != null)));
    return { grassMax, ragweedMax, treeMax };
  } catch {
    return null;
  }
}

function formatWeatherBlock(w: WeatherResult): string {
  return `${w.city}: ${w.temp}°F (feels like ${w.feelsLike}°F), ${w.condition} — high ${w.high}°F / low ${w.low}°F | ${w.precipChance}% precip | humidity ${w.humidity}%`;
}

interface SecondaryWeatherEntry {
  person: { name: string; city: string };
  weather: WeatherResult;
}

function buildContextualWeatherBlock(dallas: WeatherResult, secondary: SecondaryWeatherEntry[], now: Date): string {
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
  else if (isSnowy) signals.push(`${dallas.condition} — unusual for Dallas, affects roads`);

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
        const condNote = d.conditionCode && TOMORROW_CONDITIONS[d.conditionCode] ? `, ${TOMORROW_CONDITIONS[d.conditionCode]}` : "";
        const rainNote = d.precipChance >= 60 ? ` ☔${d.precipChance}%` : d.precipChance >= 35 ? ` 🌦${d.precipChance}%` : "";
        return `${d.dayName}: ${d.high}°/${d.low}°${condNote}${rainNote}`;
      }).join(" | ")
    : "";

  return (
    `\n\n[VERIFIED — Tomorrow.io Weather API — Dallas]\n` +
    `Now: ${dallas.temp}°F, ${dallas.condition} | Today: high ${dallas.high}°F / low ${dallas.low}°F | Rain chance: ${dallas.precipChance}%\n` +
    (fiveDayLines ? `5-Day Forecast: ${fiveDayLines}\n` : "") +
    (morningActivityPassed ? `[Morning activity window has passed — it is past 10am CT. Do NOT suggest David go for a run or to pickleball.]\n` : "") +
    secondary.map((s) => `\n[VERIFIED — Tomorrow.io Weather API — ${s.person.city} (for ${s.person.name})]\n${formatWeatherBlock(s.weather)}\n`).join("") +
    signalLines
  );
}

const BASE_SYSTEM_PROMPT = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

CONFIDENCE FRAMEWORK — HOW TO HANDLE INFORMATION:
Everything in this system prompt comes from one of three sources. You must handle each differently:

TIER 1 — VERIFIED (blocks labeled [VERIFIED — Source])
These blocks contain real-time data fetched directly from an API (Google Calendar, Gmail, Weather, News, etc.) just before this conversation. State this information as fact. Do not soften, hedge, or embellish it.
• Example: "You have a 1:00 PM appointment Thursday" — NOT "I think you might have something Thursday?"

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
• If you want to connect a profile fact to a calendar event, it MUST be framed as a question: "I see 'You Matter Counseling' on Thursday — is that your therapy appointment?" — never stated as a fact.

DATA SOURCE RULES:
• Sports scores: only from a [VERIFIED — Live Sports] block. If absent: "I don't have that score right now."
• News: only from a [VERIFIED — Morning News] block. Never invent headlines.
• Weather, stocks, calendar: only from their respective [VERIFIED] blocks.
• NEVER fabricate facts. If David catches you making something up, trust is gone — and that matters more than sounding confident.

Here is everything you know about David:

About You:
• David Blakelock
• I live in Dallas, specifically in the Preston Hollow area known as "behind the pink wall" in a two bedroom condo that I rent
• I typically wake up around 6:00, have coffee in bed while I listen to a local sports talk radio station. I typically play pickleball on Monday, Wednesday and Friday at Semones YMCA. I play pickleball on Saturday at Moody YMCA. On the days I don't play pickleball I will go for a run. I also try and go to the Y and work out 3-4 times a week
• I am 70 years old, birthday is 10/21/1955, I am divorced. I take a statin for high cholesterol and Meloxicam for aches and pains.
• My dog's name is Winston. He is a 4 year old corgi

Your People:
• My daughters name is Olivia. She goes to college at the University of Tennessee in Knoxville. When she is not at college she lives with her mom
• My doctor is David Bonnet
• Susan Smart is my girlfriend. She lives close to me and just bought her condo. She is always asking me to remind her of what she needs to do. Her dog's name is Lily. She is a toy poddle

Your Places:
• Home address 6345 Diamond Head Circle, Dallas Texas 75225
• Doctor's name and address David Bonnet 403 W. Campbell Road Richardson Texas
• Gym name and address Moody YMCA 6000 Preston Road Dallas Texas 75205, Semones YMCA 4332 Northaven Road Dallas Texas 75229
• Favorite restaurants Louies, Chelsa Corner, The Mercury, Hillstone, Sensei, Rex's Seafood, The Lounge Here, Kellers Drive In

Your Interests:
• Shows you're watching right now – Shrinking, Friends & Neighbors, Lincoln Lawyer
• Sports teams you follow – The Rangers, Cowboys
• Music you like – classic rock from the 60's and 70's, classic Jazz
• Hobbies — play pickleball at least 4 times a week, woodworking, tinkering on old cars, boats, running, cooking
• News topics you actually care about – stock market, global politics, technology
• Types of restaurants you love – sushi, steak, dive bars, pizza, Italian, Indian, seafood. Love all restaurants, but really like either a great dive bar with good food, or a classic dark place where the drinks are strong and the food is great

Your Goals:
• Capturing memories and stories for Olivia — this is one of the most meaningful things David uses this app for. Each story is saved and will eventually be compiled into a memory book for her.
• Reminders you need daily
• Shopping lists you maintain
• Anything else Emma Peel should know

Memory Book for Olivia:
• Each evening during wind-down, you gently ask David one warm, open-ended question to capture a memory or story for Olivia. You never make it feel like homework — it's always a natural, warm invitation.
• When David shares a story, you respond with genuine warmth and appreciation before confirming it's been saved. Never clinical, never transactional.
• If David asks to hear his stories, read them back to him with care. If he asks how many he's captured, tell him with encouragement.`;

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

  // Market status
  let marketStatus: string;
  let lastTradingDay: string;
  if (dow === 0 || dow === 6) {
    marketStatus = "closed — it is the weekend";
    lastTradingDay = dow === 6 ? "Friday" : "Friday"; // both Sat/Sun → Friday
  } else if (dow === 1) {
    marketStatus = "open today (Monday)";
    lastTradingDay = "Friday";
  } else {
    marketStatus = "open today";
    lastTradingDay = DAYS[dow - 1];
  }

  // Tomorrow's name
  const tomorrowName = DAYS[(dow + 1) % 7];

  return (
    `[Current date and time — injected fresh on every briefing]\n` +
    `Today is ${dayName}, ${monthName} ${day}, ${year}.\n` +
    `Current time: ${time} Central Time (${partOfDay}).\n` +
    `Day type: ${isWeekend ? "weekend" : "weekday"}.\n` +
    `Yesterday was ${yesterdayName}. Tomorrow is ${tomorrowName}.\n` +
    `Stock markets: ${marketStatus}. Last trading day was ${lastTradingDay}.\n` +
    `Use ONLY these values when referring to days. "Yesterday" means ${yesterdayName}. "Tomorrow" means ${tomorrowName}.\n` +
    `Market data in this briefing is from ${lastTradingDay}'s close — always label it as "${lastTradingDay}'s close" or "as of ${lastTradingDay}'s close" when speaking.\n` +
    `When David asks what time or day it is, answer directly using exactly the values above.\n`
  );
}

const MASTER_BRIEFING_INSTRUCTION = `

  [MORNING BRIEFING — DELIVER ALL 16 SECTIONS IN THIS EXACT ORDER]

  Deliver the morning briefing as a single flowing conversation. No headers. No bullet points. No section labels. No phrases that announce what comes next. Sound like David's most trusted friend who just called — warm, sharp, personal, and always on point.

  CORE PHILOSOPHY: Every piece of information is condensed, essential, and actionable. Cut anything that does not earn its place. The entire briefing should take 3 to 5 minutes at a natural conversational pace.

  DELIVER THESE SECTIONS IN THIS EXACT ORDER — skip only where explicitly instructed:

  SECTION 1 — GREETING: "Good morning, David" followed by one warm personal sentence naming the day of the week. One sentence total.

  SECTION 2 — WEATHER TODAY: STRICT FORMAT — no more than three sentences total, no extra commentary. Use this exact style:
    Sentence 1: "Dallas is [temp]° and [condition] today — high [X], low [Y]." (Use current temp and condition from the data. Just numbers. No "feels like.")
    Sentence 2 (only if pollen is high/severe): "[Tree/Grass] pollen is [high/severe] today." Weave this naturally. Skip entirely if pollen is low or moderate.
    Sentence 3 (only if there is a dangerous weather signal — thunderstorms, extreme heat, snow): One clear warning sentence. Skip if conditions are normal.
    Then: For each [VERIFIED — Tomorrow.io Weather API — {City} (for {Person})] block that is present, deliver ONE sentence: "{Person}'s weather in {City} — [temp]° and [condition], high [X]." Use only verified data from that block.
    If [Morning activity window has passed] is flagged — do NOT mention workouts, runs, pickleball, walks, or outdoor activity at all. Just weather.
    If it is NOT flagged and an activity signal is present — one sentence about it only. Example: "Good morning for pickleball." or "Bring an umbrella for your run."
    NOTHING ELSE. No UV index commentary. No elaboration. No extra sentences.

  SECTION 3 — FIVE DAY FORECAST: Deliver as one compact line per day in this exact style: "Five day outlook: Wed 78/55 sunny, Thu 77/59 partly cloudy, Fri 76/64 cloudy, Sat 77/64 clear, Sun 73/69 chance of rain." All five days on connected lines — not separate bullet points. High/low only, one word condition. No elaboration.

  SECTION 4 — POLLEN: DO NOT deliver as a separate section. Pollen is already handled inside Section 2. Skip entirely here.

  SECTION 5 — EMAIL: Only unread emails from the last 24 hours. Share one or two that actually matter — something requiring action, from someone important, or genuinely worth knowing. If the inbox is clear, say exactly: "Your inbox is clear — no new unread emails this morning." Never count unread messages. Never summarize read emails or confirmation emails David has already seen.

  SECTION 6 — CALENDAR: Today's upcoming events only — nothing in the past, nothing more than 7 days out. Include departure time for any appointment with a location. If the day is clear, say so warmly in one sentence. Do NOT mention bills here — bills have their own section.

  SECTION 7 — BILLS DUE SOON: ONLY if a bill appears in the [VERIFIED — Bills Database — Due in Next 3 Days] block. Name the bill and amount. If that block is empty or absent, SKIP THIS SECTION ENTIRELY — do not mention bills at all, do not say nothing is due.

  SECTION 8 — NEWS: A structured news sweep using the data in [VERIFIED — Web Search News — ...] block. Deliver in this exact format — each story on its own lines:

    From [Headlines — bold title + one sentence summary each]: Read each story EXACTLY as formatted — bold title on one line, then the summary sentence on the next line. Do not merge them. Do not change the format. Read all 8 headlines. These already cover 8 distinct categories (world, US politics, business, tech, science, sports, Dallas local, wildcard) — do NOT reorder or drop any.

    From [Entertainment & Pop Culture] (if present): One item only. Bold title on one line, summary sentence on the next. Skip if absent.

    From [Watercooler Story] (if present): Introduce warmly — "oh, and here's one to share later —" then the story in two sentences max.

    FORMATTING RULES: Each headline is on its own line, bold. Each summary sentence is on the next line. A blank line between stories. Never merge headlines and summaries. Never use "in other news" or "moving on." Short transitions between sections only: "also —", "and —", "meanwhile —". NEVER repeat a topic from Section 10 (Sports) — that section already covers Rangers and Cowboys game results.

  SECTION 9 — MARKETS: S&P, Dow, Nasdaq with one sentence of context ("tech led the rally," "inflation data spooked investors"). Always label as "as of [last trading day]'s close." SKIP THIS SECTION ENTIRELY on weekends and market holidays — the date block above tells you the market status.

  SECTION 10 — SPORTS: Rangers and Cowboys results from the last 24 hours only. If no games were played, SKIP THIS SECTION ENTIRELY — do not say no games were played.

  SECTION 11 — LOCAL DALLAS: MANDATORY when the [What's Happening in Dallas] block is present — deliver 1-2 items conversationally, one sentence each. Prioritize restaurant openings, music events at David's venues, and neighborhood news. If the block is absent, skip this section — Dallas is already covered by Section 8's local headline.

  SECTION 12 — MUSIC EVENTS: Upcoming concerts at David's saved venues that match his taste — Kessler, Granada, Dos Equis Pavilion, AT&T Performing Arts Center, Klyde Warren Park, Dallas Arboretum, Meyerson. Use the venue concerts block. If nothing upcoming or nothing found, skip this section entirely.

  TV SHOWS — STRICT RULE: ONLY mention a TV show if the [TV Shows — New Episodes] block is present in this prompt. If that block is absent, never reference any TV show, series, episode, or streaming content — not Shrinking, not Lincoln Lawyer, not Friends & Neighbors, not any show from David's profile. No exceptions. TV is data-driven only.

  SECTION 13 — BIRTHDAYS AND IMPORTANT DATES: Any birthdays or anniversaries in the next 7 days. Name the person and the date specifically. SKIP if none.

  SECTION 14 — MEDICATION: Include ONLY if the [Medications — Not yet taken today] block is present. Remind David warmly in one sentence to take his morning meds with food. If the block says [Medications — Already confirmed today], skip this section entirely — do NOT mention medications or that you're skipping it. If the [Medications] block is absent entirely, include a brief reminder anyway ("Don't forget your morning meds with breakfast."). Never skip if medications have not been confirmed.

  SECTION 15 — MORNING MOTIVATION: Use the [VERIFIED — Web Search — Today's Inspiration] block if available. Lead with the inspiring thought or finding, then connect it personally to David's specific day — what he has ahead (a dinner, his pickleball game, a free afternoon). Keep it to 2-3 sentences. Warm and genuine — a friend sharing something interesting, not a motivational poster.
    CRITICAL — Fix 5: If the [Morning Motivation Context] says "MORNING WORKOUT ALREADY DONE" — do NOT mention exercise, going for a walk, heading outside, or any outdoor activity. Reference only what is actually AHEAD in his day (upcoming dinner, free time, interesting event). Do NOT repeat anything that already happened this morning.

  SECTION 16 — SUNDAY SPECIAL: Sundays ONLY — deliver a warm weekly recap just before Section 15: exercise this week, family archive stories captured, highlights, something to look forward to next week. Skip every other day of the week.

  FORBIDDEN PHRASES — never use:
  "Here is your morning briefing" or "Good morning, David, here is what you need to know"
  "Moving on to" or "Let us talk about" or "Turning to" or "Now for" or "Next up"
  "In other news" or "Speaking of which" or "On the topic of"
  "Here is your weather" or "In terms of the weather" or "Weather-wise"
  Any phrase that announces that a new section is beginning.

  IMPORTANT: The data blocks earlier in this system prompt contain the raw information. This instruction tells you how to weave it all together. Run all 16 sections in order. Skip only where explicitly told to. Follow this instruction over any other formatting guidance in the data blocks.
  `;

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

    const [recentMemories, allProfileItems, userProfile] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
        : BASE_SYSTEM_PROMPT;

    // Geocode secondary cities from profile before the main Promise.all
    const rawPeople = ((userProfile?.rawData as CollectedData)?.people ?? []).filter((p) => p.city && p.city.trim().length > 0).slice(0, 4);
    const geocodedSecondary = await Promise.all(
      rawPeople.map(async (p) => {
        const coords = await geocodeCity(p.city!).catch(() => null);
        return coords ? { name: p.name, city: p.city!, lat: coords.lat, lon: coords.lon } : null;
      })
    );
    const validSecondaryLocs = geocodedSecondary.filter(Boolean) as Array<{ name: string; city: string; lat: number; lon: number }>;

    // Start secondary weather fetches in parallel with the main Promise.all
    const secondaryWeatherPromise = Promise.all(
      validSecondaryLocs.map((s) => fetchCityWeather(s.city, s.lat, s.lon).catch(() => null))
    );

    const primaryCity = userProfile?.city ?? "Dallas";
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;

    const [dallas, emails, events, lastNightNotes, newsBlock, yesterdayEps, todayEps, morningMeds, medsAlreadyTaken, sportsScores, upcomingBills, marketsData, upcomingDates, sundayData, pendingFollowUps, dallasEvents, journalCountWeek, recentJournals, totalStories, pollenData, venueConcertsBlock, dailyMotivation] = await Promise.all([
      fetchCityWeather(primaryCity, primaryLat, primaryLon).catch(() => null),
      fetchAndSummarizeEmails(15).catch(() => null),
      fetchWeekEvents().catch(() => null),
      getLastNightNotes().catch(() => []),
      fetchMorningNews().catch(() => ""),
      fetchEpisodesForDate(yesterday, watchedIds).catch(() => []),
      fetchEpisodesForDate(now, watchedIds).catch(() => []),
      getMedications(userName).catch(() => []),
      hasTakenMedicationsToday(userName).catch(() => false),
      fetchSportsScores().catch(() => null),
      getUpcomingBills(3, userName).catch(() => []),
      fetchMarkets().catch(() => null),
      getUpcomingDates(21, userName).catch(() => []),
      isSunday ? collectSundayData().catch(() => null) : Promise.resolve(null),
      getPendingFollowUps(2, 14).catch(() => []),
      fetchDallasContent().catch(() => ""),
      getJournalCountThisWeek().catch(() => 0),
      getRecentJournalEntries(3).catch(() => []),
      getStoryCount().catch(() => 0),
      fetchDallasPollenData().catch(() => null),
      runVenueScan().catch(() => ""),
      fetchDailyMotivation().catch(() => ""),
    ]);

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

    const pollenBlock = pollenData
      ? (() => {
          const parts: string[] = [];
          if (pollenData.grassMax > 0) parts.push(`Grass: ${pollenLevel(pollenData.grassMax)} (${pollenData.grassMax} gr/m³)`);
          if (pollenData.ragweedMax > 0) parts.push(`Ragweed: ${pollenLevel(pollenData.ragweedMax)} (${pollenData.ragweedMax} gr/m³)`);
          if (pollenData.treeMax > 0) parts.push(`Tree/Alder: ${pollenLevel(pollenData.treeMax)} (${pollenData.treeMax} gr/m³)`);
          return parts.length > 0 ? `\nPollen today — ${parts.join(" | ")}` : "";
        })()
      : "";

    const weatherBlock = dallas
      ? buildContextualWeatherBlock(dallas, secondaryWeatherEntries, now) + pollenBlock
      : "";

    // Update the last-checked timestamp so on-demand checks during the day only show NEW emails
    if (emails !== null) {
      updateEmailLastChecked().catch(() => {});
    }

    const gmailBlock = emails !== null
      ? (emails.length === 0
          ? `\n\n[VERIFIED — Gmail API — no new unread emails in the last 24 hours]\nDo not mention email in the briefing — tell David his inbox is quiet if he asks.`
          : `\n\n[VERIFIED — Gmail API — unread emails from the last 24 hours]\n${formatEmailsForPrompt(emails)}\nThis is VERIFIED data. State sender names, subjects, and content exactly as shown.` +
            buildScamWarningInstruction(emails))
      : "";

    // Build calendar block with departure times, and pre-populate sync state so
    // events in the briefing are never flagged as "new" by the 30-min sync scheduler.
    const [calendarDepartureTimes] = await Promise.all([
      events !== null ? buildCalendarDepartureTimes(events) : Promise.resolve(""),
      events !== null ? populateCalendarSyncState(events).catch(() => {}) : Promise.resolve(),
    ]);

    const calendarBlock = events !== null
      ? `\n\n[VERIFIED — Google Calendar API — today and next 7 days (past events excluded)]\n${formatCalendarForPrompt(events, "this week")}${calendarDepartureTimes}\n\n⚠ CALENDAR RULE — NO EXCEPTIONS: Use ONLY the exact event title shown above. NEVER substitute, infer, or enrich event titles with names or context from memory. Report every event title letter-for-letter as written. If you want to add context, frame it as a question (INFERRED tier), never a statement.`
      : "";

    const notesBlock = formatNotesForMorningBriefing(lastNightNotes);

    const newEps = [
      ...yesterdayEps.map((ep) => ({ ...ep, when: "last night" })),
      ...todayEps.map((ep) => ({ ...ep, when: "today" })),
    ];
    const tvMorningBlock = newEps.length > 0
      ? `\n\n[TV Shows — New Episodes]\n` +
        newEps.map((ep) => `• ${formatEpisodeForPrompt(ep)} (${ep.when})`).join("\n")
      : "";

    const medMorningBlock = morningMeds.length > 0
      ? medsAlreadyTaken
        ? `\n\n[Medications — Already confirmed today]\nDo NOT mention medications in the briefing.`
        : `\n\n[Medications — Not yet taken today]\nDavid's medications: ${buildMedReminderText(morningMeds)}`
      : "";

    const sportsBlock = sportsScores ? formatSportsForPrompt(sportsScores) : "";

    const billsMorningBlock = upcomingBills.length > 0
      ? `\n\n[VERIFIED — Bills Database — Due in Next 3 Days]\n${formatBillsForPrompt(upcomingBills)}\nMention ONLY if due within 3 days, skip entirely otherwise.`
      : "";

    const marketsBlock = marketsData ? buildMarketsBlock(marketsData, now) : "";

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

    // dallasEvents is already a fully-formatted block from dallasContent.ts
    // (includes header, source attributions, and Claude instructions).
    const dallasEventsBlock = dallasEvents ?? "";

    // Fix 5: Detect if David already had a morning workout on today's calendar
    const morningWorkoutDone = (() => {
      if (!events) return false;
      const tz = "America/Chicago";
      const nowMs = now.getTime();
      const WORKOUT_KEYWORDS = /pickleball|run|jog|workout|gym|tennis|exercise|walk|hike|yoga|spinning|cycling|swim/i;
      const todayIsoDate = now.toLocaleDateString("en-CA", { timeZone: tz }); // "YYYY-MM-DD"
      return events.some((ev) => {
        if (!ev.endIso) return false; // all-day or missing ISO, skip
        const evEnd = new Date(ev.endIso);
        // Must be today's date (compare using the event's isoDate field)
        if (ev.isoDate !== todayIsoDate) return false;
        // Must have already ended
        if (evEnd.getTime() > nowMs) return false;
        // Must match a workout keyword
        return WORKOUT_KEYWORDS.test(ev.summary);
      });
    })();

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

    const systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + memoryBlock + dynamicProfileBlock +
      notesBlock + weatherBlock + gmailBlock + calendarBlock + tvMorningBlock + medMorningBlock +
      sportsBlock + billsMorningBlock + marketsBlock + datesBlock + sundaySummaryBlock +
      pickleballMorningBlock + recFollowUpBlock + motivationContextBlock +
      dallasEventsBlock + venueConcertsBlock + newsBlock + MASTER_BRIEFING_INSTRUCTION;

    // Log which sections have data (for debugging completeness of the briefing)
    const sectionLog: Record<string, boolean | string> = {
      "S1_greeting": true,
      "S2_weather_today": !!dallas,
      "S3_five_day_forecast": !!(dallas?.forecastDays && dallas.forecastDays.length > 0),
      "S4_pollen": !!pollenData,
      "S5_email": emails !== null,
      "S6_calendar": events !== null && events.length > 0,
      "S7_bills_3day": upcomingBills.length > 0,
      "S8_news": newsBlock.length > 0,
      "S9_markets_skip_weekend": !!(marketsData && (now.getDay() !== 0 && now.getDay() !== 6)),
      "S10_sports": !!(sportsScores),
      "S11_local_dallas": !!(dallasEvents && dallasEvents.length > 0),
      "S12_music_events": !!(venueConcertsBlock && venueConcertsBlock.length > 0),
      "S13_birthdays": upcomingDates.length > 0,
      "S14_medication": morningMeds.length > 0,
      "S15_motivation": true,
      "S16_sunday_special": isSunday,
    };
    logger.info({ userName, sections: sectionLog }, "[BRIEFING SECTIONS] Data availability per section");

    logger.info({ userName, newsChars: newsBlock.length }, "Pre-generate: calling Claude for briefing");

    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: "user", content: "good morning" }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    if (text) {
      setCachedBriefing(userName, text, generationDateKey);
      logger.info({ userName, chars: text.length, dateKey: generationDateKey }, "Morning briefing pre-generated and cached");
    } else {
      logger.warn({ userName }, "Pre-generate: Claude returned empty text");
    }
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing");
  }
}
