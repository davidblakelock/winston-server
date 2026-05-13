/**
 * Apify Events Manager
 *
 * Discovers local events via Eventbrite (Apify actor) and the Ticketmaster
 * Discovery API (direct, with Apify actor fallback). Filters candidates by
 * the user's interests via Claude Haiku and surfaces ONE genuinely relevant
 * event happening in the next 7 days for the morning briefing.
 *
 * Apify actors used:
 *   Eventbrite:    apify/eventbrite-scraper
 *   Ticketmaster:  lhotanova/ticketmaster-scraper  (fallback when no TM key)
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();

function getApifyKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }

const EVENTBRITE_ACTOR_ID   = "apify/eventbrite-scraper";
const TICKETMASTER_ACTOR_ID = "lhotanova/ticketmaster-scraper";

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
      signal:  AbortSignal.timeout((timeoutSec + 8) * 1000),
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
  source:      "eventbrite" | "ticketmaster";
}

export interface ApifyEventResult {
  event: LocalEvent | null;
  block: string;   // Ready-to-inject briefing block (empty if no event found)
}

// ── Eventbrite ────────────────────────────────────────────────────────────────

async function fetchEventbriteEvents(
  city:      string,
  interests: string[],
): Promise<LocalEvent[]> {
  const query = interests.slice(0, 4).join(" ") || "arts music culture festival";
  const todayISO = new Date().toISOString().split("T")[0]!;
  const endISO   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  const items = await runActor(EVENTBRITE_ACTOR_ID, {
    location:  city,
    query,
    maxItems:  25,
    startDate: todayISO,
    endDate:   endISO,
  });

  return items
    .map((item): LocalEvent => {
      const rawDate = String(item["startDate"] ?? item["start_date"] ?? item["date"] ?? "");
      const dateISO = rawDate.slice(0, 10);
      let dateLabel = "";
      if (dateISO.length === 10) {
        try {
          dateLabel = new Date(`${dateISO}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric",
          });
        } catch { dateLabel = dateISO; }
      }
      return {
        name:        String(item["name"]        ?? item["title"]    ?? ""),
        date:        dateLabel,
        dateISO,
        venue:       String(item["venue"]        ?? item["venueName"] ?? item["location"] ?? city),
        url:         String(item["url"]          ?? item["eventUrl"] ?? ""),
        description: String(item["description"]  ?? item["shortDescription"] ?? ""),
        source:      "eventbrite",
      };
    })
    .filter((e) => e.name.length > 3 && e.dateISO.length === 10);
}

// ── Ticketmaster ──────────────────────────────────────────────────────────────

async function fetchTicketmasterEvents(city: string): Promise<LocalEvent[]> {
  const now    = new Date();
  const endISO = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

  // Prefer the direct Ticketmaster Discovery API when a key is set
  const tmKey = process.env["TICKETMASTER_API_KEY"];
  if (tmKey) {
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
      if (res.ok) {
        const data = await res.json() as {
          _embedded?: { events?: Array<Record<string, unknown>> };
        };
        const events = data._embedded?.events ?? [];
        const mapped: LocalEvent[] = events.map((e) => {
          const dates     = (e["dates"] as Record<string, unknown> | undefined);
          const start     = (dates?.["start"] as Record<string, unknown> | undefined);
          const dateISO   = String(start?.["localDate"] ?? "");
          let dateLabel   = "";
          if (dateISO.length === 10) {
            try {
              dateLabel = new Date(`${dateISO}T12:00:00`).toLocaleDateString("en-US", {
                weekday: "long", month: "long", day: "numeric",
              });
            } catch { dateLabel = dateISO; }
          }
          const embedded  = e["_embedded"] as Record<string, unknown> | undefined;
          const venues    = embedded?.["venues"] as Array<Record<string, unknown>> | undefined;
          const classif   = (e["classifications"] as Array<Record<string, unknown>> | undefined)?.[0];
          return {
            name:        String(e["name"] ?? ""),
            date:        dateLabel,
            dateISO,
            venue:       String(venues?.[0]?.["name"] ?? city),
            url:         String(e["url"] ?? ""),
            description: String((classif?.["segment"] as Record<string, unknown> | undefined)?.["name"] ?? ""),
            source:      "ticketmaster" as const,
          };
        }).filter((e) => e.name.length > 3 && e.dateISO.length === 10);
        logger.info({ count: mapped.length, source: "tm-direct" }, "[ApifyEvents] Ticketmaster direct API fetched");
        return mapped;
      }
    } catch (err) {
      logger.warn({ err }, "[ApifyEvents] Ticketmaster direct API threw — trying Apify actor");
    }
  }

  // Fallback: Apify Ticketmaster actor
  const items = await runActor(TICKETMASTER_ACTOR_ID, {
    city,
    maxItems:  20,
    startDate: now.toISOString().split("T")[0]!,
    endDate:   endISO,
  });
  const mapped: LocalEvent[] = items.map((item) => {
    const rawDate = String(item["date"] ?? item["startDate"] ?? item["localDate"] ?? "");
    const dateISO = rawDate.slice(0, 10);
    let dateLabel = "";
    if (dateISO.length === 10) {
      try {
        dateLabel = new Date(`${dateISO}T12:00:00`).toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric",
        });
      } catch { dateLabel = dateISO; }
    }
    return {
      name:        String(item["name"]  ?? item["title"]    ?? ""),
      date:        dateLabel,
      dateISO,
      venue:       String(item["venue"] ?? item["venueName"] ?? city),
      url:         String(item["url"]   ?? ""),
      description: String(item["description"] ?? item["genre"] ?? ""),
      source:      "ticketmaster" as const,
    };
  }).filter((e) => e.name.length > 3 && e.dateISO.length === 10);

  logger.info({ count: mapped.length, source: "apify-actor" }, "[ApifyEvents] Ticketmaster via Apify fetched");
  return mapped;
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

  // Restrict to events in the next 7 days
  const upcoming = events.filter((e) => {
    if (!e.dateISO || e.dateISO.length !== 10) return false;
    const d = new Date(`${e.dateISO}T12:00:00`);
    return d >= now && d <= sevenDays;
  });

  if (upcoming.length === 0) return null;
  if (upcoming.length === 1) return upcoming[0]!;

  const interestStr = interests.slice(0, 10).join(", ") || "music, arts, culture";
  const list = upcoming.slice(0, 15).map((e, i) =>
    `${i + 1}. "${e.name}" — ${e.date || e.dateISO} at ${e.venue} [${e.source}]${e.description ? `. ${e.description.slice(0, 80)}` : ""}`
  ).join("\n");

  const prompt =
    `User interests: ${interestStr}.\n\n` +
    `Upcoming events in ${city} this week:\n${list}\n\n` +
    `Which ONE event number is most genuinely relevant to someone with these specific interests? ` +
    `A music fan wouldn't care about a corporate conference. A woodworking enthusiast wouldn't care about a tech meetup. ` +
    `Be selective — only pick an event that clearly aligns. Reply with just the number. ` +
    `If none are a genuine match, reply with 0.`;

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
    if (num >= 1 && num <= upcoming.length) {
      return upcoming[num - 1]!;
    }
    return null;
  } catch {
    // Fall back to first result if Claude call fails
    return upcoming[0]!;
  }
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface EventCache {
  result:    ApifyEventResult;
  fetchedAt: number;
  city:      string;
}
const _cache = new Map<string, EventCache>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch one relevant local event in the next 7 days that matches user interests.
 * Combines Eventbrite and Ticketmaster, selects the best match via Claude Haiku.
 * Returns a ready-to-inject briefing block (empty string if nothing relevant found).
 */
export async function fetchBestLocalEvent(
  city:      string,
  interests: string[],
  userName?: string,
): Promise<ApifyEventResult> {
  const cacheKey = userName ?? city;
  const cached   = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.city === city) {
    logger.info({ city, cacheKey }, "[ApifyEvents] Serving from cache");
    return cached.result;
  }

  // Require at least Apify key OR Ticketmaster key
  if (!getApifyKey() && !process.env["TICKETMASTER_API_KEY"]) {
    logger.info("[ApifyEvents] No API keys — skipping event discovery");
    return { event: null, block: "" };
  }

  try {
    // Run both scrapers concurrently — graceful degradation if one fails
    const [ebResult, tmResult] = await Promise.allSettled([
      fetchEventbriteEvents(city, interests),
      fetchTicketmasterEvents(city),
    ]);

    const all: LocalEvent[] = [
      ...(ebResult.status === "fulfilled" ? ebResult.value : []),
      ...(tmResult.status === "fulfilled" ? tmResult.value : []),
    ];

    logger.info({ city, total: all.length }, "[ApifyEvents] Combined candidate events");

    const best = await selectBestEvent(all, interests, city);

    let result: ApifyEventResult;
    if (!best) {
      result = { event: null, block: "" };
    } else {
      const urlLine = best.url ? `\n  Tickets/info: ${best.url}` : "";
      const block =
        `\n\n[VERIFIED — Local Event Discovery — Eventbrite/Ticketmaster]\n` +
        `One upcoming ${city} event that may interest you:\n` +
        `• ${best.name} — ${best.date || best.dateISO} at ${best.venue}${urlLine}\n` +
        `INSTRUCTION: Mention this event naturally in ONE sentence — name, date, venue. ` +
        `Only include if it fits the briefing flow; skip silently if it feels forced.`;
      result = { event: best, block };
      logger.info({ city, event: best.name, date: best.dateISO }, "[ApifyEvents] Best event selected");
    }

    _cache.set(cacheKey, { result, fetchedAt: Date.now(), city });
    return result;
  } catch (err) {
    logger.warn({ err, city }, "[ApifyEvents] fetchBestLocalEvent threw");
    return { event: null, block: "" };
  }
}
