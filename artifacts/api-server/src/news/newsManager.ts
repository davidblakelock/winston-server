import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory cache ──────────────────────────────────────────────────────────
// News is pre-fetched at 5:50 AM by the morning scheduler so it's instant
// when David says "good morning." Cache valid for 6 hours.

interface NewsCache {
  content: string;
  fetchedAt: Date;
}

let _cache: NewsCache | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Warn if cached news is older than this when served
const STALE_WARN_MS = 12 * 60 * 60 * 1000; // 12 hours

function isCacheFresh(): boolean {
  if (!_cache) return false;
  return Date.now() - _cache.fetchedAt.getTime() < CACHE_TTL_MS;
}

// ── Watercooler: ONE fascinating story from the last 24h ─────────────────────
// Dedicated search focused on science, achievement, surprising human interest.
// Strictly avoids politics, crime, and tragedy.

async function fetchWatercoolerStories(): Promise<string> {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });

  const prompt =
    `Today is ${todayStr}. Use web search to find ONE genuinely fascinating, unexpected, or conversation-worthy story ` +
    `published after ${cutoffStr} — within the last 24 hours ONLY. ` +
    `\n\nFocus on: science discoveries, record-breaking achievements, fascinating human interest, ` +
    `unexpected animal behavior, surprising scientific findings, things that make people say "wait, really?" ` +
    `\n\nSTRICTLY AVOID: politics, crime, violence, tragedy, death, accidents, disasters, controversy. ` +
    `\n\nReturn EXACTLY ONE story in TWO sentences maximum. ` +
    `Sentence 1: What happened (specific, vivid, surprising). ` +
    `Sentence 2: Why it's fascinating or what makes it remarkable. ` +
    `No headers, no bullet points, no commentary — just the two sentences. ` +
    `If you cannot find a qualifying story from the last 24 hours, search for "amazing science discovery today", ` +
    `"fascinating story today", "incredible achievement today". Do not use a story older than 24 hours.`;

  console.log(`[API] Claude web_search (watercooler) — starting at ${new Date().toISOString()}`);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n").trim();

  console.log(`[API] Claude web_search (watercooler) — complete, ${text.length} chars`);
  if (!text) throw new Error("Empty watercooler response from Claude");
  return text;
}

// ── Entertainment: major deaths, upcoming releases, cultural moments ──────────

async function fetchEntertainmentNews(): Promise<string> {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });
  const in30days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const futureStr = in30days.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });

  const prompt =
    `Today is ${todayStr}. Use web search to find 2 notable entertainment or pop culture items. ` +
    `Focus exclusively on: (1) major celebrity or public figure deaths in the past 48 hours, ` +
    `(2) highly anticipated movie or TV releases opening before ${futureStr}, ` +
    `(3) major awards shows or significant cultural moments from the past 48 hours. ` +
    `\n\nEach item: ONE sentence only. Specific names, dates, and facts. ` +
    `Search terms: "celebrity death today", "movie opening this month", "awards news today", "entertainment news ${todayStr}". ` +
    `Only use stories from ${cutoffStr} or later for deaths/awards; upcoming releases can be within 30 days. ` +
    `If only 1 qualifying story exists, return only 1. If none qualify, return "NONE". ` +
    `\n\nReturn as bullet points: • [one sentence]. No headers, no tier labels.`;

  console.log(`[API] Claude web_search (entertainment) — starting at ${new Date().toISOString()}`);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n").trim();

  console.log(`[API] Claude web_search (entertainment) — complete, ${text.length} chars`);
  if (!text || /none/i.test(text)) return "";
  return text;
}

// ── Core fetch (calls Claude with web_search) ─────────────────────────────────

async function fetchNewsFromClaude(): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();

  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });

  // ── Main headlines: 6-7 punchy one-sentence headlines ────────────────────
  const mainPrompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating a morning news ticker for David Blakelock in Dallas, Texas. Use web search to find real, current news headlines. RECENCY IS CRITICAL — every headline must be from ${todayStr} or ${yesterdayStr} only. If a search returns old results, search again with "today" added to the query.

FORMAT: Return 6 to 7 headlines. Each headline is ONE sentence only — punchy, specific, and scannable. Include the key fact (number, name, outcome). No second sentence. No elaboration. Think news ticker, not news article.

David's interests: stock market, AI/tech, global politics, Texas Rangers, Dallas Cowboys, Dallas/Texas news, energy sector.

Search for fresh headlines across these categories:
- US market performance ${yesterdayStr} — S&P 500 and Nasdaq with one key data point
- Major US or global political development from the past 24 hours
- Top AI or tech news from the past 48 hours (OpenAI, Anthropic, Google, Apple)
- Texas Rangers game result ${yesterdayStr} — if no game, replace with another story
- Dallas or Texas local news from the past 24 hours
- Any other major breaking story from the past 24 hours

STALENESS RULE: Only include stories from ${todayStr} or ${yesterdayStr}. Verify recency before including.

Output in EXACTLY this format — bullet points only, one sentence each, no other text:

HEADLINES:
• [one sentence headline with key fact]
• [one sentence headline with key fact]
• [one sentence headline with key fact]
• [one sentence headline with key fact]
• [one sentence headline with key fact]
• [one sentence headline with key fact]

Only report real stories you found and verified are current. Never invent or embellish.`;

  console.log(`[API] Claude web_search (news headlines) — starting at ${new Date().toISOString()}`);

  const [mainResponse, watercoolerText, entertainmentText] = await Promise.all([
    anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: mainPrompt }],
    }),
    fetchWatercoolerStories().catch((err) => {
      logger.warn({ err }, "Watercooler fetch failed — skipping");
      return "";
    }),
    fetchEntertainmentNews().catch((err) => {
      logger.warn({ err }, "Entertainment fetch failed — skipping");
      return "";
    }),
  ]);

  const mainText = mainResponse.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n").trim();

  console.log(`[API] Claude web_search (news headlines) — complete, ${mainText.length} chars`);
  if (!mainText) throw new Error("Empty response from Claude news search");

  const combined = [
    mainText,
    entertainmentText ? `ENTERTAINMENT:\n${entertainmentText}` : "",
    watercoolerText ? `WATERCOOLER:\n${watercoolerText}` : "",
  ].filter(Boolean).join("\n\n");

  logger.info({ chars: combined.length }, "Morning news fetched via web search");
  return formatNewsBlock(combined, new Date());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pre-fetch news in the background (called at 5:50 AM by the morning scheduler).
 * Silently caches the result so `fetchMorningNews()` is instant during the briefing.
 */
export async function preFetchMorningNews(): Promise<void> {
  try {
    logger.info("Starting morning news pre-fetch");
    const content = await fetchNewsFromClaude();
    _cache = { content, fetchedAt: new Date() };
    logger.info({ chars: content.length }, "Morning news pre-fetched and cached");
  } catch (err) {
    logger.warn({ err }, "Morning news pre-fetch failed — will retry on demand");
  }
}

/**
 * Returns the morning news block for the chat prompt.
 * Returns cached content instantly if available; otherwise fetches with a 90s timeout.
 * Warns if serving stale (>12h old) cached news.
 */
export async function fetchMorningNews(): Promise<string> {
  // Fast path: serve from cache (pre-fetched at 5:50 AM)
  if (isCacheFresh() && _cache) {
    const ageMs = Date.now() - _cache.fetchedAt.getTime();
    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);

    if (ageMs > STALE_WARN_MS) {
      console.warn(`[News] Serving STALE cached news — ${ageHours}h old (fetched at ${_cache.fetchedAt.toISOString()}). Consider forcing a refresh.`);
    } else {
      logger.info({ ageHours, chars: _cache.content.length }, "Morning news served from cache");
    }
    return _cache.content;
  }

  // Slow path: fetch now, but bail if it takes more than 90 seconds
  const TIMEOUT_MS = 90_000;
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("News fetch timed out after 90s")), TIMEOUT_MS)
  );

  try {
    const content = await Promise.race([fetchNewsFromClaude(), timeout]);
    _cache = { content, fetchedAt: new Date() };
    return content;
  } catch (err) {
    logger.warn({ err }, "Morning news fetch failed or timed out — skipping news section");
    return "";
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatNewsBlock(rawText: string, fetchedAt: Date): string {
  const headlinesMatch = rawText.match(/HEADLINES[\s:—]*([\s\S]*?)(?=ENTERTAINMENT[\s:—]|WATERCOOLER[\s:—]|$)/i);
  const entertainmentMatch = rawText.match(/ENTERTAINMENT[\s:—]*([\s\S]*?)(?=WATERCOOLER[\s:—]|$)/i);
  const watercoolerMatch = rawText.match(/WATERCOOLER[\s:—]*([\s\S]*?)$/i);

  const headlines = headlinesMatch?.[1]?.trim() ?? "";
  const entertainment = entertainmentMatch?.[1]?.trim() ?? "";
  const watercooler = watercoolerMatch?.[1]?.trim() ?? "";

  const fetchedStr = fetchedAt.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
  });

  const sections: string[] = [];
  if (headlines) sections.push(`[Morning Headlines — 6-7 punchy one-sentence stories]\n${headlines}`);
  if (entertainment && !/^none$/i.test(entertainment)) {
    sections.push(`[Entertainment & Pop Culture]\n${entertainment}`);
  }
  if (watercooler) sections.push(`[Watercooler Story — one fascinating story to share]\n${watercooler}`);

  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[Morning News — web-searched at ${fetchedStr} CT, headlines from past 24-48 hours only]\n` +
    body +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver as a brisk news ticker — no headers, no tier labels, no "in other news". ` +
    `Read the [Morning Headlines] as rapid-fire one-liners with short natural transitions ("also —", "meanwhile —", "and —"). ` +
    `After the headlines, if [Entertainment & Pop Culture] has items, weave them in naturally. ` +
    `End with the [Watercooler Story] using something like "oh, and here's one to share later —". ` +
    `Never elaborate beyond what is written. Goal: David gets 6-7 punchy headlines in 60 seconds.`
  );
}
