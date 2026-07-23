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
 * Returns raw candidate events — ranking against a specific user's interests
 * happens in proactiveEventScheduler.ts, alongside candidates from other
 * discovery sources.
 */

import { logger } from "../lib/logger.js";
import { getCachedApify, setCachedApify, claimActorRun } from "../lib/apifyCache.js";

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
  name:           string;
  date:           string;    // Human-readable: "Saturday, June 14"
  dateISO:        string;    // YYYY-MM-DD
  venue:          string;
  url:            string;
  description:    string;
  source:         "ticketmaster";
  ticketSaleDate: string | null; // Public on-sale date (ISO), if known
}

// ── Ticketmaster Discovery API (primary when key is set) ──────────────────────

function parseTmEvents(events: Array<Record<string, unknown>>, city: string): LocalEvent[] {
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
    const sales    = (e["sales"] as Record<string, unknown> | undefined);
    const salesPublic = (sales?.["public"] as Record<string, unknown> | undefined);
    const ticketSaleDate = salesPublic?.["startDateTime"] ? String(salesPublic["startDateTime"]).slice(0, 10) : null;
    return {
      name:        String(e["name"] ?? ""),
      date:        dateLabel,
      dateISO,
      venue:       String(venues?.[0]?.["name"] ?? city),
      url:         String(e["url"] ?? ""),
      description: String((classif?.["segment"] as Record<string, unknown> | undefined)?.["name"] ?? ""),
      source:      "ticketmaster",
      ticketSaleDate,
    };
  }).filter((e) => e.name.length > 3 && e.dateISO.length === 10);
}

async function tmSearch(
  params: Record<string, string>,
  label: string,
): Promise<Array<Record<string, unknown>>> {
  const tmKey = process.env["TICKETMASTER_API_KEY"];
  if (!tmKey) return [];
  try {
    const qs = new URLSearchParams({ apikey: tmKey, ...params });
    const res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${qs}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      logger.warn({ label, status: res.status }, "[ApifyEvents] TM search non-OK");
      return [];
    }
    const data = await res.json() as { _embedded?: { events?: Array<Record<string, unknown>> } };
    return data._embedded?.events ?? [];
  } catch (err) {
    logger.warn({ err, label }, "[ApifyEvents] TM search threw");
    return [];
  }
}

async function fetchTicketmasterDirect(city: string, artists: string[]): Promise<LocalEvent[]> {
  const tmKey = process.env["TICKETMASTER_API_KEY"];
  if (!tmKey) return [];

  const now    = new Date();
  const endISO = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
  const shared: Record<string, string> = {
    city,
    radius:        "30",
    unit:          "miles",
    sort:          "date,asc",
    startDateTime: now.toISOString().replace(/\.\d+Z$/, "Z"),
    endDateTime:   `${endISO}T23:59:59Z`,
  };

  // Run general city search + one keyword search per artist (up to 3) in parallel
  const artistsToSearch = artists.slice(0, 3);
  const searches = [
    tmSearch({ ...shared, size: "20" }, "city"),
    ...artistsToSearch.map((artist) =>
      tmSearch({ ...shared, keyword: artist, size: "5" }, `artist:${artist}`)
    ),
  ];

  const results = await Promise.all(searches);
  const allRaw  = results.flat();

  // Deduplicate by event id (prefer first occurrence which may be artist-specific)
  const seen  = new Set<string>();
  const dedup = allRaw.filter((e) => {
    const id = String(e["id"] ?? e["name"] ?? "");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const parsed = parseTmEvents(dedup, city);
  logger.info(
    { city, artists: artistsToSearch, total: parsed.length },
    "[ApifyEvents] TM direct: combined city + artist results",
  );
  return parsed;
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

  // Hard 23 h DB lock — prevents repeated actor runs from concurrent callers or restarts
  const lockKey = `events:ticketmaster:${city.toLowerCase().replace(/\s+/g, "-")}`;
  const allowed = await claimActorRun(lockKey, ACTOR_LOCK_TTL_MS);
  if (!allowed) {
    logger.info({ city }, "[ApifyEvents] Ticketmaster actor blocked by 23 h DB lock — returning empty");
    return [];
  }

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
        // Not in this actor's documented field set — always null for the Apify fallback path.
        ticketSaleDate: null,
      };
    })
    .filter((e) => e.name.length > 3);
}

// ── In-memory + DB cache ──────────────────────────────────────────────────────

interface EventCache {
  events:    LocalEvent[];
  fetchedAt: number;
  city:      string;
}
const _cache = new Map<string, EventCache>();
// Use 24-hour TTL — events don't change minute-to-minute; this avoids running
// the Ticketmaster actor more than once per day per user.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACTOR_LOCK_TTL_MS = 23 * 60 * 60 * 1000; // hard 23 h DB lock per city

// In-flight dedup — prevents concurrent callers for the same city from each
// spawning their own Apify actor run before any of them writes the result back.
const _fetchInFlight = new Map<string, Promise<LocalEvent[]>>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch candidate events in the next 14 days for a city. Prioritises the
 * Ticketmaster Discovery API (runs parallel artist keyword searches); falls
 * back to the Apify scraper actor. Returns the raw filtered candidate list —
 * ranking/personalization against a specific user's profile is the caller's
 * job (proactiveEventScheduler.ts combines this with other candidate
 * sources and ranks them together in one pass).
 *
 * Cache key includes artists so different users with different favourite
 * artists each get their own candidate set (artist keyword searches differ)
 * while still sharing the expensive Apify actor run (locked city-wide for 23 h).
 */
export async function fetchCandidateEvents(
  city:    string,
  artists: string[] = [],
): Promise<LocalEvent[]> {
  // Cache key = city + sorted artist list so per-user artist prefs get their own
  // cached result without re-running the expensive Apify actor.
  const artistKey  = artists.slice(0, 5).sort().join("|");
  const cacheKey   = artistKey ? `${city}:${artistKey}` : city;
  const dbCacheKey = artistKey ? `events:city:${city}:${artistKey}` : `events:city:${city}`;

  // 1. In-memory cache (fastest)
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.city === city) {
    logger.info({ city }, "[ApifyEvents] Serving from in-memory cache (city-shared)");
    return cached.events;
  }

  // 2. DB cache — survives restarts, prevents repeated Ticketmaster actor runs
  const dbCached = await getCachedApify(dbCacheKey, CACHE_TTL_MS);
  if (dbCached) {
    try {
      const events = JSON.parse(dbCached) as LocalEvent[];
      logger.info({ city }, "[ApifyEvents] Serving from DB cache (city-shared) — skipping Apify");
      _cache.set(cacheKey, { events, fetchedAt: Date.now(), city });
      return events;
    } catch {
      // Invalid JSON — fall through to fresh fetch
    }
  }

  const hasTmKey   = !!process.env["TICKETMASTER_API_KEY"];
  const hasApifyKey = !!getApifyKey();
  if (!hasTmKey && !hasApifyKey) {
    logger.info("[ApifyEvents] No API keys configured — skipping event discovery");
    return [];
  }

  // In-flight dedup — all concurrent callers for the same city share one fetch promise.
  // This prevents the race where N callers all see a DB cache miss simultaneously and
  // each fire the Apify actor before any of them has written the result back.
  const existingFlight = _fetchInFlight.get(cacheKey);
  if (existingFlight) {
    logger.info({ city }, "[ApifyEvents] fetchCandidateEvents already in flight — deduplicating");
    return existingFlight;
  }

  const fetchPromise = (async (): Promise<LocalEvent[]> => {
    try {
      // Try direct API first (fast, no Apify credit cost); fall back to scraper
      let events: LocalEvent[] = await fetchTicketmasterDirect(city, artists);

      if (events.length === 0 && hasApifyKey) {
        logger.info({ city }, "[ApifyEvents] Direct API returned nothing — trying Apify actor");
        events = await fetchTicketmasterViaApify(city);
      }

      // Filter to the next 14 days — same window the old single-pick selection used.
      const now = new Date();
      const fourteenDays = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const upcoming = events.filter((e) => {
        if (!e.dateISO || e.dateISO.length !== 10) return false;
        const d = new Date(`${e.dateISO}T12:00:00`);
        return d >= now && d <= fourteenDays;
      });

      logger.info({ city, total: events.length, upcoming: upcoming.length }, "[ApifyEvents] Candidate events fetched");

      _cache.set(cacheKey, { events: upcoming, fetchedAt: Date.now(), city });
      // Persist to DB (city-keyed) so all users share one result and restarts don't re-run
      setCachedApify(dbCacheKey, JSON.stringify(upcoming)).catch(() => {});
      return upcoming;
    } catch (err) {
      logger.warn({ err, city }, "[ApifyEvents] fetchCandidateEvents threw");
      return [];
    } finally {
      _fetchInFlight.delete(cacheKey);
    }
  })();

  _fetchInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}
