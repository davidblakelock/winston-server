/**
 * Apify News Manager
 *
 * Scrapes Reuters and AP News via Apify actors to provide raw headlines
 * for the morning briefing. Claude then reads and curates the output.
 *
 * Actor IDs used:
 *   Reuters:            epctex/reuters-scraper
 *   AP News:            epctex/apnews-scraper
 *   Reuters Oddly Enough: epctex/reuters-scraper  (category filter)
 */

import { logger } from "../lib/logger.js";

function getApifyKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }
export function isApifyNewsConfigured(): boolean { return !!getApifyKey(); }

const REUTERS_ACTOR_ID = "epctex/reuters-scraper";
const APNEWS_ACTOR_ID  = "epctex/apnews-scraper";

// ── Generic sync runner ───────────────────────────────────────────────────────

async function runActor(
  actorId:    string,
  input:      Record<string, unknown>,
  timeoutSec  = 80,
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
      const body = await res.text().catch(() => "");
      logger.warn({ actorId, status: res.status, body: body.slice(0, 200) }, "[ApifyNews] Actor run non-OK");
      return [];
    }

    const data = await res.json() as unknown;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  } catch (err) {
    logger.warn({ err, actorId }, "[ApifyNews] Actor request threw");
    return [];
  }
}

// ── Normalised article type ───────────────────────────────────────────────────

export interface ScrapedArticle {
  title:       string;
  description: string;
  url:         string;
  publishedAt: string;
  source:      string;
}

function normalise(
  items:  Array<Record<string, unknown>>,
  source: string,
): ScrapedArticle[] {
  return items
    .map((item) => ({
      title:       String(item["title"]       ?? item["headline"]    ?? item["name"]    ?? ""),
      description: String(item["description"] ?? item["body"]        ?? item["text"]    ?? item["summary"] ?? item["lead"] ?? ""),
      url:         String(item["url"]         ?? item["link"]        ?? item["pageUrl"] ?? ""),
      publishedAt: String(item["datePublished"] ?? item["publishedAt"] ?? item["date"] ?? item["pubDate"] ?? ""),
      source,
    }))
    .filter((a) => a.title.length > 5);
}

// ── Reuters top news ──────────────────────────────────────────────────────────

export async function fetchReutersHeadlines(maxItems = 25): Promise<ScrapedArticle[]> {
  const items = await runActor(REUTERS_ACTOR_ID, {
    startUrls:          [{ url: "https://www.reuters.com/" }],
    maxItems,
    includeDescription: true,
  });
  logger.info({ count: items.length }, "[ApifyNews] Reuters top news fetched");
  return normalise(items, "Reuters");
}

// ── AP News top stories ───────────────────────────────────────────────────────

export async function fetchAPNewsHeadlines(maxItems = 25): Promise<ScrapedArticle[]> {
  const items = await runActor(APNEWS_ACTOR_ID, {
    startUrls:          [{ url: "https://apnews.com/" }],
    maxItems,
    includeDescription: true,
  });
  logger.info({ count: items.length }, "[ApifyNews] AP News top stories fetched");
  return normalise(items, "AP News");
}

// ── Reuters Oddly Enough (feel-good / bizarre stories) ───────────────────────

export async function fetchReutersOddlyEnough(maxItems = 12): Promise<ScrapedArticle[]> {
  const items = await runActor(REUTERS_ACTOR_ID, {
    startUrls:          [{ url: "https://www.reuters.com/oddly-enough/" }],
    maxItems,
    includeDescription: true,
  });
  logger.info({ count: items.length }, "[ApifyNews] Reuters Oddly Enough fetched");
  return normalise(items, "Reuters Oddly Enough");
}

// ── AP Oddities (feel-good fallback) ─────────────────────────────────────────

export async function fetchAPOddities(maxItems = 12): Promise<ScrapedArticle[]> {
  const items = await runActor(APNEWS_ACTOR_ID, {
    startUrls:          [{ url: "https://apnews.com/oddities" }],
    maxItems,
    includeDescription: true,
  });
  logger.info({ count: items.length }, "[ApifyNews] AP Oddities fetched");
  return normalise(items, "AP Oddities");
}

// ── Format helpers ────────────────────────────────────────────────────────────

/** Build a numbered headline list for Claude to read, with brief description. */
export function formatArticlesForClaude(
  articles: ScrapedArticle[],
  label:    string,
  limit     = 15,
): string {
  if (articles.length === 0) return "";
  const lines = articles.slice(0, limit).map((a, i) => {
    const desc = a.description ? ` — ${a.description.slice(0, 120).trim()}` : "";
    return `${i + 1}. [${a.source}] ${a.title}${desc}`;
  });
  return `[${label}]\n${lines.join("\n")}`;
}

/** Extract just the titles (used for midday dedup comparison). */
export function extractTitles(articles: ScrapedArticle[]): string[] {
  return articles.map((a) => a.title).filter((t) => t.length > 5);
}
