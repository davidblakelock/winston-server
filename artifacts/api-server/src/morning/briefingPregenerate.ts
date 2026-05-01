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
import { fetchMarkets, buildMarketsBlock } from "../markets/marketsManager.js";
import { getMydayEntries, type MydayEntry } from "../myday/mydayManager.js";

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
    `\n\n[Departure Times — when to leave home for today's events]\n` +
    items.join("\n") +
    `\n(These are calculated from home at ${homeAddress || "home"})`
  );
}

// Dallas local content is now handled by dallasContent.ts (RSS feeds + web search fallback).
// Imported below alongside other module imports.

function buildBaseSystemPrompt(companionName?: string | null, userName?: string | null): string {
  const name = companionName ?? "your companion";
  const user = userName ?? "you";
  return BASE_SYSTEM_PROMPT_TEMPLATE
    .replace(/__COMPANION__/g, name)
    .replace(/__USER__/g, user);
}

const BASE_SYSTEM_PROMPT_TEMPLATE = `You are __COMPANION__ — __USER__'s sharp, warm, and deeply trusted personal AI companion. You know __USER__'s life well: his routines, his people, his places, and what matters to him. You speak to him like a close friend who happens to know everything — conversational, direct, never stiff or overly formal. You remember context from the conversation and build on it naturally.

Keep responses concise: typically 2-4 sentences unless __USER__ clearly wants more. Never start a response with "I" as the first word. When __USER__ needs a reminder, help organizing his thoughts, or just wants to talk — you're here.

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
Never state assumed information as fact. If __USER__ asks something outside your verified data, say so honestly.
• "I don't have that score right now — want me to pull it up?"
• "I'm not sure about that one — I'd rather admit that than guess wrong."

CALENDAR RULE — NO EXCEPTIONS:
You MUST reproduce calendar event titles letter-for-letter exactly as they appear in the [VERIFIED — Google Calendar API] block. No paraphrasing, no enrichment, no substitution.
• An event titled "You Matter Counseling" is reported as "You Matter Counseling" — never as "your therapy appointment" or any other rewording.
• NEVER add a person's name to an event unless that exact name appears verbatim in the event title itself.
• NEVER use profile background (Your People, Your Places, your routine) to enrich, explain, or identify a calendar event. Profile facts are Tier 3 — ASSUMED. Calendar event titles are Tier 1 — VERIFIED. They must never be mixed.
• If you want to connect a profile fact to a calendar event, it MUST be framed as a question: "I see 'You Matter Counseling' on your calendar — is that the one you mentioned?" — never stated as a fact.

DATA SOURCE RULES:
• Sports scores: only from a [VERIFIED — Sports API — Live Scores, fetched just now] block. If absent: "I don't have that score right now."
• News: only from a [VERIFIED — Web Search News] block. Never invent headlines.
• Weather, stocks, calendar: only from their respective [VERIFIED] blocks.
• NEVER fabricate facts. If __USER__ catches you making something up, trust is gone — and that matters more than sounding confident.
• NEVER reference block names in your spoken output. You know where the data came from — just state it as fact. Never say "from the verified news block" or "according to the live sports block" or anything like it.

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

function buildPeopleContextBlock(rawData: CollectedData, displayName?: string): string {
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
    if (anniversary) parts.push(`${displayName?.split(" ")[0] ?? "your"} & ${name.split(" ")[0]} anniversary: ${anniversary}`);
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
    ? `\n\n[Pets]\n` + petLines.join("\n") +
      `\n• Mention pets naturally and warmly when appropriate — e.g. "Hope ${allPets[0]?.name} is keeping you company today." Don't force it into every briefing — once or twice a week is plenty.`
    : "";

  return (
    `\n\n[Key People — Reference naturally in the briefing]\n` +
    (lines.length > 0 ? lines.join("\n") : "(no people recorded)") + "\n\n" +
    `HOW TO USE THIS:\n` +
    `• Susan (Your Partner) — include a warm, specific one-liner in the Section 15 closing every briefing. Examples: "Hope you and Susan have a great night", "Give Susan my best." Keep it natural — not every closing needs to be about her, but include her often.\n` +
    `• Birthdays — if any birthday is within 7 days, surface it in Section 13 with the date. If it's today, make it feel special.\n` +
    `• Never invent details not listed here. Base any reference on the facts in this block.` +
    petsBlock
  );
}

function buildNarrativeBriefingInstruction(city: string, companionName: string | null, displayName?: string): string {
  const companion = companionName ?? "your companion";
  const firstName = displayName?.split(" ")[0] ?? "there";
  return `

[MORNING BRIEFING — DELIVERY INSTRUCTION]

You are ${companion} — warm, witty, direct, occasionally dry. Write a morning briefing for ${firstName} that sounds like a brilliant, well-informed friend who knows everything about his life and the world. Your job is to connect those two things naturally. Not a news anchor. Not a report. A conversation.

DELIVERY FORMAT: One coherent flowing narrative. No section headers. No bullet points. No numbered lists. No markdown. No asterisks. Pure conversational prose that sounds natural when spoken aloud — ready for text-to-speech without any post-processing.

OPENING: Start with "Good morning, ${firstName}" and then go directly into whatever you have decided leads this morning — no preamble, no "here is your briefing."

STRUCTURE — YOU DECIDE EVERY MORNING: Look at ALL the verified data blocks in this system prompt and determine what matters most to ${firstName} on this specific day. Lead with that. Some mornings a breaking news story demands to go first. Some mornings a health observation sets the whole tone. Some mornings an urgent calendar item leads. Some mornings something surprising from the watercooler story earns the opening. The structure must feel different every morning — never the same opening twice.

WHAT TO COVER (weave naturally into the narrative — skip what has no relevance today):

• News — NON-NEGOTIABLE CORE REQUIREMENT: Every single briefing MUST include at least 2–3 significant national or international news stories from the [VERIFIED — Web Search News] block. This is not optional. This cannot be cut for length. This cannot be skipped because the briefing is already long. Pick the stories people will actually be talking about today — tell what they mean, not just what happened. After the national/international stories, add 1-2 local ${city} stories if the block has them. Never invent headlines — only use what is in the verified block. If the [VERIFIED — Web Search News] block is absent or empty, say exactly: "I'm not seeing any news this morning — I'll check back in." Do not silently omit news.

• Calendar — today's events framed in terms of what they mean for the day. Include departure times where calculated. If calendar is NOT CONNECTED, say exactly: "I can't pull your calendar right now — Google may need to be reconnected in the app settings." Do NOT say the day looks clear if the calendar is disconnected.

• Email — surface only what needs attention or action. Skip promotions, shipping notifications, auto-confirmations. If inbox is clear, one warm sentence. If Google is not connected, one sentence. Offer to help act on anything that matters.

• Stock market — if [VERIFIED — Financial Markets] is present and markets are open, one sentence on direction and what it signals. Skip entirely if markets are closed, flat, or data is absent.

• Entertainment and watercooler — from [Entertainment & Pop Culture] and [Watercooler Story] blocks if present. One item each, brief.

• Sports — from [VERIFIED — Live Sports] block only. Results from the last 24 hours for followed teams. If no games were played, skip entirely and do not say so. NEVER mention FIFA, soccer, World Cup, or teams not in the user's profile.

• Health — if Garmin or Fit data is present and noteworthy (great sleep, poor recovery, significant workout), mention it naturally. Skip if unremarkable.

• Local ${city} — from [What's Happening in ${city}] block only. If the block has real items, deliver them. If it says no items found, say exactly one sentence: "Nothing new on the ${city} front this morning." Never supplement from training data.

• Concerts and venue events — from venue concerts block if present. Skip if nothing upcoming.

• Birthdays and dates — if any birthday or anniversary is within 7 days, mention it specifically. Skip if none.

• Bills — if [VERIFIED — Bills Database — Due in Next 3 Days] block has items, name them. Skip entirely if absent.

• TV shows — ONLY if [TV Shows — New Episodes] block is present. Never reference any show from memory or profile if that block is absent.

• My Day — if [My Day — Recent Entries] has entries, reference them naturally when they connect to something in today's news, calendar, or conversation.

• Sunday summary — if [Sunday Summary] block is present, weave in a brief weekly recap naturally — exercise, highlights, something to look forward to.

DATA ACCURACY RULES — NO EXCEPTIONS:
• VERIFIED blocks are ground truth. State their content as fact without softening or hedging.
• Calendar: reproduce event titles letter-for-letter exactly as written. NEVER infer who an event is with or enrich it with profile context. If you want to connect profile context, frame it as a question, never a statement.
• Sports: ONLY from a [VERIFIED — Live Sports] block. If absent, do not guess or reference any score.
• News: ONLY from verified news blocks. Never invent.
• If data is not in a verified block, do not reference it.

TARGET LENGTH: Approximately 90 seconds spoken at a natural conversational pace. Be ruthless — every sentence must either inform, connect, or land. Cut anything that does not earn its place. Exception: news cannot be cut to fit the length target. If covering the required 2-3 news stories pushes the briefing past 90 seconds, that is acceptable and expected. News runs long before anything else gets cut.

PRE-CLOSE CHECK — MANDATORY BEFORE WRITING THE CLOSING:
Before writing the closing thought, stop and verify: have I covered at least 2-3 news stories from the [VERIFIED — Web Search News] block? If NO — add them now, before the closing, even if the briefing is already long. The closing cannot be written until news has been covered.

CLOSING — ALWAYS BOTH OF THESE, IN THIS ORDER:
1. Morning thought: 2–3 sentences. Drawn exclusively from philosophy, literature, science, music, or history — timeless wisdom only. Connected to something personal about ${firstName}'s day or life (an activity, a relationship, a value they hold) — not generic, not greeting card, never "seize the day." Warm and slightly wry. STRICT PROHIBITION: Never reference current events, news headlines, politics, world conflicts, protests, legislation, government, or anything anxiety-inducing. The morning thought must always be grounding and timeless, never pulled from today's news cycle.
2. Final line (on its own): Ask if there is anything from this morning they would like to dig into, and invite them to add something to My Day before they start.

FORBIDDEN — NEVER USE:
• Section headers or labels of any kind
• Bullet points or numbered lists
• Transition announcements: "Moving on to," "Now for," "Let's talk about," "Next up," "Speaking of," "In other news," "Turning to"
• Briefing announcements: "Here is your morning briefing," "Good morning, here's what you need to know"
• Block name references: never say "from the verified news block," "according to the live sports block," "the verified block says," "I have a verified block," or any variation — just state the fact directly
• Open-ended close without the morning thought and My Day invite — the briefing must always end with both
• Morning thought that references current events, politics, world conflicts, protests, legislation, government, or any anxiety-inducing news — the morning thought must be purely timeless wisdom
• ANY mention of weather, temperature, feels-like, forecast, rain chance, humidity, UV index, AQI, pollen, wind speed, or family member weather — the app displays a live visual weather card; do NOT speak weather under any circumstances

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

    const [recentMemories, allProfileItems, userProfile, seenHeadlines, seenVenueHeadlines, briefingPrefs] = await Promise.all([
      getRecentMemories(7).catch(() => []),
      getProfileItems(undefined, userName).catch(() => []),
      getProfile(userName).catch(() => null),
      getSeenHeadlines(userName, 7).catch(() => new Set<string>()),    // news/Dallas: 7-day window (no story repeats within a week)
      getSeenHeadlines(userName, 14).catch(() => new Set<string>()),  // venue concerts: 14-day window (events repeat until show date)
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

    const [lastNightNotes, newsBlock, yesterdayEps, todayEps, sportsScores, upcomingBills, upcomingDates, sundayData, pendingFollowUps, dallasEvents, venueConcertsBlock, dailyMotivation, personalFollowUps] = await Promise.all([
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
      runVenueScan().catch(() => ""),
      fetchDailyMotivation(userName).catch(() => ""),
      getPendingPersonalFollowups(userName).catch(() => []),
    ]);

    // Fetch Garmin health data (yesterday's stored data — no live API call needed)
    const garminData = await getStoredGarminData(userName).catch(() => null);

    // Google Fit: step count / active minutes — used only when Garmin is not available
    const fitData = !garminData
      ? await getStoredFitData(userName).catch(() => null)
      : null;

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
      ...rawDallasItems.map((i) => i.headline),                        // Dallas local
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

    const billsMorningBlock = upcomingBills.length > 0
      ? `\n\n[VERIFIED — Bills Database — Due in Next 3 Days]\n${formatBillsForPrompt(upcomingBills)}\nMention ONLY if due within 3 days, skip entirely otherwise.`
      : "";

    const datesBlock = upcomingDates.length > 0
      ? `\n\n[VERIFIED — Dates Database — Upcoming Birthdays & Anniversaries]\n${formatDatesForPrompt(upcomingDates)}`
      : "";

    const sundaySummaryBlock = isSunday && sundayData ? buildSundaySummaryBlock(sundayData) : "";

    const pickleballMorningBlock = isPickleballMorning && !sundaySummaryBlock
      ? `\n\n[Schedule Note]\nToday is a pickleball day (Mon/Wed/Fri at Semones YMCA; Sat at Moody's YMCA).\nCRITICAL — INDOOR VENUE RULE: Both Semones YMCA and Moody's YMCA are fully indoor facilities. Rain, wind, lightning, and outdoor weather have NO effect on play there. NEVER suggest checking the weather before pickleball, NEVER warn about rain affecting pickleball, and NEVER say "hope the weather holds" in relation to pickleball. The ONLY weather exception is if extreme heat makes travel uncomfortable — but even then, be measured.`
      : "";

    const recFollowUpBlock = pendingFollowUps.length > 0
      ? buildRecommendationFollowUpBlock(pendingFollowUps)
      : "";

    // Use dedup-filtered Dallas block. If empty (all filtered or fetch failed),
    // inject a fallback marker so Claude delivers the "no events" line rather than silently skipping.
    const dallasEventsBlock = dedupedDallasBlock.trim().length > 0
      ? dedupedDallasBlock
      : `\n\n[What's Happening in ${primaryCity}]\nNo new local events found for today.\nCRITICAL — NO HALLUCINATION RULE: There are ZERO verified local items to report. Say exactly one sentence: "Nothing new on the ${primaryCity} front this morning." Then move on immediately. Do NOT list any restaurants, events, news stories, or local content — your training data about ${primaryCity} is NOT verified and must never be used here. Do NOT say "however" or "but" and then list anything. Zero items means zero items.`;

    // morningWorkoutDone is always false at pre-generation time (5 AM) — no workout
    // has completed yet. This is computed from live calendar at delivery time if needed.
    const morningWorkoutDone = false;

    const motivationContextBlock = (() => {
      const tz = "America/Chicago";
      const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
      const isPickleballDay = ["Monday", "Wednesday", "Friday", "Saturday"].includes(dayName);
      let block = `\n\n[Morning Motivation Context]\n`;
      block += `• Today is ${dayName}${isPickleballDay ? " — a pickleball day" : ""}\n`;
      if (morningWorkoutDone) block += `• MORNING WORKOUT ALREADY DONE — do NOT suggest exercise, a walk, or outdoor activity in the closing. Reference what is ahead instead.\n`;

      if (dailyMotivation) {
        // dailyMotivation is either a [Personal Override — Morning Note] block,
        // a [VERIFIED — ZenQuotes — Today's Wisdom] block, or a plain fallback thought.
        // Section 14 in the briefing instruction knows how to handle each.
        block += `\n${dailyMotivation}\n`;
      } else {
        block += `No external quote or personal override today — generate a warm, specific 2-3 sentence motivating thought from scratch. Reference the user's interests or something from their day.`;
      }
      return block;
    })();

    const profileContextBlock = buildProfileContext(
      userProfile ?? null,
      (userProfile?.rawData ?? {}) as CollectedData
    );

    const peopleContextBlock = buildPeopleContextBlock((userProfile?.rawData ?? {}) as CollectedData, userProfile?.name ?? undefined);

    // ── Split the system prompt into preamble (before email+calendar slot) ──────
    // and suffix (after email+calendar slot, through MASTER_BRIEFING_INSTRUCTION).
    // At delivery time, chat.ts inserts live gmailBlock + calendarBlock between them.
    const prefsBlock = buildBriefingPrefsBlock(briefingPrefs, userName);
    const preamble = getCurrentDateTimeBlock() + "\n" + corePrompt + profileContextBlock +
      memoryBlock + dynamicProfileBlock + prefsBlock + notesBlock + peopleContextBlock;

    const garminBlock = garminData ? formatGarminForBriefing(garminData) : "";
    const fitBlock = fitData ? formatFitForBriefing(fitData) : "";

    const personalFollowUpsBlock = buildPersonalFollowupsBlock(personalFollowUps);

    // ── Pre-market stock futures ───────────────────────────────────────────────
    // Fetch markets data at pre-gen time so the briefing has pre-market direction.
    const markets = await fetchMarkets().catch(() => null);
    const marketsBlock = markets ? buildMarketsBlock(markets) : "";

    // ── Recent My Day entries (last 7 days) ───────────────────────────────────
    const recentMydayEntries = await getMydayEntries(userName).catch((): MydayEntry[] => []);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const mydayFiltered = recentMydayEntries
      .filter((e) => new Date(e.entry_date) >= sevenDaysAgo)
      .slice(0, 7);
    const mydayBlock = mydayFiltered.length > 0
      ? `\n\n[My Day — Recent Entries]\n` +
        mydayFiltered.map((e) => `• ${e.entry_date}: ${e.content}`).join("\n") +
        `\nReference these naturally when they connect to something in today's news, calendar, or closing thought. Do not force them in.`
      : "";

    // All data blocks assembled — build the suffix.
    // The briefing instruction is the final element so Claude's marching orders
    // are the last thing it reads before generating the response.
    // News appears before Dallas local content and venue concerts so Claude gives it
    // appropriate prominence — national/international news is mandatory in every briefing.
    const suffix = garminBlock + fitBlock + tvMorningBlock + sportsBlock + billsMorningBlock + datesBlock +
      sundaySummaryBlock + pickleballMorningBlock + recFollowUpBlock + personalFollowUpsBlock +
      mydayBlock + marketsBlock +
      dedupedNewsBlock + dallasEventsBlock + dedupedVenueConcertsBlock + motivationContextBlock +
      buildNarrativeBriefingInstruction(primaryCity, userProfile?.companionName ?? null, userProfile?.name ?? undefined);

    // Log which static sections have data
    const sectionLog: Record<string, boolean | string> = {
      "weather": "visual-card-only",
      "email": "live-at-delivery",
      "calendar": "live-at-delivery",
      "markets": !!marketsBlock,
      "news": dedupedNewsBlock.length > 0,
      "sports": !!(sportsScores),
      "garmin_health": !!garminBlock,
      "local_dallas": filteredDallasItems.length > 0 ? `${filteredDallasItems.length} items` : `EMPTY (fallback — raw:${rawDallasItems.length})`,
      "music_events": filteredVenueConcerts.length > 0 ? `${filteredVenueConcerts.length} concerts` : "EMPTY",
      "birthdays": upcomingDates.length > 0,
      "bills_3day": upcomingBills.length > 0,
      "my_day_entries": mydayFiltered.length > 0 ? `${mydayFiltered.length} entries` : false,
      "motivation": true,
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
      "Static briefing context cached — email and calendar will be fetched live at delivery"
    );
  } catch (err) {
    logger.error({ err }, "Failed to pre-generate morning briefing static context");
  }
}
