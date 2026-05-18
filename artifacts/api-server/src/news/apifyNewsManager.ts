/**
 * Apify News Manager
 *
 * Fetches real, current headlines via two working Apify actors:
 *
 *   AP News top stories:    nexgendata/ap-news-scraper
 *   General / world news:   scrapeio/google-news-scraper  (queries: Reuters, BBC, NYT)
 *   Watercooler (odd news): scrapeio/google-news-scraper  (query: bizarre/feel-good)
 *
 * The "Reuters scraper" actors on the Apify store (epctex, xtracto, dadhalfdev)
 * were all tested on 2026-05-13 and either returned 404 or 0 items. Google News
 * is used as the world-news feed instead — same primary sources, more reliable.
 */

import { logger } from "../lib/logger.js";
import { claimActorRun } from "../lib/apifyCache.js";

function getApifyKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }
export function isApifyNewsConfigured(): boolean { return !!getApifyKey(); }

const ACTOR_LOCK_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours — hard daily cap per actor

// ── Validated actor IDs (tested 2026-05-13) ───────────────────────────────────
const APNEWS_ACTOR_ID      = "nexgendata/ap-news-scraper";
const GOOGLENEWS_ACTOR_ID  = "scrapeio/google-news-scraper";

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
      signal:  AbortSignal.timeout((timeoutSec + 10) * 1000),
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

/**
 * Normalise raw items from either actor.
 *
 * nexgendata/ap-news-scraper fields:  title, url, source, scrapedAt
 * scrapeio/google-news-scraper fields: title, link, articleUrl, pubDate,
 *                                      sourceName, description
 */
function normalise(
  items:  Array<Record<string, unknown>>,
  source: string,
): ScrapedArticle[] {
  return items
    .map((item) => ({
      title:       String(item["title"]       ?? item["headline"]    ?? item["name"]      ?? ""),
      description: String(item["description"] ?? item["text"]        ?? item["body"]      ?? item["excerpt"] ?? item["lead"] ?? ""),
      url:         String(item["url"]         ?? item["link"]        ?? item["articleUrl"] ?? ""),
      publishedAt: String(item["pubDate"]     ?? item["datePublished"] ?? item["publishedAt"] ?? item["date"] ?? item["scrapedAt"] ?? ""),
      source:      String(item["sourceName"]  ?? item["source"]      ?? source),
    }))
    .filter((a) => a.title.length > 5);
}

// ── AP News top stories ───────────────────────────────────────────────────────

/**
 * Fetches current AP News headlines via nexgendata/ap-news-scraper.
 * Returns ~20 articles; fields: title, url, source, scrapedAt.
 */
export async function fetchAPNewsHeadlines(maxItems = 25): Promise<ScrapedArticle[]> {
  const allowed = await claimActorRun("news:ap_news", ACTOR_LOCK_TTL_MS);
  if (!allowed) {
    logger.info("[ApifyNews] AP News actor blocked by 23 h DB lock — returning empty");
    return [];
  }
  const items = await runActor(APNEWS_ACTOR_ID, { maxItems }, 60);
  logger.info({ count: items.length }, "[ApifyNews] AP News headlines fetched");
  return normalise(items, "AP News");
}

// ── World news via Google News (Reuters / NYT / BBC equivalent) ───────────────

/**
 * Fetches top world news via Google News scraper.
 * Used in place of a Reuters scraper (no working Reuters actor found in Apify store).
 * Returns up to 50 articles from major sources.
 */
export async function fetchWorldNewsHeadlines(maxItems = 30): Promise<ScrapedArticle[]> {
  const allowed = await claimActorRun("news:world_news", ACTOR_LOCK_TTL_MS);
  if (!allowed) {
    logger.info("[ApifyNews] World news actor blocked by 23 h DB lock — returning empty");
    return [];
  }
  const items = await runActor(GOOGLENEWS_ACTOR_ID, {
    queries:  ["breaking world news today"],
    maxItems,
  }, 60);
  logger.info({ count: items.length }, "[ApifyNews] World news (Google News) fetched");
  return normalise(items, "Reuters/AP/NYT");
}

// ── Watercooler: bizarre / feel-good stories ──────────────────────────────────

/**
 * Fetches odd, heartwarming, or bizarre stories via Google News.
 * Used for the morning briefing watercooler segment.
 */
export async function fetchWatercoolerHeadlines(maxItems = 15): Promise<ScrapedArticle[]> {
  const allowed = await claimActorRun("news:watercooler", ACTOR_LOCK_TTL_MS);
  if (!allowed) {
    logger.info("[ApifyNews] Watercooler actor blocked by 23 h DB lock — returning empty");
    return [];
  }
  const items = await runActor(GOOGLENEWS_ACTOR_ID, {
    queries:  ["bizarre unusual heartwarming funny unexpected news today"],
    maxItems,
  }, 60);
  logger.info({ count: items.length }, "[ApifyNews] Watercooler headlines fetched");
  return normalise(items, "Google News");
}

// ── Legacy aliases kept for backward compat ───────────────────────────────────

export async function fetchReutersHeadlines(maxItems = 25): Promise<ScrapedArticle[]> {
  return fetchWorldNewsHeadlines(maxItems);
}

export async function fetchReutersOddlyEnough(maxItems = 15): Promise<ScrapedArticle[]> {
  return fetchWatercoolerHeadlines(maxItems);
}

export async function fetchAPOddities(maxItems = 15): Promise<ScrapedArticle[]> {
  return fetchWatercoolerHeadlines(maxItems);
}

// ── Format helpers ────────────────────────────────────────────────────────────

/** Numbered headline list for Claude to read, with brief description if available. */
export function formatArticlesForClaude(
  articles: ScrapedArticle[],
  label:    string,
  limit     = 20,
): string {
  if (articles.length === 0) return "";
  const lines = articles.slice(0, limit).map((a, i) => {
    const src  = a.source && a.source !== "Reuters/AP/NYT" ? ` [${a.source}]` : "";
    const desc = a.description ? ` — ${a.description.slice(0, 100).trim()}` : "";
    return `${i + 1}.${src} ${a.title}${desc}`;
  });
  return `[${label}]\n${lines.join("\n")}`;
}

/** Extract just the titles (used for midday dedup comparison). */
export function extractTitles(articles: ScrapedArticle[]): string[] {
  return articles.map((a) => a.title).filter((t) => t.length > 5);
}
