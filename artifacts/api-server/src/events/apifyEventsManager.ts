/**
 * Apify Events Manager
 *
 * Discovers local events via Ticketmaster. Two paths:
 *
 * 1. Ticketmaster Discovery API — direct REST call when TICKETMASTER_API_KEY is set.
 * 2. parseforge/ticketmaster-scraper — Apify actor fallback when no key is set.
 *    Input: startUrls pointing at the Dallas events listing page.
 *
 * NOTE: Eventbrite Apify actors (parseforge, powerai, crawlerbros, nexgendata)
 * were all tested 2026-05-13 and timed out or returned error items regardless of
 * input format. Eventbrite scraping is not usable via Apify. Ticketmaster only.
 *
 * Claude Haiku filters candidates to ONE event genuinely matching user interests.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getCachedApify, setCachedApify } from "../lib/apifyCache.js";

const anthropic = new Anthropic();

function getApifyKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }

// Validated 2026-05-13: 5 items in 16.6s, rich field set
const TICKETMASTER_ACTOR_ID = "parseforge/ticketmaster-scraper";

// ── Generic Apify runner ──────────────────────────────────────────────────────

async function runActor(
  actorId:    string,
  input:      Record<string, unknown>,
  timeoutSec  = 75,
): Promise<Array<Record<string, unknown>>> {
  const token = getApifyKey();
  if (!token) return [];

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}` +
    `/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSec}&memory=512`;

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(input),
      signal:  AbortSignal.timeout((timeoutSec + 10) * 1000),
    });
    if (!res.ok) {
      logger.warn({ actorId, status: res.status }, "[ApifyEvents] Actor run non-OK");
      return [];
    }
    const data = await res.json() as unknown;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  } catch (err) {
    logger.warn({ err, actorId }, "[ApifyEvents] Actor request threw");
    return [];
  }
}

// ── Shared event type ─────────────────────────────────────────────────────────

export interface LocalEvent {
  name:        string;
  date:        string;    // Human-readable: "Saturday, June 14"
  dateISO:     string;    // YYYY-MM-DD
  venue:       string;
  url:         string;
  description: string;
  source:      "ticketmaster";
}

export interface ApifyEventResult {
  event: LocalEvent | null;
  block: string;   // Ready-to-inject briefing block (empty if no event found)
}

// ── Ticketmaster Discovery API (primary when key is set) ──────────────────────

async function fetchTicketmasterDirect(city: string): Promise<LocalEvent[]> {
  const tmKey = process.env["TICKETMASTER_API_KEY"];
  if (!tmKey) return [];

  const now    = new Date();
  const endISO = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  try {
    const params = new URLSearchParams({
      apikey:        tmKey,
      city,
      radius:        "30",
      unit:          "miles",
      sort:          "date,asc",
      startDateTime: now.toISOString().replace(/\.\d+Z$/, "Z"),
      endDateTime:   `${endISO}T23:59:59Z`,
      size:          "20",
    });
    const res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];

    const data = await res.json() as {
      _embedded?: { events?: Array<Record<string, unknown>> };
    };
    const events = data._embedded?.events ?? [];

    return events.map((e): LocalEvent => {
      const dates   = (e["dates"] as Record<string, unknown> | undefined);
      const start   = (dates?.["start"] as Record<string, unknown> | undefined);
      const dateISO = String(start?.["localDate"] ?? "");
      let dateLabel = "";
      if (dateISO.length === 10) {
        try {
          dateLabel = new Date(`${dateISO}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric",
          });
        } catch { dateLabel = dateISO; }
      }
      const embedded = e["_embedded"] as Record<string, unknown> | undefined;
      const venues   = embedded?.["venues"] as Array<Record<string, unknown>> | undefined;
      const classif  = (e["classifications"] as Array<Record<string, unknown>> | undefined)?.[0];
      return {
        name:        String(e["name"] ?? ""),
        date:        dateLabel,
        dateISO,
        venue:       String(venues?.[0]?.["name"] ?? city),
        url:         String(e["url"] ?? ""),
        description: String((classif?.["segment"] as Record<string, unknown> | undefined)?.["name"] ?? ""),
        source:      "ticketmaster",
      };
    }).filter((e) => e.name.length > 3 && e.dateISO.length === 10);
  } catch (err) {
    logger.warn({ err }, "[ApifyEvents] Ticketmaster direct API threw");
    return [];
  }
}

// ── Ticketmaster via Apify actor (fallback) ───────────────────────────────────
//
// parseforge/ticketmaster-scraper validated fields (2026-05-13):
//   name, url, startDate, date, venue, city, state, segment, genre,
//   latitude, longitude, priceMin, priceMax, ticketingStatus, ...
//
// Input: startUrls pointing at the city events listing sorted by date ascending.

async function fetchTicketmasterViaApify(city: string): Promise<LocalEvent[]> {
  if (!getApifyKey()) return [];

  const citySlug = city.toLowerCase().replace(/\s+/g, "-");
  const items = await runActor(TICKETMASTER_ACTOR_ID, {
    startUrls: [
      { url: `https://www.ticketmaster.com/${citySlug}-tickets-4/city/${citySlug}` },
    ],
    maxItems: 25,
  }, 75);

  logger.info({ count: items.length }, "[ApifyEvents] Ticketmaster Apify actor returned");

  return items
    .map((item): LocalEvent => {
      // startDate: "2026-09-14T00:20:00Z" or date: "Sep 14, 2026"
      const rawDate = String(item["startDate"] ?? item["date"] ?? "");
      let dateISO   = "";
      let dateLabel = "";

      // Try ISO format first (startDate)
      if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        dateISO = rawDate.slice(0, 10);
      } else if (rawDate) {
        // Fallback: parse human date
        try {
          const parsed = new Date(rawDate);
          if (!isNaN(parsed.getTime())) dateISO = parsed.toISOString().slice(0, 10);
        } catch { /* skip */ }
      }

      if (dateISO.length === 10) {
        try {
          dateLabel = new Date(`${dateISO}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric",
          });
        } catch { dateLabel = dateISO; }
      }

      return {
        name:        String(item["name"]  ?? ""),
        date:        dateLabel,
        dateISO,
        venue:       String(item["venue"] ?? item["venueName"] ?? city),
        url:         String(item["url"]   ?? ""),
        description: String(item["segment"] ?? item["genre"] ?? item["category"] ?? ""),
        source:      "ticketmaster",
      };
    })
    .filter((e) => e.name.length > 3);
}

// ── Claude interest filter ────────────────────────────────────────────────────

async function selectBestEvent(
  events:    LocalEvent[],
  interests: string[],
  city:      string,
): Promise<LocalEvent | null> {
  if (events.length === 0) return null;

  const now       = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const upcoming = events.filter((e) => {
    if (!e.dateISO || e.dateISO.length !== 10) return false;
    const d = new Date(`${e.dateISO}T12:00:00`);
    return d >= now && d <= sevenDays;
  });

  if (upcoming.length === 0) {
    logger.info({ city, totalEvents: events.length }, "[ApifyEvents] No events within next 7 days");
    return null;
  }
  if (upcoming.length === 1) return upcoming[0]!;

  const interestStr = interests.slice(0, 10).join(", ") || "music, arts, culture";
  const list = upcoming.slice(0, 15).map((e, i) =>
    `${i + 1}. "${e.name}" — ${e.date || e.dateISO} at ${e.venue}${e.description ? ` [${e.description}]` : ""}`
  ).join("\n");

  const prompt =
    `User interests: ${interestStr}.\n\n` +
    `Upcoming events in ${city} this week:\n${list}\n\n` +
    `Which ONE event number is most genuinely relevant to someone with these specific interests? ` +
    `Be selective — a music fan wouldn't care about a sporting event unless they specifically follow that team. ` +
    `Only pick an event that clearly aligns with the stated interests. ` +
    `Reply with just the number. If none are a genuine match, reply with 0.`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages:   [{ role: "user", content: prompt }],
    });
    const numStr = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
    const num = parseInt(numStr, 10);
    if (num >= 1 && num <= upcoming.length) return upcoming[num - 1]!;
    return null;
  } catch {
    return upcoming[0]!;
  }
}

// ── In-memory + DB cache ──────────────────────────────────────────────────────

interface EventCache {
  result:    ApifyEventResult;
  fetchedAt: number;
  city:      string;
}
const _cache = new Map<string, EventCache>();
// Use 24-hour TTL — events don't change minute-to-minute; this avoids running
// the Ticketmaster actor more than once per day per user.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch one relevant local event in the next 7 days that matches user interests.
 * Prioritises the Ticketmaster Discovery API; falls back to Apify actor.
 * Returns a ready-to-inject briefing block (empty string if nothing relevant found).
 */
export async function fetchBestLocalEvent(
  city:      string,
  interests: string[],
  userName?: string,
): Promise<ApifyEventResult> {
  // Cache is keyed by CITY (not by userName) so all users in the same city share
  // one Ticketmaster actor run per day — prevents N actor runs for N users.
  const cacheKey   = city;
  const dbCacheKey = `events:city:${city}`;

  // 1. In-memory cache (fastest)
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.city === city) {
    logger.info({ city }, "[ApifyEvents] Serving from in-memory cache (city-shared)");
    return cached.result;
  }

  // 2. DB cache — survives restarts, prevents repeated Ticketmaster actor runs
  const dbCached = await getCachedApify(dbCacheKey, CACHE_TTL_MS);
  if (dbCached) {
    try {
      const result = JSON.parse(dbCached) as ApifyEventResult;
      logger.info({ city }, "[ApifyEvents] Serving from DB cache (city-shared) — skipping Apify");
      _cache.set(cacheKey, { result, fetchedAt: Date.now(), city });
      return result;
    } catch {
      // Invalid JSON — fall through to fresh fetch
    }
  }

  const hasTmKey   = !!process.env["TICKETMASTER_API_KEY"];
  const hasApifyKey = !!getApifyKey();
  if (!hasTmKey && !hasApifyKey) {
    logger.info("[ApifyEvents] No API keys configured — skipping event discovery");
    return { event: null, block: "" };
  }

  try {
    // Try direct API first (fast, no Apify credit cost); fall back to scraper
    let events: LocalEvent[] = await fetchTicketmasterDirect(city);

    if (events.length === 0 && hasApifyKey) {
      logger.info({ city }, "[ApifyEvents] Direct API returned nothing — trying Apify actor");
      events = await fetchTicketmasterViaApify(city);
    }

    logger.info({ city, total: events.length }, "[ApifyEvents] Total candidate events");

    const best = await selectBestEvent(events, interests, city);

    let result: ApifyEventResult;
    if (!best) {
      result = { event: null, block: "" };
    } else {
      const urlLine = best.url ? `\n  Tickets/info: ${best.url}` : "";
      const block =
        `\n\n[VERIFIED — Local Event Discovery — Ticketmaster]\n` +
        `One upcoming ${city} event that may interest you:\n` +
        `• ${best.name} — ${best.date || best.dateISO} at ${best.venue}${urlLine}\n` +
        `INSTRUCTION: Mention this event in ONE sentence — name, date, venue. ` +
        `Only include if it fits the briefing flow naturally; skip silently if forced.`;
      result = { event: best, block };
      logger.info({ city, event: best.name, date: best.dateISO }, "[ApifyEvents] Best event selected");
    }

    _cache.set(cacheKey, { result, fetchedAt: Date.now(), city });
    // Persist to DB (city-keyed) so all users share one result and restarts don't re-run
    setCachedApify(dbCacheKey, JSON.stringify(result)).catch(() => {});
    return result;
  } catch (err) {
    logger.warn({ err, city }, "[ApifyEvents] fetchBestLocalEvent threw");
    return { event: null, block: "" };
  }
}
