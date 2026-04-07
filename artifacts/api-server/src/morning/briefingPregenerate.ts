import Anthropic from "@anthropic-ai/sdk";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildScamWarningInstruction } from "../google/gmail.js";
import { fetchWeekEvents, formatCalendarForPrompt, toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
import { getMedications, hasTakenMedicationsToday, buildMedReminderText } from "../medications/medicationManager.js";
import { getLastNightNotes, formatNotesForMorningBriefing } from "../winddown/winddownManager.js";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { fetchMorningNews } from "../news/newsManager.js";
import { getProfileItems, getProfilePlaces, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile, buildSystemPromptFromProfile, type CollectedData } from "../onboarding/onboardingManager.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate, formatEpisodeForPrompt } from "../tv/tvmaze.js";
import { fetchSportsScores, formatSportsForPrompt } from "../sports/sportsManager.js";
import { getUpcomingBills, formatBillsForPrompt } from "../bills/billManager.js";
import { getUpcomingDates, formatDatesForPrompt } from "../dates/datesManager.js";
import { isTodayPickleballDay, hasRecentKneeIssue } from "../pickleball/pickleballManager.js";
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
        const sourceNote = drive.source === "osrm" ? "based on route" : "estimated";
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

function buildContextualWeatherBlock(dallas: WeatherResult, knoxville: WeatherResult, now: Date): string {
  const tz = "America/Chicago";
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const pickleballDays = ["Monday", "Wednesday", "Friday", "Saturday"];
  const isPickleballDay = pickleballDays.includes(dayName);
  const activityLabel = isPickleballDay ? "pickleball" : "a run";
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
  if (isStormy) signals.push(`THUNDERSTORMS — outdoor plans are off`);
  else if (isSnowy) signals.push(`${dallas.condition} — unusual for Dallas, affects roads and outdoor plans`);
  else if (isRainy && likelyRain) signals.push(`Rain likely (${dallas.precipChance}%) — treadmill/indoor court is the smart call for ${activityLabel}`);
  else if (likelyRain) signals.push(`${dallas.precipChance}% rain chance — outdoor ${activityLabel} is risky, going early helps`);
  else if (possibleRain) signals.push(`${dallas.precipChance}% rain chance — keep an eye on timing for ${activityLabel}`);
  if (isFoggy) signals.push(`Morning fog — matters for running outside and early driving`);
  if (isVeryHot) signals.push(`Extreme heat (high ${dallas.high}°F) — dangerous for prolonged outdoor activity, go very early and hydrate aggressively`);
  else if (isHot) signals.push(`Hot day (high ${dallas.high}°F) — extra hydration needed for ${activityLabel}`);
  else if (isWarm) signals.push(`Warm day building (high ${dallas.high}°F) — hydrate well for ${activityLabel}`);
  if (isCold) signals.push(`Cold morning (${dallas.temp}°F, feels ${dallas.feelsLike}°F) — layers, proper warm-up before hard effort`);
  else if (isCool) signals.push(`Cool morning (${dallas.temp}°F) — light jacket to start, great once moving`);
  if (isHighWind) signals.push(`Winds at ${dallas.windSpeed} mph — gusty for outdoor play or a run`);
  if (!isStormy && !isRainy && uvMax >= 8) signals.push(`UV peaks at ${uvMax} (${uvLabel}) — sunscreen is non-negotiable outdoors`);
  else if (!isStormy && !isRainy && uvMax >= 6) signals.push(`UV peaks at ${uvMax} (${uvLabel}) — sunscreen before heading out`);
  if (isPerfect) signals.push(`PERFECT conditions for ${activityLabel} — lead with this${uvMax >= 6 ? `, mention sunscreen (UV ${uvMax})` : ""}`);

  // Activity-aware alerts for upcoming pickleball days in the 5-day forecast
  const pickleballShortNames = ["Mon", "Wed", "Fri", "Sat"];
  for (const day of dallas.forecastDays) {
    if (pickleballShortNames.includes(day.dayName)) {
      if (day.precipChance >= 60) {
        signals.push(`⚠ ${day.dayName} pickleball: rain likely (${day.precipChance}%) — may need to reschedule`);
      } else if (day.high >= 98) {
        signals.push(`⚠ ${day.dayName} pickleball: extreme heat (${day.high}°F) — go very early or consider indoor`);
      }
    }
  }

  const signalLines = signals.length > 0
    ? `\nKey signals for briefing:\n${signals.map((s) => `• ${s}`).join("\n")}`
    : `\n• Conditions are unremarkable — weave in naturally`;

  // 5-day forecast block (days 1–5 after today)
  const fiveDayLines = dallas.forecastDays.length > 0
    ? dallas.forecastDays.map((d) => {
        const condNote = d.conditionCode ? (TOMORROW_CONDITIONS[d.conditionCode] ? ` — ${TOMORROW_CONDITIONS[d.conditionCode]}` : "") : "";
        const rainNote = d.precipChance >= 60 ? ` ☔ ${d.precipChance}%` : d.precipChance >= 35 ? ` 🌦 ${d.precipChance}%` : "";
        return `${d.dayName}: ${d.high}°↑ / ${d.low}°↓${condNote}${rainNote}`;
      }).join(" | ")
    : "";

  return (
    `\n\n[Live Weather Data — Dallas, via Tomorrow.io, fetched now]\n` +
    `Current: ${dallas.temp}°F (feels like ${dallas.feelsLike}°F), ${dallas.condition}\n` +
    `Today: low ${dallas.low}°F → high ${dallas.high}°F | Rain: ${dallas.precipChance}% | Humidity: ${dallas.humidity}% | Wind: ${dallas.windSpeed} mph\n` +
    `UV now: ${dallas.uvIndex} | UV peak today: ${dallas.uvIndexMax} (${uvLabel})\n` +
    (fiveDayLines ? `5-Day: ${fiveDayLines}\n` : "") +
    `\n[Knoxville (Olivia's weather)]\n${formatWeatherBlock(knoxville)}\n` +
    `\nToday is ${dayName}. David's morning activity: ${activityLabel}.` +
    signalLines
  );
}

const BASE_SYSTEM_PROMPT = `You are Emma Peel — David's sharp, warm, and deeply trusted personal AI companion. You know David's life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless David clearly wants more. Never start a response with "I" as the first word. When David needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

CRITICAL — HONESTY ABOUT WHAT YOU KNOW:
You only know what has been explicitly given to you in this conversation's context blocks (marked with [brackets]). You do NOT have access to the internet, live news, real-time data, or any information beyond what is injected below.

• Sports scores: ONLY report scores that appear in a [Live Sports Scores] block in your context. If no sports block is present and David asks for a score, say: "I don't have that score in front of me right now — I can pull it up if you say 'check the Rangers score' or ask for your morning briefing."
• News: ONLY reference articles that appear in a [Morning News] block. Never invent headlines, outcomes, or facts.
• Stock prices, weather, calendar events: same rule — only report what is explicitly provided in a context block.
• If you are uncertain about any fact, say so. "I'm not sure about that one" is always better than a confident guess that turns out to be wrong.
• NEVER fabricate scores, statistics, game outcomes, news stories, or any factual information. If David catches you making something up, it destroys trust — and that matters more than sounding confident.

Here is everything you know about David:

About You:
• David Blakelock
• I live in Dallas, specifically in the Preston Hollow area known as "behind the pink wall" in a two bedroom condo that I rent
• I typically wake up around 6:00, have coffee in bed while I listen to a local sports talk radio station. I typically play pickleball on Monday, Wednesday and Friday at Semones YMCA. I play pickleball on Saturday at Moody YMCA. On the days I don't play pickleball I will go for a run. I also try and go to the Y and work out 3-4 times a week
• I am 70 years old, birthday is 10/21/1955, I am divorced. I take a statin for high cholesterol and Meloxicam for aches and pains. I see my therapist every Thursday at 1:00. His name is Scott Blair
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

  SECTION 2 — WEATHER TODAY: Current Dallas conditions, today's high and low, UV index. If he has a calendar event where weather matters (a run, outdoor event, travel), connect the weather to it. Two to three sentences.

  SECTION 3 — FIVE DAY FORECAST: One line per day — the next five days. Day name, conditions, high/low. Keep it concise — exactly one sentence per day. No elaboration.

  SECTION 4 — POLLEN: Current Dallas pollen levels from the pollen data block. If levels are high, give one sentence of practical advice. If pollen data is unavailable, skip this section entirely.

  SECTION 5 — EMAIL: Only emails from the last 24 hours. Share one or two that actually matter — something he needs to act on, something from someone important, or something he would genuinely want to know. If his inbox is quiet, say "Inbox has been quiet since yesterday." Never count unread messages. Never mention email if there is nothing worth flagging.

  SECTION 6 — CALENDAR: Today's upcoming events only — nothing in the past, nothing more than 7 days out. Include departure time for any appointment with a location. If the day is clear, say so warmly in one sentence. Do NOT mention bills here — bills have their own section.

  SECTION 7 — BILLS DUE SOON: ONLY if a bill appears in the [Bills Due in Next 3 Days] block. Name the bill and amount. If that block is empty or absent, SKIP THIS SECTION ENTIRELY — do not mention bills at all, do not say nothing is due.

  SECTION 8 — NEWS: Exactly three stories, delivered as one fast, conversational sweep. Map one story from each of these three blocks in the news data:
    • From [Main Stories]: Pick the single most relevant story to David — politics, economy, markets, AI/tech, or his teams.
    • From [Also Worth Knowing]: Pick the one most notable cultural, business, or entertainment story.
    • From [Light & Surprising Stories]: Pick the best single watercooler story — something fun, surprising, or share-worthy. ALWAYS include this third story — never skip it, even if it seems light. Introduce it with something like "oh, and one that'll make you smile —" or "and here's one worth sharing later —".
    Never use stories older than 48 hours. Each story: one to two sentences max. Short brisk transitions only: "also —", "meanwhile —", "oh, and —". Never say "in other news." If any tier block is missing or empty, skip that tier only and still deliver the others. Keep moving.

  SECTION 9 — MARKETS: S&P, Dow, Nasdaq with one sentence of context ("tech led the rally," "inflation data spooked investors"). Always label as "as of [last trading day]'s close." SKIP THIS SECTION ENTIRELY on weekends and market holidays — the date block above tells you the market status.

  SECTION 10 — SPORTS: Rangers and Cowboys results from the last 24 hours only. If no games were played, SKIP THIS SECTION ENTIRELY — do not say no games were played.

  SECTION 11 — LOCAL DALLAS: One or two items from CultureMap, Dallas Observer, or D Magazine from the last 72 hours. Prioritize: new restaurant openings, music events at David's saved venues, outdoor events. One to two sentences total. Skip if nothing fresh.

  SECTION 12 — MUSIC EVENTS: Upcoming concerts at David's saved venues that match his taste — Kessler, Granada, Dos Equis Pavilion, AT&T Performing Arts Center, Klyde Warren Park, Dallas Arboretum, Meyerson. Use the venue concerts block. If nothing upcoming or nothing found, skip this section entirely.

  SECTION 13 — BIRTHDAYS AND IMPORTANT DATES: Any birthdays or anniversaries in the next 7 days. Name the person and the date specifically. SKIP if none.

  SECTION 14 — MEDICATION: Always include this — even if the [Medications] block is absent. David takes a statin and Meloxicam every morning with food. Remind him in one sentence. Never skip this section.

  SECTION 15 — MORNING MOTIVATION: One brief, genuine, personal observation about David's specific day. NOT a generic quote. NOT a pep talk. NOT a reminder to do things tonight. Use the motivation context block — reference his pickleball schedule, journal themes, or something real and positive about today. Two to three sentences max. A friend noticing something specific, not a motivational poster. Do NOT suggest he record memories or do anything in the evening — that is for the wind-down, not the morning briefing.

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
  logger.info({ userName }, "Pre-generating morning briefing");
  try {
    const watchedShows = await getWatchedShows().catch(() => []);
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const isSunday = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long" }) === "Sunday";
    const isPickleballMorning = isTodayPickleballDay();

    const [recentMemories, allProfileItems, userProfile] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems().catch(() => []),
      getProfile(userName).catch(() => null),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
        : BASE_SYSTEM_PROMPT;

    const [dallas, knoxville, emails, events, lastNightNotes, newsBlock, yesterdayEps, todayEps, morningMeds, medsAlreadyTaken, sportsScores, upcomingBills, marketsData, upcomingDates, sundayData, pendingFollowUps, kneeIssueRecent, dallasEvents, journalCountWeek, recentJournals, totalStories, pollenData, venueConcertsBlock] = await Promise.all([
      fetchCityWeather("Dallas", 32.7767, -96.7970).catch(() => null),
      fetchCityWeather("Knoxville", 35.9606, -83.9207).catch(() => null),
      fetchAndSummarizeEmails(15).catch(() => null),
      fetchWeekEvents().catch(() => null),
      getLastNightNotes().catch(() => []),
      fetchMorningNews().catch(() => ""),
      fetchEpisodesForDate(yesterday, watchedIds).catch(() => []),
      fetchEpisodesForDate(now, watchedIds).catch(() => []),
      getMedications().catch(() => []),
      hasTakenMedicationsToday().catch(() => false),
      fetchSportsScores().catch(() => null),
      getUpcomingBills(3).catch(() => []),
      fetchMarkets().catch(() => null),
      getUpcomingDates(21).catch(() => []),
      isSunday ? collectSundayData().catch(() => null) : Promise.resolve(null),
      getPendingFollowUps(2, 14).catch(() => []),
      hasRecentKneeIssue(5).catch(() => false),
      fetchDallasContent().catch(() => ""),
      getJournalCountThisWeek().catch(() => 0),
      getRecentJournalEntries(3).catch(() => []),
      getStoryCount().catch(() => 0),
      fetchDallasPollenData().catch(() => null),
      runVenueScan().catch(() => ""),
    ]);

    const pollenBlock = pollenData
      ? (() => {
          const parts: string[] = [];
          if (pollenData.grassMax > 0) parts.push(`Grass: ${pollenLevel(pollenData.grassMax)} (${pollenData.grassMax} gr/m³)`);
          if (pollenData.ragweedMax > 0) parts.push(`Ragweed: ${pollenLevel(pollenData.ragweedMax)} (${pollenData.ragweedMax} gr/m³)`);
          if (pollenData.treeMax > 0) parts.push(`Tree/Alder: ${pollenLevel(pollenData.treeMax)} (${pollenData.treeMax} gr/m³)`);
          return parts.length > 0 ? `\nPollen today — ${parts.join(" | ")}` : "";
        })()
      : "";

    const weatherBlock = dallas && knoxville
      ? buildContextualWeatherBlock(dallas, knoxville, now) + pollenBlock
      : (dallas ? `\n\n[Dallas Weather]\n${formatWeatherBlock(dallas)}` + pollenBlock : "");

    const gmailBlock = emails !== null
      ? (emails.length === 0
          ? `\n\n[Gmail — no new emails in the last 24 hours]\nDo not mention email in the briefing — tell David his inbox is quiet if he asks.`
          : `\n\n[Gmail — emails received in the last 24 hours (fetched just now)]\n${formatEmailsForPrompt(emails)}` +
            buildScamWarningInstruction(emails))
      : "";

    // Build calendar block with departure times, and pre-populate sync state so
    // events in the briefing are never flagged as "new" by the 30-min sync scheduler.
    const [calendarDepartureTimes] = await Promise.all([
      events !== null ? buildCalendarDepartureTimes(events) : Promise.resolve(""),
      events !== null ? populateCalendarSyncState(events).catch(() => {}) : Promise.resolve(),
    ]);

    const calendarBlock = events !== null
      ? `\n\n[Google Calendar — today and next 7 days (past events excluded)]\n${formatCalendarForPrompt(events, "this week")}${calendarDepartureTimes}`
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

    const medMorningBlock = morningMeds.length > 0 && !medsAlreadyTaken
      ? `\n\n[Medications — Not yet taken today]\nDavid's medications: ${buildMedReminderText(morningMeds)}`
      : "";

    const sportsBlock = sportsScores ? formatSportsForPrompt(sportsScores) : "";

    const billsMorningBlock = upcomingBills.length > 0
      ? `\n\n[Bills Due in Next 3 Days — mention ONLY if due within 3 days, skip entirely otherwise]\n${formatBillsForPrompt(upcomingBills)}`
      : "";

    const marketsBlock = marketsData ? buildMarketsBlock(marketsData, now) : "";

    const datesBlock = upcomingDates.length > 0
      ? `\n\n[Upcoming Birthdays & Anniversaries]\n${formatDatesForPrompt(upcomingDates)}`
      : "";

    const sundaySummaryBlock = isSunday && sundayData ? buildSundaySummaryBlock(sundayData) : "";

    const pickleballMorningBlock = isPickleballMorning && !sundaySummaryBlock
      ? `\n\n[Schedule Note]\nToday is a pickleball day for David (Mon/Wed/Fri/Sat schedule).`
      : "";

    const recFollowUpBlock = pendingFollowUps.length > 0
      ? buildRecommendationFollowUpBlock(pendingFollowUps)
      : "";

    const kneeCheckBlock = kneeIssueRecent
      ? `\n\n[Health Note]\nDavid mentioned knee issues recently from pickleball.`
      : "";

    // dallasEvents is already a fully-formatted block from dallasContent.ts
    // (includes header, source attributions, and Claude instructions).
    const dallasEventsBlock = dallasEvents ?? "";

    const motivationContextBlock = (() => {
      const tz = "America/Chicago";
      const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
      const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(dayName);
      const recentJournalSnippet = recentJournals.length > 0
        ? recentJournals.slice(0, 2).map(j => j.content.substring(0, 150)).join(" / ")
        : "";
      let block = `\n\n[Morning Motivation Context — for Emma's personal touch]\n`;
      block += `• Today is ${dayName}${isPickleballDay ? " — a pickleball day" : ""}\n`;
      block += `• Journal entries this week: ${journalCountWeek}\n`;
      if (recentJournalSnippet) block += `• Recent journal themes (brief snippets, handle with care): "${recentJournalSnippet}"\n`;
      block += `• Total family archive stories captured: ${totalStories}\n`;
      block += `Use this to craft a specific, warm 2-3 sentence motivating thought — not generic, not a quote, just Emma noticing something real and positive about David's day ahead. Morning only — do NOT suggest evening activities or memory recording.`;
      return block;
    })();

    const systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + memoryBlock + dynamicProfileBlock +
      notesBlock + weatherBlock + gmailBlock + calendarBlock + tvMorningBlock + medMorningBlock +
      sportsBlock + billsMorningBlock + marketsBlock + datesBlock + sundaySummaryBlock +
      pickleballMorningBlock + kneeCheckBlock + recFollowUpBlock + motivationContextBlock +
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
      setCachedBriefing(userName, text);
      logger.info({ userName, chars: text.length }, "Morning briefing pre-generated and cached");
    } else {
      logger.warn({ userName }, "Pre-generate: Claude returned empty text");
    }
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing");
  }
}
