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
  /** Food/dining interests */
  foodInterests?: string[];
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

// ── Dynamic interest patterns (built from user profile) ───────────────────────

interface PriorityPattern { pattern: RegExp; label: string }

function buildPatterns(ctx: UserLocalContext): {
  exclude: RegExp[];
  high: PriorityPattern[];
  medium: PriorityPattern[];
  low: PriorityPattern[];
} {
  const city = ctx.city;
  const citySlug = city.replace(/[^a-z0-9]/gi, "").toLowerCase();

  // ── Exclude ────────────────────────────────────────────────────────────────
  const exclude: RegExp[] = [
    /sponsored|advertisement|advertorial|promoted content/i,
    // Sports game-result scores are covered by ESPN — avoid duplication
    /\b(score|win|loss|beat|game recap|final|inning|quarter)\b.{0,60}\b(nfl|nba|mlb|nhl|mls)\b/i,
  ];

  // ── High priority ─────────────────────────────────────────────────────────
  const high: PriorityPattern[] = [
    { pattern: /new restaurant|just opened|grand opening|opening soon|now open/i, label: "restaurant opening" },
  ];

  // Favorite venues from profile
  if (ctx.venues && ctx.venues.length > 0) {
    const venueRx = new RegExp(
      ctx.venues.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i"
    );
    high.push({ pattern: venueRx, label: "favorite venue" });
  }

  // Favorite artists from profile
  if (ctx.artists && ctx.artists.length > 0) {
    const artistRx = new RegExp(
      ctx.artists.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i"
    );
    high.push({ pattern: artistRx, label: "favorite artist" });
  }

  // Preferred neighborhoods from profile
  if (ctx.neighborhoods && ctx.neighborhoods.length > 0) {
    const hoodRx = new RegExp(
      ctx.neighborhoods.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i"
    );
    high.push({ pattern: hoodRx, label: "preferred neighborhood" });
  }

  // ── Medium priority ───────────────────────────────────────────────────────
  const medium: PriorityPattern[] = [
    { pattern: /restaurant|dining|chef|food festival|cocktail bar|brunch|new bar/i, label: "food & dining" },
    { pattern: /jazz|bebop|big band|classic rock|blues|live music/i,                label: "jazz & classic rock" },
    { pattern: /outdoor concert|amphitheater|summer concert|concert series/i,       label: "outdoor concert" },
    { pattern: /tribute band|tribute act/i,                                         label: "tribute" },
    { pattern: /arts|concert|music|festival|exhibition|gallery|show|performance/i,  label: "arts & culture" },
    { pattern: /outdoor|park|trail|farmers market|hike/i,                           label: "outdoor" },
    // City name match — everything local qualifies as at least medium
    { pattern: new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),        label: "city local" },
  ];

  // Food interests from profile add medium boosts
  if (ctx.foodInterests && ctx.foodInterests.length > 0) {
    const foodRx = new RegExp(
      ctx.foodInterests.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i"
    );
    medium.push({ pattern: foodRx, label: "food preference" });
  }

  // ── Low priority ──────────────────────────────────────────────────────────
  const low: PriorityPattern[] = [
    { pattern: /real estate|development|business|economy/i, label: "business" },
    { pattern: /neighborhood|community|local politics/i,    label: "community" },
  ];

  return { exclude, high, medium, low };
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
  logger.info(`[LocalContent] Running music events web search for ${city}`);
  try {
    const result = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 2 }],
      system: `You are a local music events researcher for ${city}. Search for upcoming jazz, outdoor concerts, and live music events in ${city} this week and next week. Focus on venues such as: ${venueHints}. Return ONLY a JSON array (no markdown, no explanation) with up to 4 objects, each having: headline (string), summary (1–2 sentence string), url (string), source (string).`,
      messages: [{
        role: "user",
        content: `Search: ${city} live music concerts this week. Also: ${venueHints} upcoming events concerts.`,
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
      model: "claude-opus-4-5",
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
    await query(`DELETE FROM daily_local_content WHERE fetch_date = '${today}'`);
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
  allItems.push(...musicItems, ...ticketmasterItems);

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
