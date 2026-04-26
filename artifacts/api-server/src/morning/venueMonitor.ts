/**
 * Music venue monitor — scans the user's favorite venues for upcoming concerts
 * and music events that match their taste, stores matches in concerts_of_interest,
 * and surfaces them in the morning briefing.
 *
 * Default venues (David's Dallas favorites): Kessler Theater, Granada Theater,
 * Dos Equis Pavilion, AT&T Performing Arts Center, Klyde Warren Park,
 * Dallas Arboretum (Music Under the Stars), Jazz at the Meyerson.
 *
 * For a new user without stored preferences, the concert section is omitted.
 */

import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, getProfile, type CollectedData } from "../onboarding/onboardingManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic();
const TZ = "America/Chicago";

// ── Music-interest patterns (shared defaults — ideally stored in user profile) ─

const ARTIST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /jimmy buffett|margaritaville/i,      label: "Jimmy Buffett" },
  { pattern: /bonnie raitt/i,                       label: "Bonnie Raitt" },
  { pattern: /jackson browne/i,                     label: "Jackson Browne" },
  { pattern: /rolling stones|stones tribute/i,      label: "Rolling Stones" },
  { pattern: /gordon lightfoot/i,                   label: "Gordon Lightfoot" },
  { pattern: /van morrison/i,                       label: "Van Morrison" },
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

const DEFAULT_VENUES: VenueConfig[] = [
  { name: "Kessler Theater",               searchQuery: "Kessler Theater Dallas upcoming events concerts schedule",    websiteUrl: "https://www.kesslertheatre.com/events" },
  { name: "Granada Theater",               searchQuery: "Granada Theater Dallas concerts schedule upcoming events",    websiteUrl: "https://www.granadatheater.com/events" },
  { name: "Dos Equis Pavilion",            searchQuery: "Dos Equis Pavilion Dallas concerts 2025 upcoming schedule" },
  { name: "AT&T Performing Arts Center",   searchQuery: "AT&T Performing Arts Center Dallas upcoming shows concerts" },
  { name: "Klyde Warren Park",             searchQuery: "Klyde Warren Park Dallas events concerts music" },
  { name: "Dallas Arboretum",              searchQuery: "Dallas Arboretum Music Under the Stars schedule concerts",    websiteUrl: "https://www.dallasarboretum.org/events" },
  { name: "Jazz at the Meyerson",          searchQuery: "Meyerson Symphony Center Dallas jazz concerts upcoming" },
];

/** Returns the list of default venue names (for use in local-content preference scoring) */
export function getFavoriteVenueNames(): string[] {
  return DEFAULT_VENUES.map((v) => v.name);
}

export interface ConcertItem {
  venue: string;
  artistOrEvent: string;
  eventDateText: string;
  eventDate: Date | null;
  url: string;
  source: string;
  score: number;
  matchedLabels: string[];
}

// ── DB helpers ────────────────────────────────────────────────────────────────

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
    await query(`CREATE INDEX IF NOT EXISTS idx_coi_venue ON concerts_of_interest(venue)`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_coi_notified ON concerts_of_interest(notified, event_date)`).catch(() => {});
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

async function searchVenueEvents(venues: VenueConfig[], city: string): Promise<RawConcert[]> {
  const supplement = `${city} jazz venues outdoor concerts music this week`;

  const systemPrompt = `You are a concert researcher helping find music events at specific venues.
Search for upcoming events (next 30 days) at these ${city} venues: ${venues.map((v) => v.name).join(", ")}.
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
        content: `Search all ${venues.length} ${city} venues for upcoming music events in the next 30 days. Also search for ${city} jazz venues and outdoor concerts this week.`,
      }],
    });

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const jsonMatch = /\[[\s\S]*\]/.exec(block.text);
      if (!jsonMatch) continue;
      return (JSON.parse(jsonMatch[0]) as RawConcert[]).filter((c) => c.venue && c.artistOrEvent);
    }
  } catch (err) {
    logger.warn({ err }, "[VenueMonitor] Venue web search failed");
  }
  return [];
}

async function fetchVenueWebsite(venue: VenueConfig): Promise<string> {
  if (!venue.websiteUrl) return "";
  try {
    const res = await fetch(venue.websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Winston/1.0; personal assistant)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return "";
    const html = await res.text();
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

// ── Cache (single global cache is acceptable while venue list is shared) ──────

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

function formatConcertsForBriefing(
  concerts: ConcertItem[],
  venues: VenueConfig[],
  userName: string,
  city: string
): string {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400000);

  const relevant = concerts
    .filter((c) => c.score > 0)
    .filter((c) => !c.eventDate || c.eventDate <= in30Days)
    .sort((a, b) => {
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
    `\n\n[${city} Music Events — Favorite Venues (next 30 days)]\n` +
    lines.join("\n") +
    `\n\nFavorite venues: ${venues.map((v) => v.name).join(", ")}.\n` +
    `RULES FOR PRESENTING THIS SECTION:\n` +
    `• Only mention events that match David's music taste (classic rock, jazz, Jimmy Buffett, Rolling Stones, Jackson Browne). Skip indie rock, rap, hip-hop, EDM, or genres he doesn't follow.\n` +
    `• NEVER mention generic promotional events or season passes (e.g. "Live Nation Summer of Live", "concert series announcements", "season ticket packages"). Only mention specific performers at specific venues with specific dates.\n` +
    `• If an event matches his taste: 1 sentence, name the artist, venue, and date. Lead with anything within 7 days.\n` +
    `• If nothing here matches his taste closely: skip this section entirely. Do not force a mention.`
  );
}

// ── Proactive push alerts for events within 7 days ───────────────────────────

async function sendConcertAlertsForUser(userName: string, companionName: string): Promise<void> {
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
       ORDER BY score DESC LIMIT 12`,
      [today, limit7]
    );
    rows = result.rows;
  } catch {
    return;
  }

  if (!rows.length) return;

  // Group by venue so a concert series (multiple bands, same venue) becomes ONE notification
  const venueMap = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.venue.trim().toLowerCase();
    if (!venueMap.has(key)) venueMap.set(key, []);
    venueMap.get(key)!.push(row);
  }

  for (const concerts of venueMap.values()) {
    const venueName = concerts[0].venue;
    const venueSlug = venueName.replace(/\W+/g, "-").toLowerCase();

    let bodyText: string;
    let companionMessage: string;

    if (concerts.length === 1) {
      const c = concerts[0];
      const when = c.event_date_text ? ` on ${c.event_date_text}` : "";
      bodyText = `${venueName} has ${c.artist_or_event}${when} coming up.`;
      companionMessage = `Hey — I spotted a concert that looks right up your alley. ${venueName} has ${c.artist_or_event}${when}. Want me to add it to your calendar?`;
    } else {
      const list = concerts
        .map((c) => `${c.artist_or_event}${c.event_date_text ? ` (${c.event_date_text})` : ""}`)
        .join(", ");
      bodyText = `${venueName} has ${concerts.length} upcoming concerts: ${list}.`;
      companionMessage = `Hey — ${venueName} has ${concerts.length} upcoming concerts you might enjoy: ${list}. Want me to add any of them to your calendar?`;
    }

    try {
      broadcastToUser(userName, "proactive", { message: companionMessage, type: "concert-alert" });
    } catch (err) {
      logger.warn({ err }, "[VenueMonitor] SSE broadcast failed");
    }

    try {
      await sendPushToAll({
        title: `🎵 ${companionName} — Concert Alert`,
        body: bodyText,
        tag: `concert-alert-${venueSlug}`,
        notificationType: "concert-alert",
        companionMessage,
        eventDetails: concerts.map((c) => ({
          id: c.id,
          venue: c.venue,
          artistOrEvent: c.artist_or_event,
          eventDateText: c.event_date_text,
        })),
        requireInteraction: false,
      }, userName);
    } catch {
      // non-fatal
    }

    for (const c of concerts) {
      await markNotified(c.id);
    }

    logger.info(`[VenueMonitor] Concert alert sent: ${concerts.length} event(s) @ ${venueName} → ${userName}`);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function runVenueScan(userName = NATIVE_STORED_NAME): Promise<string> {
  if (isCacheValid()) {
    logger.info("[VenueMonitor] Returning cached concert data");
    return _cache!.briefingBlock;
  }

  const profile = await getProfile(userName).catch(() => null);
  const city = profile?.city ?? "Dallas";
  const companionName = profile?.companionName ?? "Your Companion";

  logger.info("[VenueMonitor] Scanning venues for upcoming music events");

  const rawConcerts = await searchVenueEvents(DEFAULT_VENUES, city);
  logger.info(`[VenueMonitor] Web search returned ${rawConcerts.length} raw events`);

  const venuesWithUrls = DEFAULT_VENUES.filter((v) => v.websiteUrl);
  const websiteTexts = await Promise.allSettled(venuesWithUrls.map((v) => fetchVenueWebsite(v)));
  websiteTexts.forEach((r, i) => {
    const name = venuesWithUrls[i].name;
    if (r.status === "fulfilled" && r.value.length > 100) {
      logger.info(`[VenueMonitor] ${name} website: ${r.value.length} chars fetched`);
    } else {
      logger.info(`[VenueMonitor] ${name} website: not accessible`);
    }
  });

  const matched: ConcertItem[] = [];
  for (const raw of rawConcerts) {
    const text = `${raw.venue} ${raw.artistOrEvent} ${raw.eventDateText}`;
    const { score, matchedLabels } = scoreConcert(text);
    const venueIsKnown = DEFAULT_VENUES.some(
      (v) =>
        v.name.toLowerCase().includes(raw.venue.toLowerCase()) ||
        raw.venue.toLowerCase().includes(v.name.toLowerCase().split(" ")[0])
    );
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

  const briefingBlock = formatConcertsForBriefing(matched, DEFAULT_VENUES, userName, city);
  _cache = { concerts: matched, fetchedAt: new Date(), briefingBlock };

  void sendConcertAlertsForUser(userName, companionName);

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
export function buildVenueConcertsBlock(concerts: ConcertItem[], userName = NATIVE_STORED_NAME, city = "Dallas"): string {
  return formatConcertsForBriefing(concerts, DEFAULT_VENUES, userName, city);
}

// ── Scheduler: runs daily at 5:30 AM CT ──────────────────────────────────────

export function startVenueMonitorScheduler(): void {
  cron.schedule("30 5 * * *", async () => {
    try {
      const users = await getActiveUsers();
      const primaryUser = users[0]?.userName ?? NATIVE_STORED_NAME;
      void runVenueScan(primaryUser);
    } catch {
      void runVenueScan(NATIVE_STORED_NAME);
    }
  }, { timezone: TZ });

  logger.info("[VenueMonitor] Scheduler started (runs daily 5:30 AM CT)");
}
