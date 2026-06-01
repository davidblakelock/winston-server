/**
 * Fresh Morning Briefing Generator
 *
 * Generates the full morning briefing ON DEMAND — no pre-caching.
 * Every call fetches live data: sleep, weather, calendar, email, news, events.
 *
 * Sections (in order):
 *  1. Greeting
 *  2. Sleep score (Google Fit — live)
 *  3. Weather (home city + family cities + upcoming trips)
 *  4. Calendar (today only; departure time only if event within 2 hours)
 *  5. Email (actionable only)
 *  6. To-Do list count
 *  7. Deliveries expected today
 *  8. Top 3-4 news stories (web search)
 *  9. Feel-good story (RSS feeds, 7-day dedup)
 * 10. Local events (Ticketmaster + SerpAPI Google Events)
 * 11. Stoic closing + deep link to journal
 */

import Anthropic from "@anthropic-ai/sdk";
import { getProfile, type CollectedData } from "../onboarding/onboardingManager.js";
import { getCachedWeather } from "../weather/weatherCache.js";
import { fetchTodayEvents, chicagoDateStr, toChicagoTime } from "../google/calendar.js";
import { fetchAndSummarizeEmails, type EmailSummary } from "../google/gmail.js";
import { getOrdersForBriefing } from "../orders/ordersManager.js";
import { getStoicForUser, incrementStoicDay } from "../stoic/stoicManager.js";
import { fetchBestLocalEvent } from "../events/apifyEventsManager.js";
import { fetchYesterdayFitData } from "../google/fit.js";
import { estimateDriveTime, extractEventLocation } from "../departure/departureManager.js";
import { getSeenHeadlines, logBriefingStories, normalizeKey } from "./storyDedup.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic();

// ── Sleep quality mapping ─────────────────────────────────────────────────────

function sleepQuality(minutes: number): "well" | "pretty well" | "not so well" {
  if (minutes >= 420) return "well";          // 7+ hours
  if (minutes >= 360) return "pretty well";   // 6-7 hours
  return "not so well";                       // < 6 hours
}

// ── Geocode a city name → lat/lon (Google Geocoding API) ──────────────────────

const _geocodeCache = new Map<string, { lat: number; lon: number }>();

async function geocodeCity(city: string): Promise<{ lat: number; lon: number } | null> {
  const cached = _geocodeCache.get(city.toLowerCase());
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city)}&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const loc = data.results?.[0]?.geometry?.location;
    if (!loc?.lat || !loc?.lng) return null;
    const coords = { lat: loc.lat, lon: loc.lng };
    _geocodeCache.set(city.toLowerCase(), coords);
    return coords;
  } catch {
    return null;
  }
}

// ── Feel-good story from RSS feeds (7-day dedup) ──────────────────────────────

interface GoodStory { title: string; source: string; }

const FG_PREFIX = "fg:";

async function fetchGoodStory(seenFg: Set<string>): Promise<GoodStory | null> {
  const feeds = [
    { url: "https://www.goodnewsnetwork.org/feed/", source: "Good News Network" },
    { url: "https://positive.news/feed/", source: "Positive News" },
  ];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Winston/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)].slice(0, 25);
      for (const [, content] of items) {
        if (!content) continue;
        const titleMatch =
          content.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s) ??
          content.match(/<title>(.*?)<\/title>/s);
        const title = titleMatch?.[1]?.trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        if (!title || title.length < 10) continue;
        const key = FG_PREFIX + normalizeKey(title);
        if (seenFg.has(key)) continue;
        return { title, source: feed.source };
      }
    } catch {
      continue;
    }
  }

  // Reddit r/UpliftingNews fallback
  try {
    const res = await fetch(
      "https://www.reddit.com/r/UpliftingNews/top.json?limit=15&t=day",
      { headers: { "User-Agent": "Winston/1.0" }, signal: AbortSignal.timeout(8_000) }
    );
    if (res.ok) {
      const data = await res.json() as {
        data?: { children?: Array<{ data?: { title?: string; url?: string } }> };
      };
      const posts = data.data?.children ?? [];
      for (const post of posts) {
        const title = post.data?.title?.trim();
        if (!title) continue;
        const key = FG_PREFIX + normalizeKey(title);
        if (seenFg.has(key)) continue;
        return { title, source: "r/UpliftingNews" };
      }
    }
  } catch { /* skip */ }

  return null;
}

async function logFgStory(userName: string, title: string): Promise<void> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const key = FG_PREFIX + normalizeKey(title);
    await query(
      `INSERT INTO daily_briefing_stories (user_name, headline, story_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, headline, story_date) DO NOTHING
       RETURNING id`,
      [userName, key, today]
    );
  } catch { /* non-fatal */ }
}

async function getSeenFgStories(userName: string): Promise<Set<string>> {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const { rows } = await query<{ headline: string }>(
      `SELECT headline FROM daily_briefing_stories
       WHERE user_name = $1
         AND headline LIKE 'fg:%'
         AND story_date >= (TO_DATE($2, 'YYYY-MM-DD') - INTERVAL '7 days')
         AND story_date < TO_DATE($2, 'YYYY-MM-DD')`,
      [userName, today]
    );
    return new Set(rows.map((r) => r.headline));
  } catch {
    return new Set();
  }
}

// ── SerpAPI Google Events ─────────────────────────────────────────────────────

interface SerpEvent { title: string; date: string; venue?: string; }

async function fetchSerpApiEvents(city: string, interestKeywords: string[]): Promise<SerpEvent[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];

  const keywords = interestKeywords.slice(0, 3).join(" ");
  const q = `events in ${city} this week ${keywords}`.trim();
  const url = `https://serpapi.com/search.json?engine=google_events&q=${encodeURIComponent(q)}&api_key=${key}&hl=en&gl=us`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      events_results?: Array<{
        title?: string;
        date?: { when?: string; start_date?: string };
        address?: string[];
        venue?: { name?: string };
      }>;
    };
    return (data.events_results ?? []).slice(0, 20)
      .map((e) => ({
        title: (e.title ?? "").trim(),
        date: e.date?.when ?? e.date?.start_date ?? "",
        venue: e.venue?.name ?? e.address?.[0],
      }))
      .filter((e) => e.title.length > 2);
  } catch {
    return [];
  }
}

// ── Upcoming trip destinations with weather ──────────────────────────────────

interface TripInfo { destination: string; startDate: string; }

async function getUpcomingTrips(userName: string): Promise<TripInfo[]> {
  try {
    const { rows } = await query<{ destination: string; start_date: string }>(
      `SELECT destination, start_date::text AS start_date FROM trip_plans
       WHERE user_name = $1
         AND start_date IS NOT NULL
         AND start_date >= CURRENT_DATE
         AND start_date <= CURRENT_DATE + INTERVAL '30 days'
       ORDER BY start_date ASC
       LIMIT 3`,
      [userName]
    );
    return rows.map((r) => ({ destination: r.destination, startDate: r.start_date }));
  } catch {
    return [];
  }
}

// ── Today's calendar with conditional departure times ─────────────────────────

async function buildCalendarData(
  userName: string,
  homeAddress: string,
  primaryLat: number,
  primaryLon: number
): Promise<{ events: Array<{ time: string; title: string; leaveBy?: string }>; }> {
  const events = await fetchTodayEvents(userName).catch(() => null);
  if (!events || events.length === 0) return { events: [] };

  const now = new Date();
  const twoHoursOut = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const TZ = "America/Chicago";

  const result: Array<{ time: string; title: string; leaveBy?: string }> = [];

  for (const event of events) {
    const timeStr = event.allDay
      ? "All day"
      : event.start ?? "";

    let leaveBy: string | undefined;

    if (!event.allDay && event.startIso && homeAddress) {
      const start = new Date(event.startIso);
      const startCT = toChicagoTime(start);
      const nowCT = toChicagoTime(now);
      if (startCT > nowCT && startCT <= toChicagoTime(twoHoursOut)) {
        const location = extractEventLocation({
          summary: event.summary,
          location: event.location,
          description: event.description,
        });
        if (location) {
          try {
            const drive = await Promise.race([
              estimateDriveTime(location, homeAddress, primaryLat, primaryLon),
              new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
            ]);
            if (drive) {
              const leaveAt = new Date(
                start.getTime() - (drive.durationMinutes + 10) * 60_000
              );
              leaveBy = leaveAt.toLocaleTimeString("en-US", {
                timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
              });
            }
          } catch { /* skip */ }
        }
      }
    }

    result.push({ time: timeStr, title: event.summary, leaveBy });
  }

  return { events: result };
}

// ── To-do count ───────────────────────────────────────────────────────────────

async function getTodoCount(userName: string): Promise<number> {
  try {
    const { rows } = await query<{ item_count: string }>(
      `SELECT COUNT(*) AS item_count FROM list_items
       WHERE user_name = $1 AND lower(list_name) = 'to do'`,
      [userName]
    );
    return parseInt(rows[0]?.item_count ?? "0", 10);
  } catch {
    return 0;
  }
}

// ── Main generator ────────────────────────────────────────────────────────────

export async function generateFreshBriefing(userName: string): Promise<string> {
  const t0 = Date.now();

  // ── Step 1: Profile (needed first to drive parallel fetches) ─────────────
  const profile = await getProfile(userName).catch(() => null);

  const firstName    = profile?.name?.split(" ")[0] ?? "there";
  const primaryCity  = (profile?.city ?? "Dallas").trim();
  const primaryLat   = profile?.latitude  ?? 32.7767;
  const primaryLon   = profile?.longitude ?? -96.7970;
  const homeAddress  = profile?.homeAddress ??
    ((profile?.rawData as CollectedData | undefined)?.homeAddress as string | undefined) ?? "";
  const rawData      = (profile?.rawData ?? {}) as CollectedData;
  const people       = (rawData.people ?? []) as Array<{
    name?: string; relationship?: string; city?: string;
  }>;
  const interests    = (rawData.interests ?? []) as string[];
  const rawExtra     = rawData as unknown as Record<string, unknown>;
  const musicGenres  = ((rawExtra["musicPreferences"] ?? rawExtra["favoriteGenres"] ?? []) as string[]);
  const allInterests = [...new Set([...interests, ...musicGenres])].filter(Boolean).slice(0, 10);

  // Family cities (first 2, deduplicated against primary city)
  const familyCityEntries = people
    .filter((p) => p.city && p.city.trim().toLowerCase() !== primaryCity.toLowerCase())
    .slice(0, 2)
    .map((p) => ({ name: (p.name ?? "").trim(), city: (p.city ?? "").trim(), rel: p.relationship ?? "" }));

  // ── Step 2: Parallel data fetch (all independent) ────────────────────────
  const [
    fitResult,
    weatherResult,
    emailResult,
    ordersResult,
    stoicResult,
    tmEventResult,
    seenNewsResult,
    seenFgResult,
    todoResult,
    tripsResult,
    calResult,
    serpEventsResult,
    goodStoryFetchReady,  // placeholder — needs seenFg first
  ] = await Promise.allSettled([
    fetchYesterdayFitData(userName),
    getCachedWeather(primaryCity, primaryLat, primaryLon),
    fetchAndSummarizeEmails(10, undefined, userName),
    getOrdersForBriefing(userName),
    getStoicForUser(userName),
    fetchBestLocalEvent(primaryCity, allInterests, userName),
    getSeenHeadlines(userName, 3),
    getSeenFgStories(userName),
    getTodoCount(userName),
    getUpcomingTrips(userName),
    buildCalendarData(userName, homeAddress, primaryLat, primaryLon),
    fetchSerpApiEvents(primaryCity, allInterests),
    Promise.resolve(null),  // feel-good fetched below after seenFg is known
  ]);

  const fitData       = fitResult.status       === "fulfilled" ? fitResult.value       : null;
  const weather       = weatherResult.status   === "fulfilled" ? weatherResult.value   : null;
  const emails        = emailResult.status     === "fulfilled" ? emailResult.value      : null;
  const orders        = ordersResult.status    === "fulfilled" ? ordersResult.value     : [];
  const stoic         = stoicResult.status     === "fulfilled" ? stoicResult.value      : null;
  const tmEvent       = tmEventResult.status   === "fulfilled" ? tmEventResult.value    : null;
  const seenNews      = seenNewsResult.status  === "fulfilled" ? seenNewsResult.value   : new Set<string>();
  const seenFg        = seenFgResult.status    === "fulfilled" ? seenFgResult.value     : new Set<string>();
  const todoCount     = todoResult.status      === "fulfilled" ? todoResult.value       : 0;
  const upcomingTrips = tripsResult.status     === "fulfilled" ? tripsResult.value      : [];
  const calData       = calResult.status       === "fulfilled" ? calResult.value        : { events: [] };
  const serpEvents    = serpEventsResult.status === "fulfilled" ? serpEventsResult.value : [];

  // ── Step 3: Secondary parallel — feel-good story + family weather + news ──
  const [goodStoryResult, newsResult, ...familyWeatherResults] = await Promise.allSettled([
    fetchGoodStory(seenFg),
    // News: fresh fetch via web_search (handled in Claude call below)
    fetchNewsViaWebSearch(),
    // Family city weather
    ...familyCityEntries.map(async (fc) => {
      const coords = await geocodeCity(fc.city);
      if (!coords) return null;
      try {
        const w = await getCachedWeather(fc.city, coords.lat, coords.lon);
        return { ...fc, weather: w };
      } catch {
        return null;
      }
    }),
    // Trip destination weather
    ...upcomingTrips.slice(0, 2).map(async (trip) => {
      const coords = await geocodeCity(trip.destination);
      if (!coords) return null;
      try {
        const w = await getCachedWeather(trip.destination, coords.lat, coords.lon);
        return { city: trip.destination, startDate: trip.startDate, weather: w };
      } catch {
        return null;
      }
    }),
  ]);

  const goodStory   = goodStoryResult.status  === "fulfilled" ? goodStoryResult.value  : null;
  const rawNewsText = newsResult.status        === "fulfilled" ? newsResult.value       : "";
  const familyWeathers = familyWeatherResults
    .map((r) => r.status === "fulfilled" ? r.value : null)
    .filter(Boolean) as Array<{
      name?: string; rel?: string; city: string;
      weather?: { temp: number; condition: string };
      startDate?: string;
    }>;

  // ── Step 4: Build data blocks for Claude ──────────────────────────────────

  // SLEEP
  const sleepBlock = (() => {
    if (!fitData?.sleepMinutes) return "";
    const quality = sleepQuality(fitData.sleepMinutes);
    return `SLEEP: It looks like you slept ${quality} last night.`;
  })();

  // WEATHER
  const weatherBlock = (() => {
    if (!weather) return "";
    const lines: string[] = [
      `HOME: It's ${weather.temp}° and ${weather.condition} in ${primaryCity}.`,
    ];
    for (const fw of familyWeathers) {
      if (!fw.weather) continue;
      if (fw.startDate) {
        // Trip destination
        const dateLabel = new Date(fw.startDate + "T12:00:00").toLocaleDateString("en-US", {
          timeZone: "America/Chicago", month: "long", day: "numeric",
        });
        lines.push(`TRIP: In ${fw.city} where you're headed ${dateLabel}, it's ${fw.weather.temp}° and ${fw.weather.condition}.`);
      } else if (fw.name) {
        // Family city
        lines.push(`FAMILY: In ${fw.city} (${fw.name}), it's ${fw.weather.temp}° and ${fw.weather.condition}.`);
      }
    }
    return lines.join("\n");
  })();

  // CALENDAR
  const calBlock = (() => {
    if (calData.events.length === 0) return "CALENDAR: Nothing on your calendar today.";
    const lines = calData.events.map((e) => {
      const base = `${e.time}: ${e.title}`;
      return e.leaveBy ? `${base} — you'll want to leave by ${e.leaveBy}.` : base;
    });
    return `CALENDAR:\n${lines.join("\n")}`;
  })();

  // EMAIL
  const emailBlock = (() => {
    if (emails === null) return "";   // Google not connected — skip silently
    if (!emails.length) return "EMAIL: Nothing urgent in your inbox.";
    const actionable = filterActionableEmails(emails);
    if (!actionable.length) return "EMAIL: Nothing urgent in your inbox.";
    const count = actionable.length;
    const top = actionable[0]!;
    const desc = `${top.from}: ${top.subject}`;
    return count === 1
      ? `EMAIL: You have 1 email that needs attention — ${desc}.`
      : `EMAIL: You have ${count} emails that need attention — ${desc}${count > 1 ? ` and ${count - 1} other${count > 2 ? "s" : ""}` : ""}.`;
  })();

  // TO-DO
  const todoBlock = todoCount === 0
    ? "TODO: Your to-do list is clear."
    : `TODO: You have ${todoCount} item${todoCount !== 1 ? "s" : ""} on your to-do list. Want to review it before the day gets started?`;

  // DELIVERIES
  const deliveriesBlock = (() => {
    if (!orders.length) return "";
    const lines = orders.slice(0, 3).map((o) => {
      const label = o.item_name ?? o.retailer ?? "A package";
      return `${label} is expected to arrive today.`;
    });
    return `DELIVERIES:\n${lines.join("\n")}`;
  })();

  // NEWS (filtered: no tech/AI/niche)
  const newsBlock = rawNewsText.trim()
    ? `NEWS_RAW:\n${rawNewsText}`
    : "";

  // FEEL-GOOD
  const feelGoodBlock = goodStory
    ? `FEELGOOD: ${goodStory.title} (${goodStory.source})`
    : "";

  // LOCAL EVENTS (Ticketmaster + SerpAPI)
  const eventsBlock = (() => {
    const parts: string[] = [];
    if (tmEvent?.event) {
      parts.push(`• ${tmEvent.event.name} — ${tmEvent.event.date} at ${tmEvent.event.venue}`);
    }
    // SerpAPI events: pick 1-2 that aren't already covered by Ticketmaster
    const tmName = tmEvent?.event?.name?.toLowerCase() ?? "";
    const serpPicks = serpEvents
      .filter((e) => !tmName || !e.title.toLowerCase().includes(tmName.slice(0, 15)))
      .slice(0, 2);
    for (const e of serpPicks) {
      const venuePart = e.venue ? ` at ${e.venue}` : "";
      const datePart = e.date ? ` — ${e.date}` : "";
      parts.push(`• ${e.title}${datePart}${venuePart}`);
    }
    if (parts.length === 0) return "";
    return `LOCAL EVENTS:\n${parts.join("\n")}`;
  })();

  // STOIC
  const stoicBlock = (() => {
    if (!stoic) return "";
    const quoteEncoded = encodeURIComponent(`"${stoic.quote}" — ${stoic.author}`);
    const deepLink = `winston://myday?prefill=${quoteEncoded}`;
    return [
      `STOIC_QUOTE: "${stoic.quote}"`,
      `STOIC_AUTHOR: — ${stoic.author}, ${stoic.source}`,
      `STOIC_DEEPLINK: ${deepLink}`,
      `STOIC_SECTION_NAME: ${firstName}'s Life`,
    ].join("\n");
  })();

  // ── Step 5: Assemble the full Claude prompt ────────────────────────────────

  const now = new Date();
  const todayLabel = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const dataSections = [
    sleepBlock,
    weatherBlock,
    calBlock,
    emailBlock,
    todoBlock,
    deliveriesBlock,
    newsBlock,
    feelGoodBlock,
    eventsBlock,
    stoicBlock,
  ].filter(Boolean).join("\n\n");

  const systemPrompt = buildBriefingSystemPrompt(firstName, todayLabel);

  const userMessage = `Today is ${todayLabel}.\n\nDATA:\n${dataSections}`;

  // ── Step 6: Claude Haiku call ─────────────────────────────────────────────
  let briefingText = "";
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    briefingText = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
  } catch (err) {
    logger.error({ err }, "[FreshBriefing] Claude call failed");
    throw err;
  }

  // ── Step 7: Log headlines for dedup + increment stoic ─────────────────────
  const headlinesToLog: string[] = [];
  if (rawNewsText) {
    const matches = [...rawNewsText.matchAll(/\*\*([^*]{5,120})\*\*/g)];
    headlinesToLog.push(...matches.map((m) => m[1]!.trim()));
  }
  if (headlinesToLog.length) {
    logBriefingStories(userName, headlinesToLog).catch(() => {});
  }
  if (goodStory) {
    logFgStory(userName, goodStory.title).catch(() => {});
  }
  if (stoic) {
    incrementStoicDay(userName).catch((e) => logger.warn({ e }, "[FreshBriefing] Failed to increment stoic day"));
  }

  logger.info(
    { userName, chars: briefingText.length, elapsedMs: Date.now() - t0 },
    "[FreshBriefing] Generated successfully"
  );

  return briefingText;
}

// ── Filter actionable emails ──────────────────────────────────────────────────

const AUTOMATED_SENDERS = [
  "noreply", "no-reply", "notifications", "donotreply", "do-not-reply",
  "newsletter", "updates@", "alerts@", "mailer", "bounce",
  "newsletter@", "info@", "promo", "promotions",
];

function filterActionableEmails(emails: EmailSummary[]): EmailSummary[] {
  return emails.filter((e) => {
    const from = e.fromEmail?.toLowerCase() ?? e.from.toLowerCase();
    const subj = e.subject.toLowerCase();
    if (AUTOMATED_SENDERS.some((s) => from.includes(s))) return false;
    // Keep meeting invites, direct messages, replies needed
    const isActionable =
      subj.includes("invitation") ||
      subj.includes("invite") ||
      subj.includes("meeting") ||
      subj.includes("re:") ||
      subj.includes("fwd:") ||
      subj.includes("action required") ||
      subj.includes("urgent") ||
      subj.includes("important") ||
      // If subject doesn't look promotional, keep it
      (!subj.includes("sale") &&
       !subj.includes("% off") &&
       !subj.includes("deal") &&
       !subj.includes("subscribe") &&
       !subj.includes("unsubscribe") &&
       !subj.includes("offer"));
    return isActionable;
  });
}

// ── News via Claude web_search ────────────────────────────────────────────────

async function fetchNewsViaWebSearch(): Promise<string> {
  try {
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 500,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages: [{
        role: "user",
        content:
          `Today is ${today}. Search for the top 3-4 major news stories people will be talking about today. ` +
          `Focus ONLY on: politics, economy, sports, major world events. ` +
          `EXCLUDE completely: technology news, AI news, startup news, app releases, niche stories. ` +
          `Format: one story per line as "**Headline** — One sentence summary." No intro, no lists, just the lines.`,
      }],
    });
    return resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
  } catch (err) {
    logger.warn({ err }, "[FreshBriefing] News web_search failed");
    return "";
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildBriefingSystemPrompt(firstName: string, todayLabel: string): string {
  return `You are ${firstName}'s personal AI companion delivering the morning briefing for ${todayLabel}.

CORE PRINCIPLE: Facts only. No commentary, no filler phrases, no extra words. Clean, direct, conversational. Read naturally aloud in under 2 minutes.

DELIVERY RULES:
• Never open with "Certainly!", "Of course!", "Absolutely!", or "Great question!"
• Never start with "I" as the first word
• No padding sentences
• Each section flows naturally into the next — conversational, not robotic

EXACT SECTION ORDER — deliver in this order only:

1. GREETING
Say exactly: "Good morning, ${firstName}."
Nothing else on this line.

2. SLEEP (only if SLEEP data provided)
Use the exact quality word provided. Format: "It looks like you slept [quality] last night."
If no SLEEP data: skip entirely — no mention of sleep.

3. WEATHER
For HOME: "It's [temp]° and [condition] in [city]."
For FAMILY cities: "In [city] ([name]), it's [temp]° and [condition]."
For TRIP destinations: "In [destination] where you're headed [date], it's [temp]° and [condition]."
One sentence per location. Skip any location where weather is unavailable.

4. CALENDAR (from CALENDAR data)
If nothing: "Nothing on your calendar today."
If events exist: list time and title only. If a "leave by" time is provided, append: "You'll want to leave by [time]."

5. EMAIL (from EMAIL data)
Use the exact sentence provided. If EMAIL data says "Nothing urgent" — say that.

6. TO-DO (from TODO data)
Use the exact sentence provided.

7. DELIVERIES (only if DELIVERIES data provided)
Use the exact sentences provided.
If no DELIVERIES data: skip entirely — no mention of deliveries.

8. NEWS (from NEWS_RAW data)
Select the 3-4 most significant stories. EXCLUDE any tech, AI, startup, or niche stories.
Format each as one brief headline sentence. No tech. No AI. Major stories only.
If no NEWS_RAW data: skip silently.

9. FEEL-GOOD STORY (only if FEELGOOD data provided)
Deliver in exactly one sentence. No setup, no commentary.
If no FEELGOOD data: skip entirely.

10. LOCAL EVENTS (only if LOCAL EVENTS data provided)
Format: "Tonight at [venue]: [event name]." or "This weekend at [venue]: [event name]."
Maximum 2 events. Skip if no data.

11. STOIC CLOSING
Transition: "That's your morning. Here's something to carry with you today:"
Then deliver the quote word-for-word, attributed naturally.
Then say exactly: "You can reflect on this in ${firstName}'s Life." — this phrase must be spoken exactly as written (the app turns it into a deep link).

ABSOLUTE RULES:
• Never invent data. If a section has no data, skip it silently.
• Never mention technical failures or missing sources.
• Speak every number as words only if it reads better aloud (e.g. "two items" not "2 items" — but "87 degrees" is fine).
• Total spoken length: under 2 minutes.`;
}
