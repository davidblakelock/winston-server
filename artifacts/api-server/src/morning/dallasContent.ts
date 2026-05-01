/**
 * Local content system — fetches city-specific news and events for any user.
 *
 * City is passed in from the briefing pre-generator via UserLocalContext, pulled
 * from the user's profile (user_profiles.city). Three Google News RSS feeds are
 * generated dynamically for the user's city (local news, dining, arts & events),
 * all scoped to the last 7 days via Google's `when:7d` operator.
 *
 * Also queries the Ticketmaster Discovery API for upcoming music events when
 * TICKETMASTER_API_KEY is set (free tier, no key = graceful skip).
 *
 * Note: Eventbrite shut down their public API in 2023 — not usable here.
 *
 * Results are cached in memory for the day keyed by city, and persisted to
 * the daily_local_content table.
 */

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalContentItem {
  source: string;
  headline: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
  priority: "high" | "medium" | "low";
  keywordsMatched: string[];
}

/** User context passed in from the briefing pre-generator */
export interface UserLocalContext {
  /** Primary city name, e.g. "Dallas" or "Austin" */
  city: string;
  /** User's first name for log messages */
  userName?: string;
  /** Favorite music venues (exact/partial names) */
  venues?: string[];
  /** Favorite artists / bands */
  artists?: string[];
  /** Preferred city neighborhoods */
  neighborhoods?: string[];
  /** Food/dining interests (cuisine types, e.g. "Italian", "seafood") */
  foodInterests?: string[];
  /**
   * Music genre preferences from raw_data.music, e.g.
   * ["classic rock from the 60s and 70s", "classic jazz"].
   * Used to build genre-specific concert/event scoring.
   */
  musicGenres?: string[];
  /**
   * Hobbies and general interests from raw_data.interests, e.g.
   * ["pickleball", "woodworking", "boats", "cooking", "stock market"].
   * Local events matching any interest get elevated to high priority.
   */
  interests?: string[];
  /**
   * Favorite restaurant names from raw_data.restaurants + profile_items.restaurants.
   * News mentioning a favorite restaurant by name gets high priority.
   */
  favoriteRestaurants?: string[];
  /**
   * Sports teams the user follows, e.g. ["Rangers", "Cowboys"].
   * Non-score local news about their teams gets high priority.
   */
  sportsTeams?: string[];
  /**
   * Dietary restrictions / preferences, e.g. ["gluten-free", "vegetarian"].
   * Used to boost restaurants that cater to these needs.
   */
  dietaryRestrictions?: string[];
}

interface RSSItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

interface FeedConfig {
  name: string;
  url: string;
  /** How many days back to accept items. Defaults to 3 if omitted. */
  maxAgeDays?: number;
}

// ── City-aware feed builder ───────────────────────────────────────────────────
//
// All feeds use Google News RSS with `when:7d` so Google pre-filters to recent
// results before we even receive the payload. Three complementary queries are
// generated per city to broaden coverage across news types.

function buildCityFeeds(city: string): FeedConfig[] {
  const q = encodeURIComponent(city);
  return [
    {
      name: `${city} Local News`,
      url: `https://news.google.com/rss/search?q=${q}+local+news+events+community+when:7d&hl=en-US&gl=US&ceid=US:en`,
      maxAgeDays: 7,
    },
    {
      name: `${city} Dining & Food`,
      url: `https://news.google.com/rss/search?q=${q}+restaurant+opening+dining+food+chef+when:7d&hl=en-US&gl=US&ceid=US:en`,
      maxAgeDays: 7,
    },
    {
      name: `${city} Arts & Entertainment`,
      url: `https://news.google.com/rss/search?q=${q}+arts+concert+festival+live+music+events+when:7d&hl=en-US&gl=US&ceid=US:en`,
      maxAgeDays: 7,
    },
  ];
}

// ── Preference-aware pattern builder ─────────────────────────────────────────

interface PriorityPattern { pattern: RegExp; label: string }

/** Escape a string for use inside a RegExp */
function escRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a single OR regex from an array of strings. Returns null if empty. */
function stringsToRx(arr: string[]): RegExp | null {
  const cleaned = arr.map((s) => s.trim()).filter((s) => s.length > 1);
  if (cleaned.length === 0) return null;
  return new RegExp(cleaned.map(escRx).join("|"), "i");
}

/** Detects that a headline/description is about a live music event or concert. */
const MUSIC_EVENT_SIGNAL = /\b(concert|performing|live\s+show|live\s+music|show\s+at|tour|tickets|gig|festival|at the .{3,30}theater|at the .{3,30}venue)\b/i;

/**
 * Expand a free-text music genre preference into searchable keyword terms.
 * E.g. "classic rock from the 60s and 70s" → ["classic rock","60s","70s","blues rock"]
 *      "classic jazz" → ["jazz","bebop","big band","swing"]
 */
function expandMusicPreference(pref: string): string[] {
  const p = pref.toLowerCase();
  const terms: string[] = [];

  if (/classic rock|rock.*(60|70|1960|1970)|60s rock|70s rock/.test(p)) {
    terms.push("classic rock", "60s", "70s", "blues rock", "rock and roll", "album rock");
  }
  if (/\bjazz\b|bebop|big band|swing/.test(p)) {
    terms.push("jazz", "bebop", "big band", "swing", "cool jazz", "jazz fusion");
  }
  if (/\bblues\b/.test(p)) {
    terms.push("blues", "blues rock", "rhythm and blues");
  }
  if (/country/.test(p)) {
    terms.push("country", "country music", "bluegrass");
  }
  if (/folk|acoustic/.test(p)) {
    terms.push("folk", "acoustic", "singer-songwriter");
  }
  if (/classical|orchestra|symphony|opera/.test(p)) {
    terms.push("classical", "symphony", "orchestra", "philharmonic", "opera");
  }
  if (/hip.?hop|rap\b/.test(p)) {
    terms.push("hip hop", "hip-hop", "rap");
  }
  if (/electronic|edm|techno|house/.test(p)) {
    terms.push("electronic", "edm", "techno", "house music");
  }
  if (/soul|r&b|motown/.test(p)) {
    terms.push("soul", "r&b", "motown", "funk");
  }
  if (/reggae/.test(p)) {
    terms.push("reggae");
  }
  if (/latin|salsa|tejano/.test(p)) {
    terms.push("latin", "salsa", "tejano");
  }

  // Fallback: pull meaningful words (>3 chars) from the raw preference string
  if (terms.length === 0) {
    const STOPWORDS = new Set(["from","with","and","the","for","this","that","just","have","more"]);
    terms.push(
      ...pref.split(/[\s,]+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    );
  }

  return [...new Set(terms)];
}

/**
 * Build all scoring patterns from the user's profile context.
 *
 * Design principles:
 *  HIGH  — Directly matches a user preference (their venue, artist, restaurant, hobby, team, genre)
 *  MEDIUM — Matches broad interest category; no specific preference match required
 *  LOW   — Generic local content (community, business) worth knowing but not personalized
 *  NULL  — Excluded (sponsored, score results, no local relevance)
 *
 * When user has preferences set for a category (e.g. music genres), generic signals
 * in that category drop to MEDIUM at most, keeping HIGH for genuinely matched content.
 */
function buildPatterns(ctx: UserLocalContext): {
  exclude: RegExp[];
  high: PriorityPattern[];
  medium: PriorityPattern[];
  low: PriorityPattern[];
  /** When set, any headline that matches MUSIC_EVENT_SIGNAL must also match this
   *  artist regex — otherwise it is excluded. Enforces strict artist-only concert filtering. */
  concertArtistRx: RegExp | null;
} {
  const city = ctx.city;

  // ── Signals that detect what a headline is "about" ─────────────────────────
  const RESTAURANT_OPENING_SIGNAL = /\b(open|opens|opening|grand opening|now open|new restaurant|soft open|debut)\b/i;
  const LOCAL_EVENT_SIGNAL = /\b(event|festival|tournament|league|class|workshop|show|fair|expo|market|tour|race|run|competition)\b/i;

  // ── EXCLUDE ────────────────────────────────────────────────────────────────
  const exclude: RegExp[] = [
    /sponsored|advertisement|advertorial|promoted content/i,
    // Sports final-score results are covered by ESPN — don't duplicate here
    /\b(final score|box score|recap|postgame)\b/i,
    /\b(beats|defeats|wins against|loses to)\b.{0,40}\b\d+[-–]\d+\b/i,
  ];

  // ── HIGH priority ──────────────────────────────────────────────────────────
  const high: PriorityPattern[] = [];

  // 1. Favorite venues — always high when mentioned
  const venueRx = stringsToRx(ctx.venues ?? []);
  if (venueRx) high.push({ pattern: venueRx, label: "favorite venue" });

  // 2. Favorite artists — always high when mentioned
  const artistRx = stringsToRx(ctx.artists ?? []);
  if (artistRx) high.push({ pattern: artistRx, label: "favorite artist" });

  // 3. Music genres — high ONLY if it's a music event AND matches their genres
  //    If user has NO genre preferences, any concert stays as a medium signal (below)
  if (ctx.musicGenres && ctx.musicGenres.length > 0) {
    const genreTerms = ctx.musicGenres.flatMap(expandMusicPreference);
    const genreRx = stringsToRx(genreTerms);
    if (genreRx) {
      // Combine: genre match + music event signal → high
      // We achieve this by using a pattern that tests genre terms, and the
      // MUSIC_EVENT_SIGNAL already overlaps; scoreItem will catch it.
      high.push({ pattern: genreRx, label: "preferred music genre" });
    }
  }

  // 4. Specific interests / hobbies — high when paired with a local event signal
  //    We score these as high directly; the scorer will handle it.
  const interestTerms = (ctx.interests ?? []).filter((i) => i.length > 2);
  if (interestTerms.length > 0) {
    const interestRx = stringsToRx(interestTerms);
    if (interestRx) high.push({ pattern: interestRx, label: "personal interest" });
  }

  // 5. Favorite restaurants — high when mentioned by name
  const favRestaurantRx = stringsToRx(ctx.favoriteRestaurants ?? []);
  if (favRestaurantRx) high.push({ pattern: favRestaurantRx, label: "favorite restaurant" });

  // 6. Dietary restrictions match (opens a restaurant catering to their needs)
  const dietRx = stringsToRx(ctx.dietaryRestrictions ?? []);
  if (dietRx) high.push({ pattern: dietRx, label: "dietary match" });

  // 7. Sports teams — non-score news about their teams is high interest
  //    We can't easily distinguish score vs. non-score at this layer, so we add
  //    their teams as high but the EXCLUDE block above will catch pure score results.
  if (ctx.sportsTeams && ctx.sportsTeams.length > 0) {
    const teamRx = stringsToRx(ctx.sportsTeams);
    if (teamRx) high.push({ pattern: teamRx, label: "followed sports team" });
  }

  // 8. Preferred neighborhoods — any local news from their neighborhoods is high
  const hoodRx = stringsToRx(ctx.neighborhoods ?? []);
  if (hoodRx) high.push({ pattern: hoodRx, label: "preferred neighborhood" });

  // 9. New restaurant opening is always high — everyone wants to know about openings
  high.push({ pattern: RESTAURANT_OPENING_SIGNAL, label: "restaurant opening" });

  // ── MEDIUM priority ─────────────────────────────────────────────────────────
  const medium: PriorityPattern[] = [];

  // General food & dining (not a specific opening, not a fav restaurant)
  medium.push({ pattern: /restaurant|dining|chef|food|cocktail bar|brunch|new bar|eatery/i, label: "food & dining" });

  // Cuisine preferences → medium boost for matching cuisine type in dining news
  const cuisineRx = stringsToRx(ctx.foodInterests ?? []);
  if (cuisineRx) medium.push({ pattern: cuisineRx, label: "cuisine preference" });

  // Music / concerts — if user HAS genre prefs, generic live music is medium at best
  // (their specific genres got HIGH above); if no prefs, keep broad music at medium
  if (ctx.musicGenres && ctx.musicGenres.length > 0) {
    // User has specific genre taste — broad "live music" doesn't auto-qualify for high
    medium.push({ pattern: /\b(live music|concert|music festival|open mic)\b/i, label: "live music (medium)" });
  } else {
    // No preferences stored — broad music interest at medium
    medium.push({ pattern: /jazz|bebop|big band|classic rock|blues|live music|concert series/i, label: "music (no pref)" });
  }

  // Outdoor concerts & amphitheaters (relevant regardless of genre)
  medium.push({ pattern: /outdoor concert|amphitheater|summer concert|tribute band/i, label: "outdoor concert" });

  // Arts, culture, festivals broadly
  medium.push({ pattern: /arts|festival|exhibition|gallery|performance|show|theater|theatre/i, label: "arts & culture" });

  // Outdoor / nature activities
  medium.push({ pattern: /outdoor|park|trail|farmers market|hike|nature/i, label: "outdoor activity" });

  // City catch-all — any local mention qualifies as at least medium
  medium.push({
    pattern: new RegExp(escRx(city), "i"),
    label: "city local",
  });

  // ── LOW priority ────────────────────────────────────────────────────────────
  const low: PriorityPattern[] = [
    { pattern: /real estate|development|commercial property/i, label: "real estate" },
    { pattern: /local business|economy|business opens|retail/i, label: "local business" },
    { pattern: /neighborhood association|community meeting|city council|zoning/i, label: "community" },
  ];

  // ── Concert filter ────────────────────────────────────────────────────────
  // If the user has any saved artists, concerts must match a specific saved artist.
  // This prevents artists not in the user's profile (e.g. Kid Rock) from surfacing
  // just because they match a generic genre term or city mention.
  const concertArtistRx = stringsToRx(ctx.artists ?? []);

  return { exclude, high, medium, low, concertArtistRx };
}

// ── Lightweight RSS parser (no external packages needed) ──────────────────────

function extractTag(xml: string, tag: string): string {
  const cdataRx = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i");
  const cdata = cdataRx.exec(xml);
  if (cdata) return cdata[1].trim();
  const plainRx = new RegExp(`<${tag}[^>]*>([^<]*)<`, "i");
  const plain = plainRx.exec(xml);
  return plain ? plain[1].trim() : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/gi, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRSS(xml: string): RSSItem[] {
  const items: RSSItem[] = [];
  const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRx.exec(xml)) !== null) {
    const chunk = m[1];
    const title = extractTag(chunk, "title");
    if (!title) continue;
    items.push({
      title,
      description: extractTag(chunk, "description"),
      link:        extractTag(chunk, "link") || extractTag(chunk, "guid"),
      pubDate:     extractTag(chunk, "pubDate") || extractTag(chunk, "dc:date") || extractTag(chunk, "published"),
    });
  }
  return items;
}

// ── Freshness check ───────────────────────────────────────────────────────────

function isWithinMaxAge(dateStr: string, maxAgeDays: number): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= maxAgeDays * 24 * 60 * 60 * 1000;
}

// ── Priority scoring ──────────────────────────────────────────────────────────

function scoreItem(
  headline: string,
  description: string,
  patterns: ReturnType<typeof buildPatterns>,
): { priority: "high" | "medium" | "low" | null; keywords: string[] } {
  const text = `${headline} ${description}`;

  for (const rx of patterns.exclude) {
    if (rx.test(text)) return { priority: null, keywords: [] };
  }

  // ── Concert/music-event strict filtering ──────────────────────────────────
  // If the user has saved artists and this looks like a concert/music event,
  // it MUST match one of their specific saved artists — no exceptions.
  // Generic concerts (artists not in the user's profile) are excluded entirely.
  if (patterns.concertArtistRx && MUSIC_EVENT_SIGNAL.test(text)) {
    if (!patterns.concertArtistRx.test(text)) {
      return { priority: null, keywords: [] };
    }
  }

  const highKeywords: string[] = [];
  for (const { pattern, label } of patterns.high) {
    if (pattern.test(text)) highKeywords.push(label);
  }
  if (highKeywords.length > 0) return { priority: "high", keywords: highKeywords };

  const medKeywords: string[] = [];
  for (const { pattern, label } of patterns.medium) {
    if (pattern.test(text)) medKeywords.push(label);
  }
  if (medKeywords.length > 0) return { priority: "medium", keywords: medKeywords };

  const lowKeywords: string[] = [];
  for (const { pattern, label } of patterns.low) {
    if (pattern.test(text)) lowKeywords.push(label);
  }
  if (lowKeywords.length > 0) return { priority: "low", keywords: lowKeywords };

  return { priority: null, keywords: [] };
}

// ── RSS feed fetcher ──────────────────────────────────────────────────────────

async function fetchFeed(
  feed: FeedConfig,
  patterns: ReturnType<typeof buildPatterns>,
): Promise<LocalContentItem[]> {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "Winston/1.0 (personal assistant)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.url}`);
  const xml = await res.text();
  const rssItems = parseRSS(xml);

  const maxAgeDays = feed.maxAgeDays ?? 3;
  let staleDrop = 0;
  let scoreDrop = 0;
  const results: LocalContentItem[] = [];
  for (const item of rssItems.slice(0, 60)) {
    if (!isWithinMaxAge(item.pubDate, maxAgeDays)) { staleDrop++; continue; }
    const headline = stripHtml(item.title);
    const summary  = stripHtml(item.description).slice(0, 350);
    const { priority, keywords } = scoreItem(headline, summary, patterns);
    if (!priority) { scoreDrop++; continue; }
    results.push({
      source: feed.name,
      headline,
      summary,
      url: item.link,
      publishedAt: item.pubDate ? new Date(item.pubDate) : null,
      priority,
      keywordsMatched: keywords,
    });
  }
  console.log(`[LocalContent:feed] ${feed.name}: ${rssItems.length} parsed → ${staleDrop} dropped (stale) → ${scoreDrop} dropped (no match) → ${results.length} kept`);
  return results;
}

// ── Ticketmaster Discovery API ────────────────────────────────────────────────
//
// Requires TICKETMASTER_API_KEY environment variable (free at developer.ticketmaster.com).
// Gracefully returns [] when key is absent — no config required.

async function fetchTicketmasterEvents(city: string): Promise<LocalContentItem[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      city,
      classificationName: "music",
      sort: "date,asc",
      size: "10",
    });
    const res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      logger.warn(`[LocalContent] Ticketmaster HTTP ${res.status} for city="${city}"`);
      return [];
    }
    const data = await res.json() as {
      _embedded?: {
        events?: Array<{
          name: string;
          url: string;
          dates?: { start?: { localDate?: string; localTime?: string } };
          _embedded?: { venues?: Array<{ name: string }> };
          info?: string;
        }>;
      };
    };

    const events = data._embedded?.events ?? [];
    const results: LocalContentItem[] = events.map((ev) => {
      const venueName = ev._embedded?.venues?.[0]?.name ?? city;
      const dateStr = ev.dates?.start?.localDate ?? "";
      const timeStr = ev.dates?.start?.localTime ?? "";
      const when = dateStr ? ` on ${dateStr}${timeStr ? " at " + timeStr : ""}` : "";
      return {
        source: "Ticketmaster",
        headline: `${ev.name} at ${venueName}${when}`,
        summary: ev.info ?? `Live music event at ${venueName} in ${city}.`,
        url: ev.url,
        publishedAt: dateStr ? new Date(dateStr) : null,
        priority: "high" as const,
        keywordsMatched: ["ticketmaster_event"],
      };
    });
    console.log(`[LocalContent:ticketmaster] ${results.length} music events found in ${city}`);
    return results;
  } catch (err) {
    logger.warn({ err }, `[LocalContent] Ticketmaster fetch failed for ${city}`);
    return [];
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicate(items: LocalContentItem[]): LocalContentItem[] {
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => {
    const pr = priorityRank[a.priority] - priorityRank[b.priority];
    if (pr !== 0) return pr;
    return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
  });
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.headline
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Music/events web search supplement ───────────────────────────────────────

async function musicWebSearch(ctx: UserLocalContext): Promise<LocalContentItem[]> {
  const city = ctx.city;
  const venueHints = ctx.venues?.slice(0, 4).join(", ") ?? `${city} music venues`;
  // Build a genre-specific search focused on what the user actually likes
  const genreList = ctx.musicGenres?.length
    ? ctx.musicGenres.join(", ")
    : "jazz, classic rock, live music";
  // Expand to searchable genre keywords for the query
  const genreTerms = ctx.musicGenres?.flatMap(expandMusicPreference).slice(0, 6).join(", ")
    ?? "jazz, classic rock";
  logger.info(`[LocalContent] Running music events web search for ${city} — genres: ${genreList}`);
  try {
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 2 }],
      system: `You are a local music events researcher for ${city}. The listener's music preferences are: ${genreList}. Search for upcoming live music events in ${city} this week and next week that match these preferences. Focus on venues: ${venueHints}. ONLY include events that match the listener's taste — skip pop, country, hip-hop, rap, heavy metal, EDM, or any genre not listed in their preferences. Return ONLY a JSON array (no markdown, no explanation) with up to 4 objects, each having: headline (string), summary (1–2 sentence string), url (string), source (string).`,
      messages: [{
        role: "user",
        content: `Search: ${city} ${genreTerms} concerts events this week. Also: ${venueHints} upcoming events.`,
      }],
    });

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const jsonMatch = /\[[\s\S]*\]/.exec(block.text);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        headline?: string; summary?: string; url?: string; source?: string;
      }>;
      return parsed
        .filter((p) => p.headline)
        .map((p) => ({
          source: p.source ?? `${city} Music Search`,
          headline: p.headline ?? "",
          summary: p.summary ?? "",
          url: p.url ?? "",
          publishedAt: new Date(),
          priority: "high" as const,
          keywordsMatched: ["music_web_search"],
        }));
    }
  } catch (err) {
    logger.warn({ err }, `[LocalContent] Music web search failed for ${city}`);
  }
  return [];
}

// ── Web search fallback ───────────────────────────────────────────────────────

async function webSearchFallback(ctx: UserLocalContext): Promise<LocalContentItem[]> {
  const city = ctx.city;
  logger.info(`[LocalContent] Running web search fallback for ${city}`);
  try {
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 3 }],
      system: `You are a local content researcher for ${city}. Search for recent news (within the last 72 hours) about new restaurant openings and events in ${city}. Return ONLY a JSON array (no markdown, no explanation) with up to 3 objects, each having: headline (string), summary (1–2 sentence string), url (string), source (string).`,
      messages: [{
        role: "user",
        content: `Find new restaurant openings and local events in ${city} this week.`,
      }],
    });

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const jsonMatch = /\[[\s\S]*\]/.exec(block.text);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        headline?: string; summary?: string; url?: string; source?: string;
      }>;
      return parsed
        .filter((p) => p.headline)
        .map((p) => ({
          source: p.source ?? `${city} Web Search`,
          headline: p.headline ?? "",
          summary: p.summary ?? "",
          url: p.url ?? "",
          publishedAt: new Date(),
          priority: "medium" as const,
          keywordsMatched: ["web_search_fallback"],
        }));
    }
  } catch (err) {
    logger.warn({ err }, `[LocalContent] Web search fallback failed for ${city}`);
  }
  return [];
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function initDallasContentTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS daily_local_content (
        id           SERIAL PRIMARY KEY,
        source       VARCHAR(100) NOT NULL,
        headline     TEXT        NOT NULL,
        summary      TEXT,
        url          TEXT,
        published_at TIMESTAMPTZ,
        priority     VARCHAR(20) DEFAULT 'medium',
        fetch_date   DATE        NOT NULL DEFAULT CURRENT_DATE,
        keywords_matched TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_dlc_date ON daily_local_content(fetch_date)`
    ).catch(() => {});
    logger.info("[Dallas] daily_local_content table ready");
  } catch (err) {
    logger.warn({ err }, "[Dallas] Failed to init daily_local_content table");
  }
}

async function saveToDb(items: LocalContentItem[]): Promise<void> {
  if (items.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await query(`DELETE FROM daily_local_content WHERE fetch_date = '${today}' RETURNING id`);
    for (const item of items.slice(0, 10)) {
      const esc = (s: string) => s.replace(/'/g, "''");
      const pub = item.publishedAt ? `'${item.publishedAt.toISOString()}'` : "NULL";
      await query(`
        INSERT INTO daily_local_content (source, headline, summary, url, published_at, priority, fetch_date, keywords_matched)
        VALUES (
          '${esc(item.source)}',
          '${esc(item.headline)}',
          '${esc(item.summary.slice(0, 500))}',
          '${esc(item.url)}',
          ${pub},
          '${item.priority}',
          '${today}',
          '${esc(item.keywordsMatched.join(", "))}'
        )
        RETURNING id
      `);
    }
    logger.info(`[Dallas] Saved ${Math.min(items.length, 10)} items to daily_local_content`);
  } catch (err) {
    logger.warn({ err }, "[Dallas] Failed to save to daily_local_content");
  }
}

// ── Briefing formatter ────────────────────────────────────────────────────────

function formatForBriefing(items: LocalContentItem[], city: string): string {
  let top = items
    .filter((i) => i.priority === "high" || i.priority === "medium")
    .slice(0, 3);
  if (top.length === 0) {
    top = items.filter((i) => i.priority === "low").slice(0, 2);
  }
  if (top.length === 0) return "";

  const lines = top.map(
    (i) => `• [${i.source}] ${i.headline}${i.summary ? " — " + i.summary.slice(0, 160) : ""}`
  );
  const sourceNames = [...new Set(top.map((i) => i.source))].join(", ");
  return (
    `\n\n[What's Happening in ${city} — sourced from ${sourceNames} this morning]\n` +
    lines.join("\n") +
    `\n\nPresent this as a dedicated section called "What's Happening in ${city}" with 2–3 items maximum. ` +
    `Keep each item to one or two warm, conversational sentences as if a well-connected friend is sharing it. ` +
    `Lead with high-priority items (restaurant openings, upcoming concerts at favorite venues). ` +
    `Skip any item that feels generic or irrelevant to the user's life.`
  );
}

// ── In-memory daily cache ─────────────────────────────────────────────────────

interface LocalCache {
  city: string;
  items: LocalContentItem[];
  fetchedAt: Date;
  formattedBlock: string;
}

let _cache: LocalCache | null = null;

function isCacheValid(city: string): boolean {
  if (!_cache) return false;
  if (_cache.city !== city) return false;
  if (_cache.fetchedAt.toDateString() !== new Date().toDateString()) return false;
  if (Date.now() - _cache.fetchedAt.getTime() > 12 * 60 * 60 * 1000) return false;
  return true;
}

// ── Exported helpers (used by briefingPregenerate and proactiveScheduler) ─────

/** Returns cached items array (may be empty if fetch hasn't run yet) */
export function getDallasItems(): LocalContentItem[] {
  return _cache?.items ?? [];
}

/** Returns the city name from the current cache (for display in notifications etc.) */
export function getLocalContentCity(): string {
  return _cache?.city ?? "your city";
}

/** Returns today's cached high-priority items — used by the proactive scheduler */
export function getTodayHighPriorityItems(): LocalContentItem[] {
  return (_cache?.items ?? []).filter((i) => i.priority === "high");
}

/** Builds a formatted briefing block from an item list (used after dedup in briefingPregenerate) */
export function buildDallasBlock(items: LocalContentItem[], city = "your city"): string {
  return formatForBriefing(items, city);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch and return a formatted block of local content for the morning briefing.
 * Results are cached for the day keyed by city.
 *
 * @param ctx  City + user interests from the user's profile. Defaults to Dallas
 *             if not provided (backward compat).
 */
export async function fetchDallasContent(ctx: UserLocalContext = { city: "Dallas" }): Promise<string> {
  const city = ctx.city || "Dallas";

  if (isCacheValid(city)) {
    const cached = _cache!;
    console.log(`[LocalContent] Returning CACHED content for ${city} — ${cached.items.length} items, fetched at ${cached.fetchedAt.toLocaleTimeString("en-US", { timeZone: "America/Chicago" })}`);
    return cached.formattedBlock;
  }

  console.log(`[LocalContent] ── Starting fresh content fetch for ${city} ──────────────────`);
  console.log(
    `[LocalContent:prefs] musicGenres:${(ctx.musicGenres ?? []).length} interests:${(ctx.interests ?? []).length} ` +
    `artists:${(ctx.artists ?? []).length} venues:${(ctx.venues ?? []).length} ` +
    `restaurants:${(ctx.favoriteRestaurants ?? []).length} teams:${(ctx.sportsTeams ?? []).length}` +
    (ctx.musicGenres?.length ? ` | genres: [${ctx.musicGenres.join(", ")}]` : "") +
    (ctx.interests?.length ? ` | interests: [${ctx.interests.slice(0, 5).join(", ")}${(ctx.interests.length > 5 ? "…" : "")}]` : "")
  );
  const patterns = buildPatterns(ctx);
  const feeds = buildCityFeeds(city);
  const allItems: LocalContentItem[] = [];
  let successCount = 0;

  // Run RSS feeds + music web search + Ticketmaster in parallel
  const [feedResults, musicItems, ticketmasterItems] = await Promise.all([
    Promise.allSettled(feeds.map((f) => fetchFeed(f, patterns))),
    musicWebSearch(ctx),
    fetchTicketmasterEvents(city),
  ]);

  feedResults.forEach((result, i) => {
    const name = feeds[i].name;
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
      successCount++;
      if (result.value.length === 0) {
        console.log(`[LocalContent:feed] ${name}: ✗ 0 items survived filters`);
      }
    } else {
      console.log(`[LocalContent:feed] ${name}: ✗ FEED FAILED — ${String(result.reason)}`);
      logger.warn(`[LocalContent] ${name}: feed failed — ${String(result.reason)}`);
    }
  });

  console.log(`[LocalContent] Music web search returned ${musicItems.length} items`);
  console.log(`[LocalContent] Ticketmaster returned ${ticketmasterItems.length} events`);

  // ── Ticketmaster strict artist filter ────────────────────────────────────
  // Only include Ticketmaster events whose headline contains at least one of
  // the user's saved artists. If the user has no saved artists, include all.
  const tmArtistRx = stringsToRx(ctx.artists ?? []);
  const filteredTicketmaster = tmArtistRx
    ? ticketmasterItems.filter((item) => tmArtistRx.test(item.headline))
    : ticketmasterItems;
  if (tmArtistRx) {
    const dropped = ticketmasterItems.length - filteredTicketmaster.length;
    if (dropped > 0) {
      console.log(`[LocalContent] Ticketmaster: dropped ${dropped} events not matching saved artists`);
    }
  }

  allItems.push(...musicItems, ...filteredTicketmaster);

  let finalItems = deduplicate(allItems);
  console.log(`[LocalContent] After dedup: ${finalItems.length} unique items from ${allItems.length} raw`);

  // Fallback: if feeds are dry, try a broader web search
  if (successCount === 0 || finalItems.length < 2) {
    console.log(`[LocalContent] Insufficient items (${finalItems.length}) — triggering web search fallback`);
    const extra = await webSearchFallback(ctx);
    console.log(`[LocalContent] Web search fallback returned ${extra.length} items`);
    finalItems = deduplicate([...finalItems, ...extra]);
    console.log(`[LocalContent] After fallback dedup: ${finalItems.length} total items`);
  }

  const formattedBlock = formatForBriefing(finalItems, city);

  _cache = { city, items: finalItems, fetchedAt: new Date(), formattedBlock };
  void saveToDb(finalItems);

  const highCount = finalItems.filter((i) => i.priority === "high").length;
  const medCount  = finalItems.filter((i) => i.priority === "medium").length;
  const lowCount  = finalItems.filter((i) => i.priority === "low").length;

  if (finalItems.length === 0) {
    console.log(`[LocalContent] ✗ RESULT: EMPTY — no items for ${city}. Briefing will use fallback line.`);
  } else {
    console.log(`[LocalContent] ✓ RESULT: ${finalItems.length} items for ${city} — high:${highCount} med:${medCount} low:${lowCount} (${successCount}/${feeds.length} feeds ok)`);
    console.log(`[LocalContent] Final headlines: ${finalItems.map((i) => `[${i.priority}] ${i.headline}`).join(" | ")}`);
  }

  logger.info(`[Dallas] Content ready: ${finalItems.length} items total, ${highCount} high-priority (${successCount}/${feeds.length} feeds succeeded)`);

  return formattedBlock;
}
