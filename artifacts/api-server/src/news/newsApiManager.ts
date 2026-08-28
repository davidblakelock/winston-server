/**
 * NewsAPI.org Integration
 *
 * Fetches real-time headlines from AP and BBC via NewsAPI.org.
 * Free tier: 100 requests/day — sufficient for one morning briefing + midday check per day.
 *
 * Required env var: NEWS_API_KEY
 * Get a free key at https://newsapi.org
 *
 * Source IDs were wrong for a long time and nobody noticed because the
 * failure is silent: "reuters" does not exist in NewsAPI's source catalog
 * at all (confirmed live against /v2/top-headlines/sources — no source with
 * that id, or with "reuters" in it, is offered even on paid tiers), and
 * "the-associated-press" should be "associated-press". A request with bad
 * source ids doesn't error — it just returns status "ok" with zero
 * articles, which looks identical to "quiet news day" everywhere downstream
 * (fetchNewsApiHeadlines logs count=0 same as a real empty result, and the
 * caller just sees no headlines and skips). Swapped in "bbc-news" as the
 * second source to restore real two-wire-service coverage now that Reuters
 * itself isn't available through this API.
 *
 * API: https://newsapi.org/v2/top-headlines?sources=associated-press,bbc-news&pageSize=30
 */

import { logger } from "../lib/logger.js";

const NEWSAPI_BASE = "https://newsapi.org/v2";

function getNewsApiKey(): string { return (process.env.NEWS_API_KEY ?? "").trim(); }
export function isNewsApiConfigured(): boolean { return !!getNewsApiKey(); }

// ── Normalised article type ───────────────────────────────────────────────────

export interface ScrapedArticle {
  title:       string;
  description: string;
  url:         string;
  publishedAt: string;
  source:      string;
}

// Hours-level granularity, not recencyLabel's (memorySourceAdapters.ts)
// day-level "today"/"yesterday" — breaking-news judgment needs to tell a
// story from 2 hours ago apart from one sitting in top-headlines from 20+
// hours ago, both of which "today" would call the same thing.
function hoursAgoLabel(publishedAt: string): string {
  const hoursAgo = (Date.now() - new Date(publishedAt).getTime()) / 3_600_000;
  if (hoursAgo < 1) return "<1h ago";
  if (hoursAgo < 24) return `${Math.floor(hoursAgo)}h ago`;
  return `${Math.floor(hoursAgo / 24)}d ago`;
}

/**
 * Numbered headline list for Claude to read, with brief description and
 * publish recency if available.
 *
 * The recency label was missing entirely until confirmed live as the cause
 * of a real false alarm: NewsAPI's "top-headlines" endpoint is not a "just
 * broke" feed — it returns whatever's currently prominent, which routinely
 * includes a story from a day or more ago that's still sitting in rotation
 * (a celebrity death, an ongoing story getting follow-up coverage). Without
 * a timestamp in what Claude actually reads, it has no way to tell "this
 * just happened" apart from "this is still trending from yesterday" — it
 * can only judge importance, never recency, because recency was never shown
 * to it. Confirmed live: Tim Curry's death, reported by BBC 33 hours before
 * a "breaking news" push fired for it — the article was genuinely
 * important, just not remotely new by the time it got flagged.
 */
export function formatArticlesForClaude(
  articles: ScrapedArticle[],
  label:    string,
  limit     = 20,
): string {
  if (articles.length === 0) return "";
  const lines = articles.slice(0, limit).map((a, i) => {
    const desc = a.description ? ` — ${a.description.slice(0, 100).trim()}` : "";
    const when = a.publishedAt ? ` (${hoursAgoLabel(a.publishedAt)})` : "";
    return `${i + 1}. [${a.source}]${when} ${a.title}${desc}`;
  });
  return `[${label}]\n${lines.join("\n")}`;
}

/**
 * Fetch top headlines from AP + BBC News via NewsAPI.org.
 * Returns normalized ScrapedArticle objects compatible with the rest of the news pipeline.
 * Sources: associated-press, bbc-news (both confirmed valid and available on the free tier).
 */
export async function fetchNewsApiHeadlines(
  sources  = "associated-press,bbc-news",
  pageSize = 30,
): Promise<ScrapedArticle[]> {
  const apiKey = getNewsApiKey();
  if (!apiKey) return [];

  const url =
    `${NEWSAPI_BASE}/top-headlines` +
    `?sources=${encodeURIComponent(sources)}` +
    `&pageSize=${pageSize}` +
    `&apiKey=${apiKey}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "WinstonAI/1.0 morning-briefing" },
      signal:  AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 300) }, "[NewsAPI] Non-OK response");
      return [];
    }

    const data = await res.json() as {
      status:       string;
      totalResults: number;
      articles: Array<{
        title:       string;
        description: string | null;
        url:         string;
        publishedAt: string;
        source:      { id: string | null; name: string };
        author:      string | null;
        content:     string | null;
      }>;
    };

    if (data.status !== "ok" || !Array.isArray(data.articles)) {
      logger.warn({ status: data.status }, "[NewsAPI] Unexpected response status");
      return [];
    }
    // A bad/nonexistent source id doesn't error — it returns status "ok"
    // with zero results, indistinguishable downstream from a genuinely
    // quiet news moment. That silence is exactly how the wrong "reuters"
    // source id went unnoticed for a long time. Warn (not just info) so a
    // future source-id mistake is loud instead of silent.
    if (data.totalResults === 0) {
      logger.warn({ sources, totalResults: data.totalResults }, "[NewsAPI] Zero results — check the source ids are still valid, not just that today is quiet");
    }

    const articles = data.articles
      .filter((a) => a.title && a.title !== "[Removed]" && a.url)
      .map((a) => ({
        title:       a.title,
        description: a.description ?? a.content?.slice(0, 150) ?? "",
        url:         a.url,
        publishedAt: a.publishedAt,
        source:      a.source.name,
      }));

    logger.info({ count: articles.length, sources }, "[NewsAPI] Headlines fetched");
    return articles;
  } catch (err) {
    logger.warn({ err }, "[NewsAPI] Fetch threw");
    return [];
  }
}
