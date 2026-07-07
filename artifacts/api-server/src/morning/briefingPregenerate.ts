import Anthropic from "@anthropic-ai/sdk";
import { toChicagoTime, chicagoDateStr, type CalendarEvent, fetchWeekEvents, formatCalendarForPrompt, fetchTodayEvents, fetchTomorrowEvents } from "../google/calendar.js";
import { fetchAndSummarizeEmails, formatEmailsForPrompt, buildImportantEmailInstruction } from "../google/gmail.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { getLastNightNotes, formatNotesForMorningBriefing } from "../winddown/winddownManager.js";
import { getRecentMemories, formatMemoriesForContext } from "../memory/memoryManager.js";
import { fetchMorningNews, fetchDailyMotivation } from "../news/newsManager.js";
import { getProfileItems, getProfilePlaces, formatProfileForContext } from "../profile/profileManager.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext, type PersonEntry } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { getWatchedShows } from "../tv/showManager.js";
import { fetchEpisodesForDate, formatEpisodeForPrompt } from "../tv/tvmaze.js";
import { fetchSportsScores, formatSportsForPrompt } from "../sports/sportsManager.js";
import { getUpcomingBills, formatBillsForPrompt } from "../bills/billManager.js";
import { getUpcomingDates, formatDatesForPrompt } from "../dates/datesManager.js";
import { getTodayTripDay, buildTripDayBlock } from "../travel/tripPlanningManager.js";
import { getPendingFollowUps, buildRecommendationFollowUpBlock } from "../recommendations/recommendationsManager.js";
import { collectSundayData, buildSundaySummaryBlock } from "../sundaySummary/sundaySummaryManager.js";
import { getPendingPersonalFollowups, buildPersonalFollowupsBlock } from "../followups/followupManager.js";
import { setStaticBriefingContext, setCachedBriefing } from "./briefingCache.js";
import { runVenueScan, getVenueConcerts, buildVenueConcertsBlock } from "./venueMonitor.js";
import {
  getSeenHeadlines,
  isDuplicate,
  extractBoldHeadlines,
  filterNewsBlock,
} from "./storyDedup.js";
import { logger } from "../lib/logger.js";
import { getBriefingPreferences, buildBriefingPrefsBlock } from "../briefingPreferences/briefingPreferencesManager.js";
import { checkUpcomingDates } from "./morningActions.js";
import { getMydayEntries, type MydayEntry } from "../myday/mydayManager.js";
import {
  getPendingSuggestion, markSuggestionSurfaced,
  getPendingObservation, markObservationSurfaced,
  getWeeklyGift, generateAndStoreAnnualLetter,
} from "../lifeCaptures/lifeCapturesManager.js";
import { buildCalendarEmailCorrelations, formatCorrelationNote, type CalendarEmailCorrelation } from "./calendarEmailIntelligence.js";
import { getOrdersForBriefing } from "../orders/ordersManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import { query } from "../db.js";
import { getUserSettings, getStoicForUser, incrementStoicDay, buildStoicBlock, type UserSettings } from "../stoic/stoicManager.js";

// ── Smart calendar block with integrated departure times ──────────────────────
// Builds a TODAY / TOMORROW / LATER THIS WEEK block where each event with a
// known location already has the calculated "Leave by X" time woven in.
// This replaces the old two-part pattern of formatCalendarForPrompt + a separate
// departure-times appendix. Claude sees one pre-computed, human-readable block.
export async function buildSmartCalendarBlock(
  allEvents: CalendarEvent[],
  homeAddress: string,
  homeLat: number,
  homeLon: number,
  emailCorrelations?: Map<string, CalendarEmailCorrelation>,
): Promise<string> {
  if (!allEvents || allEvents.length === 0) return "";

  const now = new Date();
  const TZ_LOCAL = "America/Chicago";
  const todayStr    = chicagoDateStr(now);
  const tomorrowStr = chicagoDateStr(new Date(now.getTime() + 86_400_000));

  const todayEvents    = allEvents.filter((e) => e.isoDate === todayStr);
  const tomorrowEvents = allEvents.filter((e) => e.isoDate === tomorrowStr);
  const laterEvents    = allEvents.filter((e) => e.isoDate !== todayStr && e.isoDate !== tomorrowStr);

  // Compute departure time for a single event (null if no location or drive fails)
  async function computeDep(event: CalendarEvent): Promise<string | null> {
    if (event.allDay || !event.startIso) return null;
    const start = new Date(event.startIso);
    if (toChicagoTime(start).getTime() < toChicagoTime(now).getTime()) return null; // already past in CT

    const location = extractEventLocation({
      summary: event.summary,
      location: event.location,
      description: event.description,
    });
    if (!location || !homeAddress) return null;

    try {
      const drive = await Promise.race([
        estimateDriveTime(location, homeAddress, homeLat, homeLon),
        new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
      ]);
      if (!drive) return null;

      const leaveAt  = new Date(start.getTime() - (drive.durationMinutes + 10) * 60_000);
      const leaveStr = leaveAt.toLocaleTimeString("en-US", {
        timeZone: TZ_LOCAL, hour: "numeric", minute: "2-digit", hour12: true,
      });
      const mins       = Math.round(drive.durationMinutes / 5) * 5 || 5;
      const sourceNote = drive.source === "google-maps" ? "w/ current traffic" : "est.";
      return `Leave by ${leaveStr} (~${mins} min ${sourceNote})`;
    } catch { return null; }
  }

  // Run departure calculations in parallel for today + tomorrow only
  const actionable = [...todayEvents, ...tomorrowEvents];
  const depResults = await Promise.all(actionable.map(computeDep));
  const depMap     = new Map(actionable.map((e, i) => [e.id, depResults[i] ?? null]));

  function formatLine(event: CalendarEvent): string {
    const time = event.allDay
      ? "All day"
      : `${event.start}${event.end && event.end !== event.start ? ` – ${event.end}` : ""}`;
    const loc = event.location ? ` · ${event.location}` : "";
    const dep = depMap.get(event.id);
    const correlation = emailCorrelations?.get(event.id);
    const emailNote = correlation ? `\n${formatCorrelationNote(correlation)}` : "";
    return dep
      ? `• ${event.summary} — ${time}${loc}\n  → ${dep}${emailNote}`
      : `• ${event.summary} — ${time}${loc}${emailNote}`;
  }

  const todayLabel    = `TODAY (${new Date(todayStr    + "T12:00:00").toLocaleDateString("en-US", { timeZone: TZ_LOCAL, weekday: "long", month: "long", day: "numeric" })})`;
  const tomorrowLabel = `TOMORROW (${new Date(tomorrowStr + "T12:00:00").toLocaleDateString("en-US", { timeZone: TZ_LOCAL, weekday: "long", month: "long", day: "numeric" })})`;

  const parts: string[] = [];

  parts.push(
    todayEvents.length > 0
      ? `${todayLabel}:\n${todayEvents.map(formatLine).join("\n")}`
      : `${todayLabel}: Nothing scheduled.`
  );

  parts.push(
    tomorrowEvents.length > 0
      ? `${tomorrowLabel}:\n${tomorrowEvents.map(formatLine).join("\n")}`
      : `${tomorrowLabel}: Nothing scheduled.`
  );

  if (laterEvents.length > 0) {
    const laterLines = laterEvents.map((e) => {
      const time = e.allDay ? "All day" : e.start;
      return `• ${e.summary} — ${e.dateLabel}, ${time}${e.location ? ` at ${e.location}` : ""}`;
    });
    parts.push(`LATER THIS WEEK:\n${laterLines.join("\n")}`);
  }

  const homeNote = homeAddress ? `\n(Departure times calculated from ${homeAddress})` : "";
  return parts.join("\n\n") + homeNote;
}

// Dallas local content is now handled by dallasContent.ts (RSS feeds + web search fallback).
// Imported below alongside other module imports.

function buildBaseSystemPrompt(userName?: string | null): string {
  const user = userName ?? "you";
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/__USER__/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are a knowledgeable, genuinely helpful AI companion for __USER__. Be accurate, direct, and useful. Keep responses concise — typically 2–4 sentences unless __USER__ clearly wants more. Never start a response with "I" as the first word.

GUIDING PRINCIPLE:
Be bold and specific. When you know something — say it directly. Draw connections naturally and confidently. The only hard constraints: never fabricate facts, never share user data.

VERIFIED DATA — state as fact, directly. No softening, no hedging:
• Calendar: reproduce event titles letter-for-letter exactly as they appear. Never add names or context not explicitly in the title.
• News, sports, weather, stocks: state from [VERIFIED] blocks as fact. Never invent headlines, scores, or statistics.
• Never reference block names in your spoken output — just state the facts naturally.

When __USER__ asks about something not in a verified block, say so in one sentence and keep moving.

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
    `When asked what time or day it is, answer directly using exactly the values above.\n`
  );
}

function buildPeopleContextBlock(people: PersonEntry[], displayName?: string): string {
  if (people.length === 0) return "";

  const partnerRels = ["girlfriend", "boyfriend", "wife", "husband", "partner", "fiancée", "fiancé"];
  const lines: string[] = [];

  for (const p of people) {
    const name = (p.name ?? "").trim();
    const rel = (p.relationship ?? "").trim();
    if (!name || !rel) continue;

    const address = p.address?.trim();
    const birthday = p.birthday?.trim();
    const notes = p.notes?.trim();
    const anniversary = p.anniversary?.trim();
    const isPartner = partnerRels.some((r) => rel.toLowerCase().includes(r));

    const parts: string[] = [`${name} — ${rel}${isPartner ? " (Your Partner)" : ""}`];
    if (address) parts.push(`${address}`);
    if (birthday) parts.push(`birthday: ${birthday}`);
    if (anniversary) parts.push(`${displayName?.split(" ")[0] ?? "your"} & ${name.split(" ")[0]} anniversary: ${anniversary}`);
    if (notes) parts.push(notes);

    lines.push(`• ${parts.join(", ")}`);
  }

  if (lines.length === 0) return "";

  return (
    `\n\n[Key People — Reference naturally in the briefing]\n` +
    lines.join("\n") + "\n\n" +
    `HOW TO USE THIS:\n` +
    `• Susan (Your Partner) — include a warm, specific one-liner in the Section 15 closing every briefing. Examples: "Hope you and Susan have a great night", "Give Susan my best." Keep it natural — not every closing needs to be about her, but include her often.\n` +
    `• Birthdays — if any birthday is within 7 days, surface it in Section 13 with the date. If it's today, make it feel special.\n` +
    `• Never invent details not listed here. Base any reference on the facts in this block.`
  );
}

function buildNarrativeBriefingInstruction(
  city: string,
  companionName: string | null,
  displayName?: string,
  intentionQuestion?: string,
  settings?: { briefingStoic?: boolean; briefingWeather?: boolean; briefingCalendar?: boolean; briefingEmail?: boolean; briefingNews?: boolean }
): string {
  const name = displayName ?? "the user";
  const companion = companionName ?? "Winston";

  return `

[MORNING RUN DOWN — DELIVERY INSTRUCTIONS]

You are ${companion}, delivering ${name}'s Morning Run Down. This is a spoken briefing — natural, warm, direct. Under 90 seconds total. No bullet points. No headers. Flowing conversational prose only.

Work through each section below IN ORDER. Skip any section where no data is present in your context.

${settings?.briefingWeather !== false ? `
SECTION 1 — WEATHER
One sentence only. Current conditions and today's high. Example: "It's going to be a warm one — high of 89 and partly cloudy."
Do NOT mention the forecast beyond today. Do NOT give rain percentages unless rain is likely.
` : ""}

${settings?.briefingCalendar !== false ? `
SECTION 2 — THE DAY AHEAD
Speak the calendar naturally — what's on today, in order. No departure times. No traffic speculation.
If the calendar is clear, say so warmly in one sentence and move on.
Example: "You've got three things today — dentist at 10, lunch with Fred at noon, and your Cooper Fitness class at 4."
` : ""}

${settings?.briefingEmail !== false ? `
SECTION 3 — INBOX
Give the shape of the inbox only — total count, how many are urgent, how many need replies.
Do NOT read subjects. Do NOT summarize content. Do NOT name senders.
Example: "Eight emails came in overnight. One looks urgent — flagged it for you. Two will probably need replies when you're ready."
If the inbox is clear, say so in one sentence.
` : ""}

${settings?.briefingNews !== false ? `
SECTION 4 — WHAT'S MAKING NEWS
The [VERIFIED — Reuters + AP News] block above contains three subsections. Deliver them in this order:

4A — TOP STORIES: Deliver the [Top Stories] subsection. State what happened and why it matters for each story. No commentary, no political framing, no opinion. Two stories, each two sentences max. Lead with: "Here's what's making news this morning:"

4B — ENTERTAINMENT: Only if the [Entertainment] subsection has content. One brief sentence per item. Skip if empty.

4C — CONVERSATION STARTER: This is the [Conversation Starter] subsection. Deliver it naturally after the news — something like "And here's something you can share today:" then the two sentences. This should land as genuinely surprising or funny. If the subsection is absent, skip entirely — do not invent one.
` : ""}

SECTION 5 — SPORTS
Only deliver this section if sports score data appears in your context above.
Scores and results only. No analysis. No commentary.
Example: "Cowboys beat the 49ers 34 to 17. Rangers lost to Houston 3 to 2."
If no sports data is present, skip this section entirely and do not mention it.

SECTION 6 — THE STOIC CLOSE
This is the most important part of the Morning Run Down. Deliver it with care and without rushing.

Step A — Read the Stoic quote exactly as written in your context. Do not paraphrase.
Attribute it: "Marcus Aurelius wrote..." or "Epictetus said..." or "Seneca wrote..."

Step B — In one or two sentences, translate it into today's language.
Not interpretation. Translation. Make it land in 2026.
If there is something in ${name}'s day today that connects naturally to the quote, make that connection briefly.
If there is no natural connection, do not force one. Just make the quote clear and relevant.

Step C — The invitation. Speak it warmly and without hurry:
"Take a few minutes before your day starts. Your My Life screen is there if you want to capture anything — a thought, an intention, something worth remembering. Or just be still for a moment."

Then stop. Do not add anything after the invitation. No sign-off. No "Have a great day." The silence is intentional.

TONE THROUGHOUT:
Warm but not effusive. Direct but not cold. Like a trusted friend who has done their homework and respects your time.
Never say "Good morning" — start directly with weather or whatever the first available section is.
Never end with "Have a great day" or any generic sign-off. The Stoic close is the ending.
`;
}

// In-flight dedup for preFetchMorningBriefing — prevents multiple concurrent
// pre-gen calls (from startup + cron tick + sendMorningPush fallback) from each
// spawning their own set of Apify actor runs. All concurrent callers for the
// same user share the single in-flight promise.
const _prefetchInFlight = new Map<string, Promise<void>>();

export async function preFetchMorningBriefing(userName: string): Promise<void> {
  const existing = _prefetchInFlight.get(userName);
  if (existing) {
    logger.info({ userName }, "[Briefing] preFetchMorningBriefing already in flight — deduplicating concurrent call");
    return existing;
  }

  const promise = _doBriefingPrefetch(userName).finally(() => { _prefetchInFlight.delete(userName); });
  _prefetchInFlight.set(userName, promise);
  return promise;
}

// ── Onboarding nudge helpers — once per day if profile not yet complete ───────
async function shouldShowOnboardingNudge(userName: string): Promise<boolean> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const result = await query<{ last_mention_date: string }>(
      `SELECT last_mention_date::text AS last_mention_date FROM onboarding_nudge_log WHERE user_name = $1`,
      [userName]
    );
    if (result.rows.length === 0) return true;
    return result.rows[0].last_mention_date !== today;
  } catch {
    return false;
  }
}

async function markOnboardingNudgeShown(userName: string): Promise<void> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    await query(
      `INSERT INTO onboarding_nudge_log (user_name, last_mention_date)
       VALUES ($1, $2)
       ON CONFLICT (user_name) DO UPDATE SET last_mention_date = $2`,
      [userName, today]
    );
  } catch { /* non-fatal */ }
}

async function _doBriefingPrefetch(userName: string): Promise<void> {
  // Capture the CT date NOW, before any async work. setCachedBriefing receives this
  // key explicitly so a briefing that starts on April 6 and finishes after midnight
  // is NOT cached with April 7's key while containing April 6 calendar data.
  const generationDateKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  logger.info({ userName, generationDateKey }, "Pre-generating morning briefing");
  try {
    const watchedShows = await getWatchedShows().catch((): Awaited<ReturnType<typeof getWatchedShows>> => []);
    const watchedIds = watchedShows.filter((s) => s.tvmazeId).map((s) => s.tvmazeId!);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const isSunday = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long" }) === "Sunday";

    // Annual letter date — default Jan 1, or from user profile
    const ctMonth  = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "numeric" });
    const ctDay    = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", day: "numeric" });
    const isAnnualLetterDay = ctMonth === "1" && ctDay === "1"; // Jan 1 default

    // Rotating morning intention question (cycles every day)
    const dayOfYear = Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000
    );
    const INTENTION_QUESTIONS = [
      `What's the one thing that would make today feel worthwhile?`,
      `What's been on your mind that deserves attention today?`,
      `Is there someone you should reach out to today?`,
    ];
    const intentionQuestion = INTENTION_QUESTIONS[dayOfYear % 3]!;

    const [recentMemories, allProfileItems, userProfile, keyPeople, seenHeadlines, seenVenueHeadlines, briefingPrefs, userSettings, stoicEntry] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
      getPeople(userName).catch(() => [] as PersonEntry[]),
      getSeenHeadlines(userName, 3).catch(() => new Set<string>()),    // news/Dallas: 3-day dedup window
      getSeenHeadlines(userName, 14).catch(() => new Set<string>()),  // venue concerts: 14-day window (events repeat until show date)
      getBriefingPreferences(userName).catch(() => []),
      getUserSettings(userName).catch(() => null as UserSettings | null),
      getStoicForUser(userName).catch(() => null),
    ]);
    const memoryBlock = formatMemoriesForContext(recentMemories);
    const dynamicProfileBlock = formatProfileForContext(allProfileItems);
    const corePrompt =
      userProfile?.onboardingCompleted && userProfile.name
        ? buildSystemPromptFromProfile(userProfile)
        : buildBaseSystemPrompt(userProfile?.name);

    // ── Onboarding nudge — inject once per day if profile not yet complete ────
    let onboardingNudgeBlock = "";
    if (userProfile && !userProfile.onboardingCompleted) {
      const nudgeShouldShow = await shouldShowOnboardingNudge(userName);
      if (nudgeShouldShow) {
        await markOnboardingNudgeShown(userName);
        onboardingNudgeBlock =
          `\n\n[Onboarding Reminder — Weave in naturally near the end of briefing]\n` +
          `This user has not yet completed their profile setup. Near the end of the briefing, ` +
          `after the main content, include this as a casual friendly aside — not an announcement:\n` +
          `"By the way, I notice we haven't finished getting me fully set up yet. Would you like ` +
          `to schedule some time today to complete your profile so I can do a better job for you?"\n` +
          `Keep it warm and brief — one sentence. Do NOT lecture or repeat it. If the user responds yes, help them pick a time and create a reminder.`;
        logger.info({ userName }, "[Briefing] Onboarding nudge injected into today's briefing");
      }
    }

    const primaryCity = (userProfile?.city ?? "Dallas").trim();
    const primaryLat = userProfile?.latitude ?? 32.7767;
    const primaryLon = userProfile?.longitude ?? -96.7970;
    const homeAddress = userProfile?.homeAddress ?? "";


    const [lastNightNotes, newsBlock, yesterdayEps, todayEps, sportsScores, upcomingBills, upcomingDates, sundayData, pendingFollowUps, venueConcertsBlock, dailyMotivation, personalFollowUps, outForDeliveryOrders, weeklyGift, pendingObservation, annualLetter] = await Promise.all([
      getLastNightNotes().catch(() => []),
      fetchMorningNews(userName).catch(() => ""),
      fetchEpisodesForDate(yesterday, watchedIds).catch(() => []),
      fetchEpisodesForDate(now, watchedIds).catch(() => []),
      fetchSportsScores(userName).catch(() => null),
      getUpcomingBills(3, userName).catch(() => []),
      getUpcomingDates(21, userName).catch(() => []),
      isSunday ? collectSundayData(userName).catch(() => null) : Promise.resolve(null),
      getPendingFollowUps(2, 14).catch(() => []),
      runVenueScan().catch(() => ""),
      fetchDailyMotivation(userName).catch(() => ""),
      getPendingPersonalFollowups(userName).catch(() => []),
      getOrdersForBriefing(userName).catch(() => []),
      isSunday ? getWeeklyGift(userName).catch(() => null) : Promise.resolve(null),
      getPendingObservation(userName).catch(() => null),
      isAnnualLetterDay
        ? generateAndStoreAnnualLetter(userName).catch(() => null)
        : Promise.resolve(null),
    ]);

    // ── Weather context + To-Do list (fetched at pre-gen time) ───────────────
    const [weatherData, todoItems] = await Promise.all([
      getCachedWeather(primaryCity, primaryLat, primaryLon).catch(() => null),
      query<{ item_text: string }>(
        `SELECT item_text FROM list_items WHERE user_name = $1 AND list_name = 'to do' ORDER BY created_at ASC`,
        [userName]
      ).then((r) => r.rows).catch((): Array<{ item_text: string }> => []),
    ]);

    const weatherContextBlock = weatherData
      ? `\n\n[VERIFIED — Weather — ${primaryCity}]\n` +
        `Right now: ${weatherData.temp}°F (feels like ${weatherData.feelsLike}°F), ${weatherData.condition}\n` +
        `Today: high ${weatherData.high}°F / low ${weatherData.low}°F` +
        (weatherData.precipChance > 20 ? `, ${weatherData.precipChance}% chance of rain` : "") + `\n` +
        (weatherData.forecastDays[0]
          ? `Tomorrow: high ${weatherData.forecastDays[0].high}°F / low ${weatherData.forecastDays[0].low}°F, ${weatherData.forecastDays[0].condition}` +
            (weatherData.forecastDays[0].precipChance > 20 ? `, ${weatherData.forecastDays[0].precipChance}% chance of rain` : "") + `\n`
          : "")
      : "";

    const todoBlock = todoItems.length > 0
      ? `\n\n[VERIFIED — To-Do List — ${todoItems.length} item${todoItems.length === 1 ? "" : "s"}]\n` +
        todoItems.map((i) => `• ${i.item_text}`).join("\n") +
        `\n\nTO-DO INSTRUCTION: Briefly mention the to-do list if items look actionable today — one natural sentence at most. ` +
        `Example: "You've got ${todoItems.length > 2 ? `${todoItems.length} things on your list` : `a couple of things on your to-do list`}${todoItems[0] ? `, including ${todoItems[0].item_text}` : ""}." ` +
        `Skip entirely if the list feels irrelevant to the rest of the briefing.`
      : "";

    // ── Story dedup — filter seen headlines from news, Dallas, venue concerts ──
    // News: strip **bold headline** + sentence pairs that appeared in the last 3 days
    const { filtered: dedupedNewsBlock, removed: removedNewsHeadlines } = filterNewsBlock(newsBlock, seenHeadlines);
    if (removedNewsHeadlines.length > 0) {
      logger.info({ userName, removed: removedNewsHeadlines }, "[StoryDedup] Filtered duplicate news headlines");
    }


    // Venue concerts: filter by artistOrEvent + venue key, rebuild block.
    // Uses 14-day window (seenVenueHeadlines) so upcoming concerts don't re-appear daily.
    const rawVenueConcerts = getVenueConcerts();
    const filteredVenueConcerts = rawVenueConcerts.filter(
      (c) => !isDuplicate(`${c.artistOrEvent} ${c.venue}`, seenVenueHeadlines)
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
      ...rawVenueConcerts.map((c) => `${c.artistOrEvent} ${c.venue}`), // venue concerts
    ];

    // Email and calendar are NOT fetched at pre-generation time.
    // They are fetched live at delivery time (when the user says "good morning")
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

    const ordersBlock = (() => {
      if (!outForDeliveryOrders || outForDeliveryOrders.length === 0) return "";
      const items = outForDeliveryOrders.map((o) => `• ${o.item_name} from ${o.retailer}`).join("\n");
      const count = outForDeliveryOrders.length;
      return `\n\n[VERIFIED — Orders Out for Delivery Today]\n${items}\nCRITICAL: Mention this naturally near the start of the briefing. ${count === 1 ? `Say something like: "Your ${outForDeliveryOrders[0].item_name} from ${outForDeliveryOrders[0].retailer} is out for delivery today."` : `Say something like: "${count} packages arriving today — your ${outForDeliveryOrders.map((o) => o.item_name).join(" and ")}." `}Keep it brief — one sentence.`;
    })();

    const billsMorningBlock = upcomingBills.length > 0
      ? `\n\n[VERIFIED — Bills Database — Due in Next 3 Days]\n${formatBillsForPrompt(upcomingBills)}\nMention ONLY if due within 3 days, skip entirely otherwise.`
      : "";

    const datesBlock = upcomingDates.length > 0
      ? `\n\n[VERIFIED — Dates Database — Upcoming Birthdays & Anniversaries]\n${formatDatesForPrompt(upcomingDates)}`
      : "";

    const sundaySummaryBlock = isSunday && sundayData ? buildSundaySummaryBlock(sundayData) : "";


    const recFollowUpBlock = pendingFollowUps.length > 0
      ? buildRecommendationFollowUpBlock(pendingFollowUps)
      : "";


    const profileContextBlock = buildProfileContext(
      userProfile ?? null,
      keyPeople
    );

    const peopleContextBlock = buildPeopleContextBlock(keyPeople, userProfile?.name ?? undefined);

    // ── Split the system prompt into preamble (before email+calendar slot) ──────
    // and suffix (after email+calendar slot, through MASTER_BRIEFING_INSTRUCTION).
    // At delivery time, chat.ts inserts live gmailBlock + calendarBlock between them.
    const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, userName);
    const preamble = getCurrentDateTimeBlock() + "\n" + corePrompt + profileContextBlock +
      memoryBlock + dynamicProfileBlock + prefsBlock + notesBlock + peopleContextBlock;

    const personalFollowUpsBlock = buildPersonalFollowupsBlock(personalFollowUps);


    // ── Recent [Name]'s Life entries (last 7 days) ───────────────────────────
    const _briefingFirstName = userProfile?.name?.split(" ")[0] ?? "there";
    const _lifeSectionName   = `${_briefingFirstName}'s Life`;
    const [recentMydayEntries, pendingLifeSuggestion] = await Promise.all([
      getMydayEntries(userName).catch((): MydayEntry[] => []),
      getPendingSuggestion(userName).catch(() => null),
    ]);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const mydayFiltered = recentMydayEntries
      .filter((e) => new Date(e.entry_date) >= sevenDaysAgo)
      .slice(0, 7);
    const mydayBlock = mydayFiltered.length > 0
      ? `\n\n[${_lifeSectionName} — Recent Entries]\n` +
        mydayFiltered.map((e) => `• ${e.entry_date}: ${e.content}`).join("\n") +
        `\nReference these naturally when they connect to something in today's news, calendar, or closing thought. Do not force them in.`
      : "";

    // ── Life suggestion from dot-connector (surface once, never repeat) ───────
    let lifeSuggestionBlock = "";
    if (pendingLifeSuggestion) {
      lifeSuggestionBlock =
        `\n\n[${_lifeSectionName} — Actionable Suggestion]\n` +
        `After the thought of the day — ONLY ONCE — weave this single sentence in naturally before the closing question: ` +
        `"${pendingLifeSuggestion.suggestion}"\n` +
        `If the user responds positively, help them act on it. If they ignore or redirect, drop it permanently.`;
      markSuggestionSurfaced(userName, pendingLifeSuggestion.id).catch(() => {});
    }

    // ── Socratic mirror — pattern observation (surface once, never repeat) ───
    let observationBlock = "";
    if (pendingObservation) {
      observationBlock =
        `\n\n[${_lifeSectionName} — Pattern Observation]\n` +
        `After the thought of the day, weave this observation in naturally — ONCE, as part of the flow: ` +
        `"${pendingObservation.observation}"\n` +
        `Deliver it as a warm, curious friend noticing something — not as analysis. ` +
        `If it lands, let the user respond. If they redirect, drop it completely.`;
      markObservationSurfaced(userName, pendingObservation.id).catch(() => {});
    }


    // All data blocks assembled — build the suffix.
    // The briefing instruction is the final element so Claude's marching orders
    // are the last thing it reads before generating the response.
    // News appears before Dallas local content and venue concerts so Claude gives it
    // appropriate prominence — national/international news is mandatory in every briefing.
    // ── Cross-domain intelligence (non-calendar checks — calendar runs live at delivery) ─
    const upcomingDateActions = await checkUpcomingDates(userName).catch(() => []);
    const crossDomainBlock = upcomingDateActions.length > 0
      ? `\n\n[Upcoming Dates]\n` + upcomingDateActions.map((a) => `• ${a.title}: ${a.detail}`).join("\n")
      : "";


    const todayTrip = await getTodayTripDay(userName).catch(() => null);
    const tripDayBlock = todayTrip ? buildTripDayBlock(todayTrip) : "";

    // ── Apply briefing toggle preferences ─────────────────────────────────────
    const _bWeather = userSettings?.briefingWeather !== false ? weatherContextBlock : "";
    const _bTodos   = userSettings?.briefingTodos   !== false ? todoBlock : "";
    const _bNews    = userSettings?.briefingNews    !== false ? dedupedNewsBlock : "";
    const stoicBlock = userSettings?.briefingStoic !== false && stoicEntry
      ? buildStoicBlock(stoicEntry, intentionQuestion ?? `What's the one thing that would make today feel worthwhile?`)
      : "";

    const _bSports = sportsBlock || "";

    const suffix =
      _bWeather +
      tripDayBlock +
      ordersBlock +
      _bTodos +
      tvMorningBlock +
      billsMorningBlock +
      datesBlock +
      sundaySummaryBlock +
      recFollowUpBlock +
      personalFollowUpsBlock +
      mydayBlock +
      lifeSuggestionBlock +
      observationBlock +
      crossDomainBlock +
      _bNews +
      _bSports +
      dedupedVenueConcertsBlock +
      onboardingNudgeBlock +
      stoicBlock +
      buildNarrativeBriefingInstruction(primaryCity, userProfile?.companionName ?? null, userProfile?.name ?? undefined, intentionQuestion, userSettings ?? undefined);

    // Log which static sections have data
    const sectionLog: Record<string, boolean | string> = {
      "weather": weatherContextBlock.length > 0 ? "context-included" : "unavailable",
      "todo": todoItems.length > 0 ? `${todoItems.length} items` : false,
      "email": "live-at-delivery",
      "calendar": "live-at-delivery",

      "news": dedupedNewsBlock.length > 0,
      "sports": !!(sportsScores),
      "music_events": filteredVenueConcerts.length > 0 ? `${filteredVenueConcerts.length} concerts` : "EMPTY",
      "birthdays": upcomingDates.length > 0,
      "bills_3day": upcomingBills.length > 0,
      "my_day_entries": mydayFiltered.length > 0 ? `${mydayFiltered.length} entries` : false,
      "sunday_special": isSunday,
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
      "Static briefing context cached — pre-generating full briefing with live email+calendar"
    );

    // ── Full briefing pre-generation ───────────────────────────────────────────
    // Fetch email + calendar NOW so that when the user opens the app and says
    // "good morning", the response is instant (served from 90-minute TTL cache).
    // This runs entirely in the background — errors are caught and logged.
    try {
      const preNow = new Date();
      const t0pregen = Date.now();

      const emailPrePromise = fetchAndSummarizeEmails(10, undefined, userName).catch(() => null);
      const calendarPrePromise = fetchWeekEvents(false, userName).catch(() => null);

      // Calendar first — unblocks departure-time calculations immediately
      const preCalEvents = await calendarPrePromise;
      const preLiveEvents = preCalEvents?.filter((ev) => {
        if (ev.allDay) return true;
        if (!ev.startIso) return true;
        return new Date(ev.startIso) > preNow;
      }) ?? null;

      // Identify today's events for the email-to-calendar correlation search
      const todayStr = chicagoDateStr(preNow);
      const preTodayEvents = (preLiveEvents ?? []).filter((e) => e.isoDate === todayStr);

      // Launch email correlation search in parallel — capped at 10 s internally
      // Only runs when there are today events with attendees; otherwise resolves immediately
      const emailCorrelationsPromise: Promise<Map<string, CalendarEmailCorrelation>> =
        preTodayEvents.some((e) => !e.allDay && (e.attendees?.length ?? 0) > 0)
          ? buildCalendarEmailCorrelations(preTodayEvents, userName).catch(() => new Map())
          : Promise.resolve(new Map());

      // Smart calendar block (today+tomorrow w/ departure times) — capped at 8 s, runs while Gmail is still in-flight
      // Email correlations are also awaited before building so the notes are embedded
      const preSmartCalPromise: Promise<string> = preLiveEvents !== null
        ? Promise.race([
            emailCorrelationsPromise.then((correlations) =>
              buildSmartCalendarBlock(preLiveEvents, homeAddress, primaryLat, primaryLon, correlations),
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve(""), 10_000)),
          ])
        : Promise.resolve("");

      const preEmails = await emailPrePromise;

      const [preSmartCalBlock] = await Promise.all([preSmartCalPromise]);

      logger.info(
        { userName, emailCount: preEmails?.length ?? "null", calCount: preLiveEvents?.length ?? "null", elapsedMs: Date.now() - t0pregen },
        "[MorningPush] Pre-gen: email+calendar+departure fetched"
      );

      // Build Gmail block
      let preEmailBlock: string;
      if (preEmails === null) {
        preEmailBlock = `\n\n[VERIFIED — Gmail API — status: NOT CONNECTED]\nGoogle is not connected or the token has expired. Tell the user: "I couldn't pull your email — Google may need to be reconnected in the app settings." Keep it to one sentence.`;
      } else if (preEmails.length === 0) {
        preEmailBlock = `\n\n[VERIFIED — Gmail API — unread emails (live at delivery time)]\nInbox is clear — no unread messages right now. Mention this briefly and warmly in one short sentence — e.g. "Your inbox is clear this morning." Don't dwell on it.`;
      } else {
        preEmailBlock =
          `\n\n[VERIFIED — Gmail API — unread emails (live at delivery time)]\n${formatEmailsForPrompt(preEmails)}\nThis is VERIFIED data. State sender names, subjects, and content exactly as shown.` +
          buildImportantEmailInstruction(preEmails, userProfile?.companionName, userName);
      }

      // Build calendar block
      let preCalendarBlock: string;
      if (preLiveEvents !== null) {
        const calContent = preSmartCalBlock.trim() !== ""
          ? preSmartCalBlock
          : formatCalendarForPrompt(preLiveEvents, "this week");
        preCalendarBlock =
          `\n\n[VERIFIED — Google Calendar API — Today & Tomorrow with pre-calculated departure times, plus rest of week]\n` +
          `${calContent}\n\n` +
          `⚠ CALENDAR RULE — NO EXCEPTIONS: Use ONLY the exact event title shown above. NEVER substitute, infer, or enrich event titles with names or context from memory. Report every event title letter-for-letter as written. Departure times in the block are pre-calculated facts — state them directly ("Leave by 6:30 PM"). If you want to add any context beyond what's shown, frame it as a question (INFERRED tier), never a statement.\n\n` +
          `EMAIL-TO-CALENDAR INTELLIGENCE: Some events above have an [EMAIL NOTE] line beneath them. These are real Gmail messages from that attendee found in the last 7 days. When present:\n` +
          `• Surface the connection naturally and conversationally — e.g. "You have a call with Sarah at 10 — she emailed yesterday about the Henderson project, might be worth a quick look before you hop on."\n` +
          `• This is INFERRED tier: frame it as an observation or question, never a stated fact about the meeting's agenda.\n` +
          `• Only mention it when it genuinely adds useful context. If the email subject is vague or unrelated, skip the mention.\n` +
          `• NEVER invent email content not shown in the [EMAIL NOTE]. Use only the subject line shown.`;
      } else {
        preCalendarBlock = `\n\n[VERIFIED — Google Calendar API — status: NOT CONNECTED]\nGoogle Calendar authentication failed — no refresh token. This means zero calendar data is available.\nCRITICAL RULES — NO EXCEPTIONS:\n• Say EXACTLY this one sentence: "I can't pull your calendar right now — Google may need to be reconnected in the app settings."\n• Do NOT say his calendar is clear, open, or free.\n• Do NOT say he has nothing scheduled or no events.\n• Do NOT mention any specific event, appointment, or meeting.\n• Do NOT use any qualifier about calendar status (e.g. "looks like a clear day", "you seem free", "nothing on the agenda").\n• The calendar is DISCONNECTED — you have NO information about it. Silence on calendar status is the only acceptable alternative to the one sentence above.`;
      }

      // Run Claude Haiku with the full prompt — capped at 45 s
      const fullPreSystem = preamble + preEmailBlock + preCalendarBlock + suffix;
      const anthropic = new Anthropic();
      const pregenResult = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          system: fullPreSystem,
          messages: [{ role: "user", content: "good morning" }],
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 45000)),
      ]);

      if (pregenResult && pregenResult.content[0]?.type === "text") {
        const briefingText = pregenResult.content[0].text;
        setCachedBriefing(userName, briefingText, generationDateKey);
        incrementStoicDay(userName).catch((e) => logger.warn({ e }, "[Stoic] Failed to increment stoic day"));
        logger.info(
          { userName, chars: briefingText.length, totalMs: Date.now() - t0pregen },
          "[MorningPush] Full briefing pre-generated and cached — native delivery will be instant"
        );
      } else {
        logger.warn({ userName }, "[MorningPush] Pre-gen Claude call timed out or returned empty — native path will regenerate on first call");
      }
    } catch (pregenErr) {
      logger.warn({ pregenErr, userName }, "[MorningPush] Full briefing pre-generation failed — native path will regenerate on first call");
    }
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing static context");
  }
}
