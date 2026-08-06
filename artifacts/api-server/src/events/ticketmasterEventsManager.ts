/**
 * Ticketmaster Events Manager
 *
 * Discovers local events via the Ticketmaster Discovery API (direct REST
 * call, TICKETMASTER_API_KEY). Returns raw candidate events — ranking
 * against a specific user's interests happens in proactiveEventScheduler.ts,
 * alongside candidates from other discovery sources.
 */

import { logger } from "../lib/logger.js";
import { getCachedResult, setCachedResult } from "../lib/resultCache.js";

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

// ── Ticketmaster Discovery API ──────────────────────────────────────────────

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
      logger.warn({ label, status: res.status }, "[TmEvents] TM search non-OK");
      return [];
    }
    const data = await res.json() as { _embedded?: { events?: Array<Record<string, unknown>> } };
    return data._embedded?.events ?? [];
  } catch (err) {
    logger.warn({ err, label }, "[TmEvents] TM search threw");
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
    "[TmEvents] TM direct: combined city + artist results",
  );
  return parsed;
}

// ── In-memory + DB cache ──────────────────────────────────────────────────────

interface EventCache {
  events:    LocalEvent[];
  fetchedAt: number;
  city:      string;
}
const _cache = new Map<string, EventCache>();
// Use 24-hour TTL — events don't change minute-to-minute; this avoids hitting
// the Ticketmaster API more than once per day per user.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-flight dedup — prevents concurrent callers for the same city from each
// firing their own Ticketmaster request before any of them writes the result back.
const _fetchInFlight = new Map<string, Promise<LocalEvent[]>>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch candidate events in the next 14 days for a city via the Ticketmaster
 * Discovery API (runs parallel artist keyword searches). Returns the raw
 * filtered candidate list — ranking/personalization against a specific
 * user's profile is the caller's job (proactiveEventScheduler.ts combines
 * this with other candidate sources and ranks them together in one pass).
 *
 * Cache key includes artists so different users with different favourite
 * artists each get their own candidate set (artist keyword searches differ)
 * while still sharing the underlying Ticketmaster request per city.
 */
export async function fetchCandidateEvents(
  city:    string,
  artists: string[] = [],
): Promise<LocalEvent[]> {
  // Cache key = city + sorted artist list so per-user artist prefs get their own
  // cached result without re-hitting Ticketmaster for the same city.
  const artistKey  = artists.slice(0, 5).sort().join("|");
  const cacheKey   = artistKey ? `${city}:${artistKey}` : city;
  const dbCacheKey = artistKey ? `events:city:${city}:${artistKey}` : `events:city:${city}`;

  // 1. In-memory cache (fastest)
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.city === city) {
    logger.info({ city }, "[TmEvents] Serving from in-memory cache (city-shared)");
    return cached.events;
  }

  // 2. DB cache — survives restarts, prevents repeated Ticketmaster requests
  const dbCached = await getCachedResult(dbCacheKey, CACHE_TTL_MS);
  if (dbCached) {
    try {
      const events = JSON.parse(dbCached) as LocalEvent[];
      logger.info({ city }, "[TmEvents] Serving from DB cache (city-shared)");
      _cache.set(cacheKey, { events, fetchedAt: Date.now(), city });
      return events;
    } catch {
      // Invalid JSON — fall through to fresh fetch
    }
  }

  if (!process.env["TICKETMASTER_API_KEY"]) {
    logger.info("[TmEvents] No API key configured — skipping event discovery");
    return [];
  }

  // In-flight dedup — all concurrent callers for the same city share one fetch promise.
  const existingFlight = _fetchInFlight.get(cacheKey);
  if (existingFlight) {
    logger.info({ city }, "[TmEvents] fetchCandidateEvents already in flight — deduplicating");
    return existingFlight;
  }

  const fetchPromise = (async (): Promise<LocalEvent[]> => {
    try {
      const events = await fetchTicketmasterDirect(city, artists);

      // Filter to the next 14 days — same window the old single-pick selection used.
      const now = new Date();
      const fourteenDays = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const upcoming = events.filter((e) => {
        if (!e.dateISO || e.dateISO.length !== 10) return false;
        const d = new Date(`${e.dateISO}T12:00:00`);
        return d >= now && d <= fourteenDays;
      });

      logger.info({ city, total: events.length, upcoming: upcoming.length }, "[TmEvents] Candidate events fetched");

      _cache.set(cacheKey, { events: upcoming, fetchedAt: Date.now(), city });
      // Persist to DB (city-keyed) so all users share one result and restarts don't re-fetch
      setCachedResult(dbCacheKey, JSON.stringify(upcoming)).catch(() => {});
      return upcoming;
    } catch (err) {
      logger.warn({ err, city }, "[TmEvents] fetchCandidateEvents threw");
      return [];
    } finally {
      _fetchInFlight.delete(cacheKey);
    }
  })();

  _fetchInFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}
