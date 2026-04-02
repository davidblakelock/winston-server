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

function isCacheFresh(): boolean {
  if (!_cache) return false;
  return Date.now() - _cache.fetchedAt.getTime() < CACHE_TTL_MS;
}

// ── Core fetch (calls Claude with web_search) ────────────────────────────────

async function fetchNewsFromClaude(): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();

  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Concise prompt — fewer search directives means fewer web_search calls = faster
  const prompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating the morning news for David Blakelock in Dallas, Texas. Use web search to find real, current news. RECENCY IS CRITICAL — every story must be from ${todayStr} or ${yesterdayStr} only. Do not use stories older than 48 hours. If a search returns old results, search again with "today" or "this week" added to the query. Target 10 total stories. USA Today brevity, Wall Street Journal relevance.

STORY FORMAT — strictly 3 sentences max per story:
• Sentence 1: What happened. Plain, crisp, specific (scores, percentages, names, dates).
• Sentence 2: Why it matters to David — his portfolio (heavy in tech/AI/energy), his teams (Rangers, Cowboys, Mavericks), the AI space he works in, or Dallas/Texas impact.
• Sentence 3 (optional): What to watch next, or one concrete detail that adds real context.

Search for and organize into three tiers:

TIER 1 — HARD NEWS (4 stories, required):
Search specifically for news from ${todayStr} and ${yesterdayStr}:
- Texas Rangers game result ${yesterdayStr} (score, key moments — skip if no game)
- US stock market performance ${yesterdayStr} — S&P 500, Nasdaq, what sectors moved and why
- Major US or global political developments in the past 24 hours
- Top AI or tech news from the past 48 hours (OpenAI, Anthropic, Google, Apple, major launches or funding)
Pick the 4 most significant and current. If Rangers didn't play, replace with another strong story.

TIER 2 — CULTURAL (2 stories, required):
Search for news from ${todayStr} and ${yesterdayStr}: notable celebrity or public figure death, major entertainment or sports moment. Find 2 genuinely notable current stories.

TIER 3 — LIGHT & SURPRISING (4 stories, required):
Search for stories from the past 48 hours that are surprising, funny, fascinating, or just make you say "huh, really?" — weird science findings, bizarre world records, unexpected animal behavior, odd human achievements, quirky studies. Must be 4 stories. These are not optional.

Output in EXACTLY this format (bullet points, no extra commentary):

TIER1:
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]

TIER2:
• [story — max 3 sentences]
• [story — max 3 sentences]

TIER3:
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]

Only report real stories you found and verified are current. Never invent or embellish. If you cannot find 4 Tier 3 stories from the past 48 hours, search more broadly — they are out there.`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 3000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Empty response from Claude news search");
  logger.info({ chars: text.length }, "Morning news fetched via web search");
  return formatNewsBlock(text);
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
 * Returns cached content instantly if available; otherwise fetches with a 45s timeout.
 */
export async function fetchMorningNews(): Promise<string> {
  // Fast path: serve from cache (pre-fetched at 5:50 AM)
  if (isCacheFresh() && _cache) {
    logger.info({ chars: _cache.content.length }, "Morning news served from cache");
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

function formatNewsBlock(rawText: string): string {
  // Flexible regex — matches "TIER1:", "TIER 1:", "TIER 1 —", etc.
  const tier1Match = rawText.match(/TIER\s*1[\s:—]*([\s\S]*?)(?=TIER\s*2[\s:—]|$)/i);
  const tier2Match = rawText.match(/TIER\s*2[\s:—]*([\s\S]*?)(?=TIER\s*3[\s:—]|$)/i);
  const tier3Match = rawText.match(/TIER\s*3[\s:—]*([\s\S]*?)$/i);

  const tier1 = tier1Match?.[1]?.trim() ?? "";
  const tier2 = tier2Match?.[1]?.trim() ?? "";
  const tier3 = tier3Match?.[1]?.trim() ?? "";

  const sections: string[] = [];
  if (tier1) sections.push(`[Main Stories]\n${tier1}`);
  if (tier2 && !/no notable|none found/i.test(tier2)) {
    sections.push(`[Also Worth Knowing]\n${tier2}`);
  }
  if (tier3) sections.push(`[Light & Surprising Stories]\n${tier3}`);

  // If regex still finds nothing, fall back to including the raw text as-is
  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[Morning News — web-searched this morning, real stories from past 24-48 hours]\n` +
    body +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver all stories as one fast-moving conversational sweep — no section headers, no tier labels, no "in other news" ever. USA Today brevity, WSJ relevance. Move briskly with short natural transitions ("also —", "meanwhile —", "oh, and —"). Never linger. Lead with the most important hard news. For the light and surprising stories, introduce them naturally with something like "and here are a couple of things that'll make you smile" or "oh, and a few good ones to share later" — then deliver all of them just as briskly, one after another. Do not say "pickleball." Do not elaborate beyond what is written. Goal: David feels comprehensively informed, not deeply briefed on two stories.`
  );
}
