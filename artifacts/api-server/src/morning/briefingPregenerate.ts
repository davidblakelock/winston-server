import Anthropic from "@anthropic-ai/sdk";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildScamWarningInstruction, updateEmailLastChecked } from "../google/gmail.js";
import { fetchWeekEvents, formatCalendarForPrompt, toChicagoTime, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { populateCalendarSyncState } from "../departure/calendarSyncScheduler.js";
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
import { getJournalCountThisWeek, getRecentJournalEntries } from "../journal/journalManager.js";
import { getStoryCount } from "../stories/storyManager.js";
import { getCachedWeather, type CachedWeather, type ForecastDay, TOMORROW_CONDITIONS } from "../weather/weatherCache.js";
import { setCachedBriefing } from "./briefingCache.js";
import { fetchDallasContent, getDallasItems, buildDallasBlock } from "./dallasContent.js";
import { runVenueScan, getVenueConcerts, buildVenueConcertsBlock } from "./venueMonitor.js";
import {
  getSeenHeadlines,
  logBriefingStories,
  isDuplicate,
  extractBoldHeadlines,
  filterNewsBlock,
} from "./storyDedup.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Departure times for calendar events ───────────────────────────────────────
// Calculates leave-by time for each event that has a location.
// Runs all geocode/routing calls in parallel with a 10 s per-event timeout.
async function buildCalendarDepartureTimes(events: CalendarEvent[], homeAddress: string, homeLat: number, homeLon: number): Promise<string> {
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

async function fetchDallasPollenData(lat: number, lon: number): Promise<PollenResult | null> {
  try {
    const resp = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=grass_pollen,ragweed_pollen,alder_pollen&timezone=America%2FChicago&forecast_days=1`,
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

const MASTER_BRIEFING_INSTRUCTION = `

  [MORNING BRIEFING — DELIVER ALL 16 SECTIONS IN THIS EXACT ORDER]

  Deliver the morning briefing as a single flowing conversation. No headers. No bullet points. No section labels. No phrases that announce what comes next. Sound like David's most trusted friend who just called — warm, sharp, personal, and always on point.

  CORE PHILOSOPHY: Every piece of information is condensed, essential, and actionable. Cut anything that does not earn its place. The entire briefing should take 3 to 5 minutes at a natural conversational pace.

  DELIVER THESE SECTIONS IN THIS EXACT ORDER — skip only where explicitly instructed:

  SECTION 1 — GREETING: "Good morning, David" followed by one warm personal sentence naming the day of the week. One sentence total.

  SECTION 2 — WEATHER TODAY: SKIP THIS SECTION ENTIRELY. All weather — temperature, condition, high/low, rain chance, pollen, UV, forecast — is displayed on the visual weather card in the app. Do not mention any of it. Move directly from Section 1 to Section 5.

  SECTION 3 — FIVE DAY FORECAST: SKIP THIS SECTION ENTIRELY.

  SECTION 4 — POLLEN: SKIP THIS SECTION ENTIRELY.

  SECTION 5 — EMAIL: If there is a [VERIFIED — Gmail API — unread emails] block below, share one or two that actually matter — something requiring action, from someone important, or genuinely worth knowing. Never count unread messages. Never summarize confirmation emails or automated mail David doesn't need to act on. If there is NO Gmail API block, SKIP SECTION 5 ENTIRELY — do not mention email, do not say the inbox is clear or quiet.

  SECTION 6 — CALENDAR: Today's upcoming events only — nothing in the past, nothing more than 7 days out. Include departure time for any appointment with a location. If the day is clear, say so warmly in one sentence. Do NOT mention bills here — bills have their own section.
    WEATHER EXCEPTION — the only place weather is ever permitted: if today's calendar includes a specific outdoor physical activity (a run, a walk, a pickleball game) AND the weather signals block flags severe/dangerous conditions (thunderstorms, extreme heat, heavy rain) OR explicitly PERFECT conditions — weave ONE brief phrase naturally into the sentence for that event. Example: "You've got pickleball at 8 — perfect morning for it." or "Your run is at 7, but rain is likely." This is the ONLY weather reference permitted anywhere in the entire briefing. Do NOT use this exception if no outdoor activity is on today's calendar, or if conditions are ordinary. Do NOT mention temperature numbers, degrees, highs, lows, or any other weather specifics here — only the plain-language signal word (perfect / stormy / rain likely).

  SECTION 7 — BILLS DUE SOON: ONLY if a bill appears in the [VERIFIED — Bills Database — Due in Next 3 Days] block. Name the bill and amount. If that block is empty or absent, SKIP THIS SECTION ENTIRELY — do not mention bills at all, do not say nothing is due.

  SECTION 8 — NEWS: A structured news sweep using the data in [VERIFIED — Web Search News — ...] block. Deliver in this exact format — each story on its own lines:

    From [Headlines — bold title + one sentence summary each]: Read each story EXACTLY as formatted — bold title on one line, then the summary sentence on the next line. Do not merge them. Do not change the format. Read all 8 headlines. These already cover 8 distinct categories (world, US politics, business, tech, science, sports, Dallas local, wildcard) — do NOT reorder or drop any.

    From [Entertainment & Pop Culture] (if present): One item only. Bold title on one line, summary sentence on the next. Skip if absent.

    From [Watercooler Story] (if present): Introduce warmly — "oh, and here's one to share later —" then the story in two sentences max.

    FORMATTING RULES: Each headline is on its own line, bold. Each summary sentence is on the next line. A blank line between stories. Never merge headlines and summaries. Never use "in other news" or "moving on." Short transitions between sections only: "also —", "and —", "meanwhile —". NEVER repeat a topic from Section 10 (Sports) — that section already covers Rangers and Cowboys game results.

  SECTION 10 — SPORTS: Rangers and Cowboys results from the last 24 hours only. If no games were played, SKIP THIS SECTION ENTIRELY — do not say no games were played.

  SECTION 11 — LOCAL DALLAS: ALWAYS INCLUDE THIS SECTION — it is never skipped. The [What's Happening in Dallas] block is always present below.
    • If the block contains real items: deliver 1-2 items conversationally, one sentence each. Prioritize restaurant openings, music events at David's venues, and neighborhood news.
    • If the block says "No new local events found": say exactly this and nothing more — "Nothing new on the Dallas events front this morning." Do not apologize, do not elaborate.

  SECTION 12 — MUSIC EVENTS: Upcoming concerts at David's saved venues that match his taste — Kessler, Granada, Dos Equis Pavilion, AT&T Performing Arts Center, Klyde Warren Park, Dallas Arboretum, Meyerson. Use the venue concerts block. If nothing upcoming or nothing found, skip this section entirely.

  TV SHOWS — STRICT RULE: ONLY mention a TV show if the [TV Shows — New Episodes] block is present in this prompt. If that block is absent, never reference any TV show, series, episode, or streaming content — not Shrinking, not Lincoln Lawyer, not Friends & Neighbors, not any show from David's profile. No exceptions. TV is data-driven only.

  SECTION 13 — BIRTHDAYS AND IMPORTANT DATES: Any birthdays or anniversaries in the next 7 days. Name the person and the date specifically. SKIP if none.

  SECTION 14 — MORNING MOTIVATION: Use the [VERIFIED — Web Search — Today's Inspiration] block if available. Lead with the inspiring thought or finding, then connect it personally to David's specific day — what he has ahead (a dinner, his pickleball game, a free afternoon). Keep it to 2-3 sentences. Warm and genuine — a friend sharing something interesting, not a motivational poster.
    CRITICAL — Fix 5: If the [Morning Motivation Context] says "MORNING WORKOUT ALREADY DONE" — do NOT mention exercise, going for a walk, heading outside, or any outdoor activity. Reference only what is actually AHEAD in his day (upcoming dinner, free time, interesting event). Do NOT repeat anything that already happened this morning.

  SECTION 16 — SUNDAY SPECIAL: Sundays ONLY — deliver a warm weekly recap just before Section 15: exercise this week, family archive stories captured, highlights, something to look forward to next week. Skip every other day of the week.

  SECTION 15 — CLOSING: End the briefing on exactly ONE sentence. It should be warm, direct, and specific to David's day — something that fits what's ahead. Do NOT end with a question. Do NOT ask "Anything else before you head into your day?" or any variation of it. Do NOT invite follow-up. A close friend signs off with confidence, not with permission. One sentence, then stop.

  FORBIDDEN PHRASES AND CONTENT — never use:
  "Here is your morning briefing" or "Good morning, David, here is what you need to know"
  "Moving on to" or "Let us talk about" or "Turning to" or "Now for" or "Next up"
  "In other news" or "Speaking of which" or "On the topic of"
  "Here is your weather" or "In terms of the weather" or "Weather-wise"
  "Anything else before you head into your day?" or "Is there anything else?" or "Let me know if you need anything" or any open-ended question at the close.
  Any phrase that announces that a new section is beginning.
  ANY weather content outside the single exception in Section 6: no temperatures, no degrees (°), no highs, no lows, no rain percentages, no humidity, no pollen counts, no UV index, no forecast days, no condition descriptions (sunny, cloudy, partly cloudy, clear, etc.), no "feels like", no wind speed. The weather card shows all of this — the briefing text must never duplicate it.

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

    const [recentMemories, allProfileItems, userProfile, seenHeadlines] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
      getSeenHeadlines(userName, 3).catch(() => new Set<string>()),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile, userProfile.rawData as CollectedData)
        : BASE_SYSTEM_PROMPT;

    const primaryCity = userProfile?.city ?? "Dallas";
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;
    const homeAddress = userProfile?.homeAddress ?? ((userProfile?.rawData as CollectedData)?.homeAddress) ?? "";

    // Geocode secondary cities from profile before the main Promise.all
    // Only include people in a different city than the user's home city
    const rawPeople = ((userProfile?.rawData as CollectedData)?.people ?? [])
      .filter((p) => p.city && p.city.trim().length > 0 && p.city.trim().toLowerCase() !== primaryCity.trim().toLowerCase())
      .slice(0, 4);
    const geocodedSecondary = await Promise.all(
      rawPeople.map(async (p) => {
        const coords = await geocodeCity(p.city!).catch(() => null);
        return coords ? { name: p.name, city: p.city!, lat: coords.lat, lon: coords.lon } : null;
      })
    );
    const validSecondaryLocs = geocodedSecondary.filter(Boolean) as Array<{ name: string; city: string; lat: number; lon: number }>;

    // Start secondary weather fetches in parallel with the main Promise.all
    const secondaryWeatherPromise = Promise.all(
      validSecondaryLocs.map((s) => getCachedWeather(s.city, s.lat, s.lon).catch(() => null))
    );

    const [dallas, emails, events, lastNightNotes, newsBlock, yesterdayEps, todayEps, sportsScores, upcomingBills, upcomingDates, sundayData, pendingFollowUps, dallasEvents, journalCountWeek, recentJournals, totalStories, pollenData, venueConcertsBlock, dailyMotivation] = await Promise.all([
      getCachedWeather(primaryCity, primaryLat, primaryLon).catch(() => null),
      fetchAndSummarizeEmails(15).catch(() => null),
      fetchWeekEvents(false).catch(() => null),
      getLastNightNotes().catch(() => []),
      fetchMorningNews().catch(() => ""),
      fetchEpisodesForDate(yesterday, watchedIds).catch(() => []),
      fetchEpisodesForDate(now, watchedIds).catch(() => []),
      fetchSportsScores().catch(() => null),
      getUpcomingBills(3, userName).catch(() => []),
      getUpcomingDates(21, userName).catch(() => []),
      isSunday ? collectSundayData().catch(() => null) : Promise.resolve(null),
      getPendingFollowUps(2, 14).catch(() => []),
      fetchDallasContent().catch(() => ""),
      getJournalCountThisWeek().catch(() => 0),
      getRecentJournalEntries(3).catch(() => []),
      getStoryCount().catch(() => 0),
      fetchDallasPollenData(primaryLat, primaryLon).catch(() => null),
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
    const dedupedDallasBlock = buildDallasBlock(filteredDallasItems);
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

    const gmailBlock = emails !== null && emails.length > 0
      ? `\n\n[VERIFIED — Gmail API — unread emails]\n${formatEmailsForPrompt(emails)}\nThis is VERIFIED data. State sender names, subjects, and content exactly as shown.` +
        buildScamWarningInstruction(emails)
      : "";
    // When emails is null (auth failure) or empty (inbox clear at briefing time),
    // we inject NO gmail block — Section 5 is instructed to skip when block is absent.

    // Build calendar block with departure times, and pre-populate sync state so
    // events in the briefing are never flagged as "new" by the 30-min sync scheduler.
    const [calendarDepartureTimes] = await Promise.all([
      events !== null ? buildCalendarDepartureTimes(events, homeAddress, primaryLat, primaryLon) : Promise.resolve(""),
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
      : `\n\n[What's Happening in Dallas]\nNo new local events found for today. In Section 11, say exactly: "Nothing new on the Dallas events front this morning." Do not skip this section silently.`;

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

    const profileContextBlock = buildProfileContext(
      userProfile ?? null,
      (userProfile?.rawData ?? {}) as CollectedData
    );

    const systemPrompt = getCurrentDateTimeBlock() + "\n" + corePrompt + profileContextBlock + memoryBlock + dynamicProfileBlock +
      notesBlock + weatherBlock + gmailBlock + calendarBlock + tvMorningBlock +
      sportsBlock + billsMorningBlock + datesBlock + sundaySummaryBlock +
      pickleballMorningBlock + recFollowUpBlock + motivationContextBlock +
      dallasEventsBlock + dedupedVenueConcertsBlock + dedupedNewsBlock + MASTER_BRIEFING_INSTRUCTION;

    // Log which sections have data (for debugging completeness of the briefing)
    const sectionLog: Record<string, boolean | string> = {
      "S1_greeting": true,
      "S2_weather_today": !!dallas,
      "S3_five_day_forecast": !!(dallas?.forecastDays && dallas.forecastDays.length > 0),
      "S4_pollen": !!pollenData,
      "S5_email": emails !== null,
      "S6_calendar": events !== null && events.length > 0,
      "S7_bills_3day": upcomingBills.length > 0,
      "S8_news": dedupedNewsBlock.length > 0,
      "S10_sports": !!(sportsScores),
      "S11_local_dallas": filteredDallasItems.length > 0 ? `${filteredDallasItems.length} items` : `EMPTY (fallback — raw:${rawDallasItems.length})`,
      "S12_music_events": filteredVenueConcerts.length > 0 ? `${filteredVenueConcerts.length} concerts` : "EMPTY",
      "S13_birthdays": upcomingDates.length > 0,
      "S14_motivation": true,
      "S16_sunday_special": isSunday,
    };
    logger.info({ userName, sections: sectionLog }, "[BRIEFING SECTIONS] Data availability per section");

    logger.info({ userName, newsChars: dedupedNewsBlock.length, seenCount: seenHeadlines.size }, "Pre-generate: calling Claude for briefing");

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

      // Log all candidate story keys so they won't repeat in the next 3 days
      void logBriefingStories(userName, candidateStoryKeys);
    } else {
      logger.warn({ userName }, "Pre-generate: Claude returned empty text");
    }
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing");
  }
}
