/**
 * Dallas local content system — fetches RSS feeds from CultureMap Dallas,
 * Dallas Observer, and D Magazine, filters by David's interests and 72-hour
 * freshness, deduplicates across sources, and falls back to web search.
 *
 * Results are cached in memory for the day and persisted to daily_local_content.
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

interface RSSItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

interface FeedConfig {
  name: string;
  url: string;
}

// ── RSS feed definitions ──────────────────────────────────────────────────────

const DALLAS_FEEDS: FeedConfig[] = [
  // Dallas Observer — redirects to /feed/ (301 → 200)
  { name: "Dallas Observer", url: "https://www.dallasobserver.com/feed/" },
  // D Magazine — /feed/ returns 200
  { name: "D Magazine",      url: "https://www.dmagazine.com/feed/" },
  // Google News RSS — general Dallas events, food, arts
  { name: "Dallas News",     url: "https://news.google.com/rss/search?q=dallas+restaurant+opening+events+food+arts&hl=en-US&gl=US&ceid=US:en" },
  // Google News RSS — Dallas music events specifically (jazz, concerts, live music)
  { name: "Dallas Music News", url: "https://news.google.com/rss/search?q=dallas+jazz+concert+live+music+kessler+granada+meyerson+outdoor+concert&hl=en-US&gl=US&ceid=US:en" },
  // CultureMap Dallas — RSS endpoint unstable; kept for when they restore it
  { name: "CultureMap Dallas", url: "https://dallas.culturemap.com/rss.xml" },
];

// ── Interest patterns ─────────────────────────────────────────────────────────

const EXCLUDE_PATTERNS: RegExp[] = [
  /sponsored|advertisement|advertorial|promoted content/i,
  // Sports game results are covered by the ESPN API in Section 10 — never duplicate here
  /\b(rangers|cowboys|mavericks|dallas stars|fc dallas)\b.{0,60}(score|win|loss|beat|game recap|final|lead|inning|quarter|down \d|up \d)/i,
  /\b(score|win|loss|beat|game recap|final)\b.{0,60}\b(rangers|cowboys|mavericks|dallas stars|fc dallas)\b/i,
];

// High: new restaurants in David's neighborhoods + his music artists/venues
// Note: Rangers/Cowboys scores come from the ESPN API (Section 10) — do NOT surface sports articles here
const HIGH_PRIORITY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /new restaurant|just opened|opening|grand opening|now open/i,         label: "restaurant opening" },
  { pattern: /knox.?henderson|uptown dallas|deep ellum|bishop arts|downtown dallas/i, label: "preferred neighborhood" },
  // David's specific music artists
  { pattern: /jimmy buffett|margaritaville/i,                                      label: "Jimmy Buffett" },
  { pattern: /bonnie raitt/i,                                                      label: "Bonnie Raitt" },
  { pattern: /jackson browne/i,                                                    label: "Jackson Browne" },
  { pattern: /rolling stones|stones tribute/i,                                     label: "Rolling Stones" },
  { pattern: /gordon lightfoot/i,                                                  label: "Gordon Lightfoot" },
  { pattern: /van morrison/i,                                                      label: "Van Morrison" },
  // David's favorite venues
  { pattern: /kessler theater|granada theater|dos equis pavilion|meyerson|klyde warren/i, label: "favorite venue" },
  { pattern: /music under the stars|dallas arboretum.*concert|arboretum.*music/i, label: "Dallas Arboretum concert" },
];

// Medium: arts, food, outdoor, culture broadly + music genres David loves
const MEDIUM_PRIORITY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /restaurant|dining|chef|food festival|cocktail bar|brunch|new bar/i,  label: "food & dining" },
  { pattern: /jazz|bebop|big band|classic rock|blues/i,                            label: "jazz/classic rock" },
  { pattern: /outdoor concert|amphitheater|summer concert|concert series/i,        label: "outdoor concert" },
  { pattern: /tribute band|tribute act/i,                                          label: "tribute" },
  { pattern: /arts|concert|music|festival|exhibition|gallery|show|performance/i,   label: "arts & culture" },
  { pattern: /outdoor|park|trail|farmers market|hike/i,                            label: "outdoor" },
  { pattern: /dallas|dfw|north texas/i,                                            label: "dallas general" },
];

// Low: business / community
const LOW_PRIORITY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /real estate|development|business|economy/i,  label: "business" },
  { pattern: /neighborhood|community|local politics/i,     label: "community" },
];

// ── Lightweight RSS parser (no external packages needed) ──────────────────────

function extractTag(xml: string, tag: string): string {
  // Try CDATA block first
  const cdataRx = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i");
  const cdata = cdataRx.exec(xml);
  if (cdata) return cdata[1].trim();
  // Plain text
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
    .replace(/&#\d+;/g, " ")
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

function isWithin72Hours(dateStr: string): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= 72 * 60 * 60 * 1000;
}

// ── Priority scoring ──────────────────────────────────────────────────────────

function scoreItem(
  headline: string,
  description: string,
): { priority: "high" | "medium" | "low" | null; keywords: string[] } {
  const text = `${headline} ${description}`;

  for (const rx of EXCLUDE_PATTERNS) {
    if (rx.test(text)) return { priority: null, keywords: [] };
  }

  // High
  const highKeywords: string[] = [];
  for (const { pattern, label } of HIGH_PRIORITY_PATTERNS) {
    if (pattern.test(text)) highKeywords.push(label);
  }
  if (highKeywords.length > 0) return { priority: "high", keywords: highKeywords };

  // Medium
  const medKeywords: string[] = [];
  for (const { pattern, label } of MEDIUM_PRIORITY_PATTERNS) {
    if (pattern.test(text)) medKeywords.push(label);
  }
  if (medKeywords.length > 0) return { priority: "medium", keywords: medKeywords };

  // Low
  const lowKeywords: string[] = [];
  for (const { pattern, label } of LOW_PRIORITY_PATTERNS) {
    if (pattern.test(text)) lowKeywords.push(label);
  }
  if (lowKeywords.length > 0) return { priority: "low", keywords: lowKeywords };

  return { priority: null, keywords: [] };
}

// ── RSS feed fetcher ──────────────────────────────────────────────────────────

async function fetchFeed(feed: FeedConfig): Promise<LocalContentItem[]> {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "Winston/1.0 (personal assistant)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.url}`);
  const xml = await res.text();
  const rssItems = parseRSS(xml);

  const results: LocalContentItem[] = [];
  for (const item of rssItems.slice(0, 40)) {
    if (!isWithin72Hours(item.pubDate)) continue;
    const headline = stripHtml(item.title);
    const summary  = stripHtml(item.description).slice(0, 350);
    const { priority, keywords } = scoreItem(headline, summary);
    if (!priority) continue;
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
  return results;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicate(items: LocalContentItem[]): LocalContentItem[] {
  // Sort: high → medium → low, then newest first within each tier
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

// ── Music-specific web search (always runs, not just fallback) ────────────────

async function musicWebSearch(): Promise<LocalContentItem[]> {
  logger.info("[Dallas] Running music events web search supplement");
  try {
    const result = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 2 }],
      system: `You are a Dallas music events researcher. Search for jazz venues, outdoor concerts, and live music events in Dallas this week and next week. Focus on: Kessler Theater, Granada Theater, Dos Equis Pavilion, Jazz at the Meyerson, Klyde Warren Park, Dallas Arboretum, and any classic rock or jazz tribute bands. Return ONLY a JSON array (no markdown, no explanation) with up to 4 objects, each having: headline (string), summary (1–2 sentence string), url (string), source (string).`,
      messages: [{
        role: "user",
        content: "Search: Dallas jazz venues outdoor concerts music under the stars this week. Also: Kessler Theater Dallas events Granada Theater Dallas concerts upcoming.",
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
          source: p.source ?? "Dallas Music Search",
          headline: p.headline ?? "",
          summary: p.summary ?? "",
          url: p.url ?? "",
          publishedAt: new Date(),
          priority: "high" as const,
          keywordsMatched: ["music_web_search"],
        }));
    }
  } catch (err) {
    logger.warn({ err }, "[Dallas] Music web search failed");
  }
  return [];
}

// ── Web search fallback ───────────────────────────────────────────────────────

async function webSearchFallback(): Promise<LocalContentItem[]> {
  logger.info("[Dallas] Running web search fallback for local content");
  try {
    const result = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 3 }],
      system: `You are a Dallas local content researcher. Search for recent news (within the last 72 hours) about new restaurant openings and events in Dallas. Return ONLY a JSON array (no markdown, no explanation) with up to 3 objects, each having these fields: headline (string), summary (1–2 sentence string), url (string), source (string, e.g. "CultureMap Dallas").`,
      messages: [{
        role: "user",
        content: "Find new restaurant openings and local events in Dallas this week. Query: new restaurants events Dallas this week site:dallas.culturemap.com OR site:dallasobserver.com OR site:dmagazine.com",
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
          source: p.source ?? "Dallas Web Search",
          headline: p.headline ?? "",
          summary: p.summary ?? "",
          url: p.url ?? "",
          publishedAt: new Date(),
          priority: "medium" as const,
          keywordsMatched: ["web_search_fallback"],
        }));
    }
  } catch (err) {
    logger.warn({ err }, "[Dallas] Web search fallback failed");
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

function formatForBriefing(items: LocalContentItem[]): string {
  const top = items
    .filter((i) => i.priority === "high" || i.priority === "medium")
    .slice(0, 3);
  if (top.length === 0) return "";

  const lines = top.map(
    (i) => `• [${i.source}] ${i.headline}${i.summary ? " — " + i.summary.slice(0, 160) : ""}`
  );

  const sourceNames = [...new Set(top.map((i) => i.source))].join(", ");
  return (
    `\n\n[What's Happening in Dallas — sourced from ${sourceNames} this morning]\n` +
    lines.join("\n") +
    `\n\nPresent this as a dedicated section called "What's Happening in Dallas" with 2–3 items maximum. ` +
    `Keep each item to one or two warm, conversational sentences as if a well-connected friend is sharing it. ` +
    `Lead with high-priority items (restaurant openings in Uptown/Knox Henderson/Deep Ellum, Rangers/Cowboys news). ` +
    `Skip any item that feels generic or irrelevant to David's life.`
  );
}

// ── In-memory daily cache ─────────────────────────────────────────────────────

interface DallasCache {
  items: LocalContentItem[];
  fetchedAt: Date;
  formattedBlock: string;
}

let _cache: DallasCache | null = null;

function isCacheValid(): boolean {
  if (!_cache) return false;
  if (_cache.fetchedAt.toDateString() !== new Date().toDateString()) return false;
  if (Date.now() - _cache.fetchedAt.getTime() > 12 * 60 * 60 * 1000) return false;
  return true;
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Fetch and return a formatted block of Dallas local content for the morning briefing.
 * Results are cached for the day.
 */
export async function fetchDallasContent(): Promise<string> {
  if (isCacheValid()) {
    logger.info("[Dallas] Returning cached local content");
    return _cache!.formattedBlock;
  }

  logger.info("[Dallas] Fetching local Dallas content from RSS feeds");
  const allItems: LocalContentItem[] = [];
  let successCount = 0;

  // Run RSS feeds + dedicated music web search in parallel
  const [feedResults, musicItems] = await Promise.all([
    Promise.allSettled(DALLAS_FEEDS.map((f) => fetchFeed(f))),
    musicWebSearch(),
  ]);

  feedResults.forEach((result, i) => {
    const name = DALLAS_FEEDS[i].name;
    if (result.status === "fulfilled") {
      logger.info(`[Dallas] ${name}: ${result.value.length} relevant items within 72h`);
      allItems.push(...result.value);
      successCount++;
    } else {
      logger.warn(`[Dallas] ${name}: feed failed — ${String(result.reason)}`);
    }
  });
  allItems.push(...musicItems);
  logger.info(`[Dallas] Music web search: ${musicItems.length} items`);

  let finalItems = deduplicate(allItems);

  // Fallback: if all feeds failed or we have fewer than 2 items, try web search
  if (successCount === 0 || finalItems.length < 2) {
    logger.info("[Dallas] RSS insufficient — running web search fallback");
    const extra = await webSearchFallback();
    finalItems = deduplicate([...finalItems, ...extra]);
  }

  // Skip section entirely if still nothing usable
  const formattedBlock = formatForBriefing(finalItems);

  _cache = { items: finalItems, fetchedAt: new Date(), formattedBlock };

  // Save to DB asynchronously — don't block the briefing
  void saveToDb(finalItems);

  const highCount = finalItems.filter((i) => i.priority === "high").length;
  logger.info(
    `[Dallas] Content ready: ${finalItems.length} items total, ${highCount} high-priority ` +
    `(${successCount}/${DALLAS_FEEDS.length} feeds succeeded)`
  );

  return formattedBlock;
}

/**
 * Return today's high-priority items for proactive notifications.
 * Triggers a fetch if the cache is stale.
 */
export async function getTodayHighPriorityItems(): Promise<LocalContentItem[]> {
  if (!isCacheValid()) await fetchDallasContent();
  return _cache?.items.filter((i) => i.priority === "high") ?? [];
}
