/**
 * Dallas music venue monitor — scans David's favorite venues for upcoming
 * concerts and music events that match his taste, stores matches in
 * concerts_of_interest, and surfaces them in the morning briefing.
 *
 * Venue list: Kessler Theater, Granada Theater, Dos Equis Pavilion,
 * AT&T Performing Arts Center, Klyde Warren Park, Dallas Arboretum
 * (Music Under the Stars), Jazz at the Meyerson.
 *
 * Music interests: classic rock 60s/70s, classic jazz, Jimmy Buffett,
 * Bonnie Raitt, Jackson Browne, Rolling Stones, Gordon Lightfoot, Van Morrison.
 */

import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();
const TZ = "America/Chicago";
const USER = "David";

// ── David's music interests ───────────────────────────────────────────────────

const ARTIST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /jimmy buffett|margaritaville/i,                 label: "Jimmy Buffett" },
  { pattern: /bonnie raitt/i,                                 label: "Bonnie Raitt" },
  { pattern: /jackson browne/i,                               label: "Jackson Browne" },
  { pattern: /rolling stones|stones tribute/i,                label: "Rolling Stones" },
  { pattern: /gordon lightfoot/i,                             label: "Gordon Lightfoot" },
  { pattern: /van morrison/i,                                 label: "Van Morrison" },
];

const GENRE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /jazz|bebop|big band|blues/i,                    label: "jazz/blues" },
  { pattern: /classic rock|60s|70s|sixties|seventies/i,       label: "classic rock" },
  { pattern: /tribute|tribute band/i,                         label: "tribute act" },
  { pattern: /outdoor concert|amphitheater|music under the stars|summer concert|concert series/i, label: "outdoor/series" },
  { pattern: /acoustic|singer.songwriter/i,                   label: "acoustic/singer-songwriter" },
];

function scoreConcert(text: string): { matched: boolean; score: number; matchedLabels: string[] } {
  const labels: string[] = [];
  let score = 0;

  for (const { pattern, label } of ARTIST_PATTERNS) {
    if (pattern.test(text)) { labels.push(label); score += 10; }
  }
  for (const { pattern, label } of GENRE_PATTERNS) {
    if (pattern.test(text)) { labels.push(label); score += 5; }
  }

  return { matched: score > 0, score, matchedLabels: labels };
}

// ── Venue definitions ─────────────────────────────────────────────────────────

interface VenueConfig {
  name: string;
  searchQuery: string;
  websiteUrl?: string;
}

const DAVID_VENUES: VenueConfig[] = [
  { name: "Kessler Theater",               searchQuery: "Kessler Theater Dallas upcoming events concerts schedule",    websiteUrl: "https://www.kesslertheatre.com/events" },
  { name: "Granada Theater",               searchQuery: "Granada Theater Dallas concerts schedule upcoming events",    websiteUrl: "https://www.granadatheater.com/events" },
  { name: "Dos Equis Pavilion",            searchQuery: "Dos Equis Pavilion Dallas concerts 2025 upcoming schedule" },
  { name: "AT&T Performing Arts Center",   searchQuery: "AT&T Performing Arts Center Dallas upcoming shows concerts" },
  { name: "Klyde Warren Park",             searchQuery: "Klyde Warren Park Dallas events concerts music" },
  { name: "Dallas Arboretum",              searchQuery: "Dallas Arboretum Music Under the Stars schedule concerts",    websiteUrl: "https://www.dallasarboretum.org/events" },
  { name: "Jazz at the Meyerson",          searchQuery: "Meyerson Symphony Center Dallas jazz concerts upcoming" },
];

// ── DB: concerts_of_interest table ───────────────────────────────────────────

/** Returns the list of favorite venue names (for use in local-content preference scoring) */
export function getFavoriteVenueNames(): string[] {
  return DAVID_VENUES.map((v) => v.name);
}

export interface ConcertItem {
  venue: string;
  artistOrEvent: string;
  eventDateText: string;   // natural-language date string from web search
  eventDate: Date | null;  // parsed if possible
  url: string;
  source: string;
  score: number;
  matchedLabels: string[];
}

export async function initConcertsTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS concerts_of_interest (
        id              SERIAL PRIMARY KEY,
        venue           TEXT NOT NULL,
        artist_or_event TEXT NOT NULL,
        event_date_text TEXT,
        event_date      DATE,
        event_url       TEXT,
        source          TEXT,
        score           INTEGER DEFAULT 0,
        notified        BOOLEAN DEFAULT FALSE,
        first_seen      DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_coi_venue ON concerts_of_interest(venue)`
    ).catch(() => {});
    await query(
      `CREATE INDEX IF NOT EXISTS idx_coi_notified ON concerts_of_interest(notified, event_date)`
    ).catch(() => {});
    logger.info("[VenueMonitor] concerts_of_interest table ready");
  } catch (err) {
    logger.warn({ err }, "[VenueMonitor] Failed to init concerts_of_interest table");
  }
}

async function saveConcert(item: ConcertItem): Promise<void> {
  const esc = (s: string) => (s ?? "").replace(/'/g, "''");
  const eventDate = item.eventDate ? `'${item.eventDate.toISOString().slice(0, 10)}'` : "NULL";
  try {
    await query(`
      INSERT INTO concerts_of_interest
        (venue, artist_or_event, event_date_text, event_date, event_url, source, score)
      SELECT '${esc(item.venue)}', '${esc(item.artistOrEvent)}', '${esc(item.eventDateText)}',
             ${eventDate}, '${esc(item.url)}', '${esc(item.source)}', ${item.score}
      WHERE NOT EXISTS (
        SELECT 1 FROM concerts_of_interest
        WHERE LOWER(venue) = LOWER('${esc(item.venue)}')
          AND LOWER(artist_or_event) = LOWER('${esc(item.artistOrEvent)}')
          AND (event_date = ${eventDate} OR (event_date IS NULL AND '${esc(item.eventDateText)}' = event_date_text))
      )
    `);
  } catch (err) {
    logger.warn({ err }, `[VenueMonitor] Failed to save concert: ${item.artistOrEvent} @ ${item.venue}`);
  }
}

async function markNotified(id: number): Promise<void> {
  try {
    await query(`UPDATE concerts_of_interest SET notified = TRUE WHERE id = $1`, [id]);
  } catch (err) {
    logger.warn({ err }, "[VenueMonitor] Failed to mark concert notified");
  }
}

// ── Web search for venue events ───────────────────────────────────────────────

interface RawConcert {
  venue: string;
  artistOrEvent: string;
  eventDateText: string;
  url: string;
}

async function searchVenueEvents(): Promise<RawConcert[]> {
  // Build all venue search queries + the general jazz/outdoor supplement
  const venueQueries = DAVID_VENUES.map((v) => v.searchQuery).join(" | ");
  const supplement = "Dallas jazz venues outdoor concerts music under the stars this week";

  const systemPrompt = `You are a Dallas concert researcher helping find music events at specific venues.
Search for upcoming events (next 30 days) at these Dallas venues: ${DAVID_VENUES.map((v) => v.name).join(", ")}.
Also search for: ${supplement}
Return ONLY a JSON array (no markdown, no extra text) with objects having these fields:
  venue (string - match to the venue list above),
  artistOrEvent (string - the performer or event name),
  eventDateText (string - the date as mentioned, e.g. "Saturday April 12" or "this Friday"),
  url (string - source URL or empty string)
Include only events with actual performers or specific event names. Skip generic "coming soon" pages.
Return up to 20 events.`;

  try {
    const result = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 8 }],
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `Search all ${DAVID_VENUES.length} Dallas venues for upcoming music events in the next 30 days. Also search for Dallas jazz venues and outdoor concerts this week.`,
      }],
    });

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const jsonMatch = /\[[\s\S]*\]/.exec(block.text);
      if (!jsonMatch) continue;
      return (JSON.parse(jsonMatch[0]) as RawConcert[]).filter(
        (c) => c.venue && c.artistOrEvent
      );
    }
  } catch (err) {
    logger.warn({ err }, "[VenueMonitor] Venue web search failed");
  }
  return [];
}

// ── Website fetcher (best-effort HTML scraping) ───────────────────────────────

async function fetchVenueWebsite(venue: VenueConfig): Promise<string> {
  if (!venue.websiteUrl) return "";
  try {
    const res = await fetch(venue.websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Winston/1.0; personal assistant)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    // Strip tags and collapse whitespace; take first 4000 chars
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  } catch {
    return "";
  }
}

// ── Parse a natural-language date to a Date object ────────────────────────────

function parseEventDate(text: string): Date | null {
  if (!text) return null;
  const d = new Date(text);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) return d;

  // Try "this Saturday", "next Friday", "April 12", etc.
  const now = new Date();
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const days   = ["sun","mon","tue","wed","thu","fri","sat"];

  const monthMatch = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})/i.exec(text);
  if (monthMatch) {
    const month = months.indexOf(monthMatch[1].toLowerCase().slice(0, 3));
    const day = parseInt(monthMatch[2], 10);
    const year = now.getMonth() > month ? now.getFullYear() + 1 : now.getFullYear();
    const candidate = new Date(year, month, day);
    if (!isNaN(candidate.getTime())) return candidate;
  }

  const dayMatch = /\b(this|next) (sun|mon|tue|wed|thu|fri|sat)/i.exec(text);
  if (dayMatch) {
    const targetDay = days.indexOf(dayMatch[2].toLowerCase().slice(0, 3));
    const offset = dayMatch[1].toLowerCase() === "next" ? 7 : 0;
    const diff = (targetDay - now.getDay() + 7) % 7 || 7;
    const candidate = new Date(now.getTime() + (diff + offset) * 86400000);
    return candidate;
  }

  return null;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface VenueCache {
  concerts: ConcertItem[];
  fetchedAt: Date;
  briefingBlock: string;
}

let _cache: VenueCache | null = null;

function isCacheValid(): boolean {
  if (!_cache) return false;
  if (_cache.fetchedAt.toDateString() !== new Date().toDateString()) return false;
  if (Date.now() - _cache.fetchedAt.getTime() > 12 * 60 * 60 * 1000) return false;
  return true;
}

// ── Format for morning briefing ───────────────────────────────────────────────

function formatConcertsForBriefing(concerts: ConcertItem[]): string {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400000);

  const relevant = concerts
    .filter((c) => c.score > 0)
    .filter((c) => !c.eventDate || c.eventDate <= in30Days)
    .sort((a, b) => {
      // events within 7 days first, then by score
      const aDate = a.eventDate?.getTime() ?? Infinity;
      const bDate = b.eventDate?.getTime() ?? Infinity;
      const in7 = now.getTime() + 7 * 86400000;
      const aSoon = aDate < in7;
      const bSoon = bDate < in7;
      if (aSoon !== bSoon) return aSoon ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, 4);

  if (relevant.length === 0) return "";

  const lines = relevant.map((c) => {
    const when = c.eventDateText ? ` — ${c.eventDateText}` : "";
    const why = c.matchedLabels.length > 0 ? ` (${c.matchedLabels.join(", ")})` : "";
    return `• ${c.venue}: ${c.artistOrEvent}${when}${why}`;
  });

  return (
    `\n\n[Dallas Music Events — David's Favorite Venues (next 30 days)]\n` +
    lines.join("\n") +
    `\n\nDavid's music interests: classic rock (60s/70s), classic jazz, Jimmy Buffett, Bonnie Raitt, ` +
    `Jackson Browne, Rolling Stones, Gordon Lightfoot, Van Morrison, outdoor concerts, jazz performances.\n` +
    `His favorite venues: ${DAVID_VENUES.map((v) => v.name).join(", ")}.\n` +
    `Present relevant music events naturally — "David, the Kessler has a Gordon Lightfoot tribute act ` +
    `Saturday night that looks perfect for you." Only mention events that genuinely match his taste. ` +
    `Lead with anything within the next 7 days. If nothing matches his interests closely, skip this section.`
  );
}

// ── Proactive push alerts for events within 7 days ───────────────────────────

async function sendConcertAlerts(): Promise<void> {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 86400000);
  const today = now.toISOString().slice(0, 10);
  const limit7 = in7Days.toISOString().slice(0, 10);

  let rows: Array<{ id: number; venue: string; artist_or_event: string; event_date_text: string }>;
  try {
    const result = await query<{ id: number; venue: string; artist_or_event: string; event_date_text: string }>(
      `SELECT id, venue, artist_or_event, event_date_text
       FROM concerts_of_interest
       WHERE notified = FALSE AND score >= 5
         AND (event_date BETWEEN $1 AND $2 OR event_date IS NULL)
       ORDER BY score DESC LIMIT 3`,
      [today, limit7]
    );
    rows = result.rows;
  } catch {
    return;
  }

  for (const row of rows) {
    const when = row.event_date_text ? ` ${row.event_date_text}` : "";
    const text = `Hey David — ${row.venue} has ${row.artist_or_event}${when} that looks right up your alley.`;

    try {
      broadcastToUser(USER, "proactive", { message: text, type: "concert-alert" });
    } catch (err) {
      logger.warn({ err }, "[VenueMonitor] SSE broadcast failed");
    }
    try {
      await sendPushToAll(USER, "Winston — Dallas Music Event", text);
    } catch {
      // non-fatal
    }
    await markNotified(row.id);
    logger.info(`[VenueMonitor] Concert alert sent: ${row.artist_or_event} @ ${row.venue}`);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function runVenueScan(): Promise<string> {
  if (isCacheValid()) {
    logger.info("[VenueMonitor] Returning cached concert data");
    return _cache!.briefingBlock;
  }

  logger.info("[VenueMonitor] Scanning venues for upcoming music events");

  // 1. Web search for all venues simultaneously (single Claude call, multi-search)
  const rawConcerts = await searchVenueEvents();
  logger.info(`[VenueMonitor] Web search returned ${rawConcerts.length} raw events`);

  // 2. Fetch venue websites in parallel (best-effort)
  const venuesWithUrls = DAVID_VENUES.filter((v) => v.websiteUrl);
  const websiteTexts = await Promise.allSettled(venuesWithUrls.map((v) => fetchVenueWebsite(v)));
  // Build a map of venue name → extracted text for reference (currently logged)
  websiteTexts.forEach((r, i) => {
    const name = venuesWithUrls[i].name;
    if (r.status === "fulfilled" && r.value.length > 100) {
      logger.info(`[VenueMonitor] ${name} website: ${r.value.length} chars fetched`);
    } else {
      logger.info(`[VenueMonitor] ${name} website: not accessible`);
    }
  });

  // 3. Score, filter, and persist each concert
  const matched: ConcertItem[] = [];
  for (const raw of rawConcerts) {
    const text = `${raw.venue} ${raw.artistOrEvent} ${raw.eventDateText}`;
    const { score, matchedLabels } = scoreConcert(text);
    // Include all events at David's specific venues (they're all music-relevant),
    // but require a score for general Dallas events
    const venueIsKnown = DAVID_VENUES.some((v) => v.name.toLowerCase().includes(raw.venue.toLowerCase()) || raw.venue.toLowerCase().includes(v.name.toLowerCase().split(" ")[0]));
    if (!venueIsKnown && score === 0) continue;

    const concert: ConcertItem = {
      venue: raw.venue,
      artistOrEvent: raw.artistOrEvent,
      eventDateText: raw.eventDateText,
      eventDate: parseEventDate(raw.eventDateText),
      url: raw.url,
      source: "web_search",
      score: venueIsKnown ? Math.max(score, 3) : score,
      matchedLabels,
    };
    matched.push(concert);
    void saveConcert(concert);
  }

  logger.info(`[VenueMonitor] ${matched.length} matched events saved/checked`);

  // 4. Format for briefing
  const briefingBlock = formatConcertsForBriefing(matched);

  _cache = { concerts: matched, fetchedAt: new Date(), briefingBlock };

  // 5. Send proactive alerts for events within 7 days (async, non-blocking)
  void sendConcertAlerts();

  return briefingBlock;
}

/**
 * Return today's cached concert items for deduplication filtering.
 * Call after runVenueScan() to ensure the cache is populated.
 */
export function getVenueConcerts(): ConcertItem[] {
  return _cache?.concerts ?? [];
}

/**
 * Build the briefing block from an already-filtered list of concerts.
 * Used by dedup integration to re-format after removing seen events.
 */
export function buildVenueConcertsBlock(concerts: ConcertItem[]): string {
  return formatConcertsForBriefing(concerts);
}

// ── Scheduler: runs daily at 5:30 AM CT ──────────────────────────────────────

export function startVenueMonitorScheduler(): void {
  // Run at 5:30 AM CT — alongside the morning briefing pre-generation
  // so concert data is ready when David checks in.
  cron.schedule("30 5 * * *", () => {
    void runVenueScan();
  }, { timezone: TZ });

  logger.info("[VenueMonitor] Scheduler started (runs daily 5:30 AM CT)");
}
