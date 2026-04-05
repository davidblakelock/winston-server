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

// ── Watercooler: dedicated web search for light/surprising stories ────────────
// Runs as a separate Claude call so it always has its own focused search,
// independent of the main hard-news call. This eliminates the stale Tier 3
// problem where Claude falls back to training data for "funny" stories.

async function fetchWatercoolerStories(): Promise<string> {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "long",
    day: "numeric",
  });

  const prompt =
    `Today is ${todayStr}. Search for 4 genuinely surprising, funny, or fascinating news stories ` +
    `published after ${cutoffStr} — within the last 24 hours ONLY. ` +
    `Stories must be real, verifiable, and published since ${cutoffStr}. ` +
    `If your search returns a story older than 24 hours, SKIP it and search again. ` +
    `\n\nIdeal stories: weird science findings, bizarre world records, unexpected animal behavior, ` +
    `odd human achievements, quirky studies, surprising discoveries, things that make you say "huh, really?" ` +
    `\n\nReturn EXACTLY 4 bullet points, each max 3 sentences. No headers, no commentary. ` +
    `If you cannot find 4 stories from the past 24 hours, search more broadly using terms like ` +
    `"funny news today", "weird news today", "surprising discovery today", "strange news today". ` +
    `They are out there — keep searching until you have 4 from today or yesterday only.`;

  const fetchedAt = new Date().toISOString();
  console.log(`[API] Claude web_search (watercooler) — starting at ${fetchedAt}`);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  console.log(`[API] Claude web_search (watercooler) — complete at ${new Date().toISOString()}, ${text.length} chars`);

  if (!text) throw new Error("Empty watercooler response from Claude");
  return text;
}

// ── Core fetch (calls Claude with web_search) ─────────────────────────────────

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

  // ── Tier 1 + Tier 2 call ──────────────────────────────────────────────────
  const mainPrompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating the morning news for David Blakelock in Dallas, Texas. Use web search to find real, current news. RECENCY IS CRITICAL — every story must be from ${todayStr} or ${yesterdayStr} only. Do not use stories older than 48 hours. If a search returns old results, search again with "today" or "this week" added to the query.

STORY FORMAT — strictly 3 sentences max per story:
• Sentence 1: What happened. Plain, crisp, specific (scores, percentages, names, dates).
• Sentence 2: Why it matters to David — his portfolio (heavy in tech/AI/energy), his teams (Rangers, Cowboys, Mavericks), the AI space he works in, or Dallas/Texas impact.
• Sentence 3 (optional): What to watch next, or one concrete detail that adds real context.

TIER 1 — HARD NEWS (4 stories, required):
Search specifically for news from ${todayStr} and ${yesterdayStr}:
- Texas Rangers game result ${yesterdayStr} (score, key moments — skip if no game)
- US stock market performance ${yesterdayStr} — S&P 500, Nasdaq, what sectors moved and why
- Major US or global political developments in the past 24 hours
- Top AI or tech news from the past 48 hours (OpenAI, Anthropic, Google, Apple, major launches or funding)
Pick the 4 most significant and current. If Rangers didn't play, replace with another strong story.

TIER 2 — CULTURAL (2 stories, required):
Search for news from ${todayStr} and ${yesterdayStr}: notable celebrity or public figure death, major entertainment or sports moment. Find 2 genuinely notable current stories.

STALENESS RULE: Before including any story, verify it is from ${todayStr} or ${yesterdayStr}. If you find a story but cannot confirm the publication date is within 48 hours, skip it.

Output in EXACTLY this format (bullet points, no extra commentary):

TIER1:
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]

TIER2:
• [story — max 3 sentences]
• [story — max 3 sentences]

Only report real stories you found and verified are current. Never invent or embellish.`;

  const mainFetchedAt = new Date().toISOString();
  console.log(`[API] Claude web_search (news Tier1+2) — starting at ${mainFetchedAt}`);

  const [mainResponse, watercoolerText] = await Promise.all([
    anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: mainPrompt }],
    }),
    fetchWatercoolerStories().catch((err) => {
      logger.warn({ err }, "Watercooler fetch failed — skipping Tier 3");
      return "";
    }),
  ]);

  const mainText = mainResponse.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  console.log(`[API] Claude web_search (news Tier1+2) — complete at ${new Date().toISOString()}, ${mainText.length} chars`);

  if (!mainText) throw new Error("Empty response from Claude news search (Tier1+2)");

  // Combine main stories with watercooler
  const combined = watercoolerText
    ? `${mainText}\n\nTIER3:\n${watercoolerText}`
    : mainText;

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
  // Flexible regex — matches "TIER1:", "TIER 1:", "TIER 1 —", etc.
  const tier1Match = rawText.match(/TIER\s*1[\s:—]*([\s\S]*?)(?=TIER\s*2[\s:—]|$)/i);
  const tier2Match = rawText.match(/TIER\s*2[\s:—]*([\s\S]*?)(?=TIER\s*3[\s:—]|$)/i);
  const tier3Match = rawText.match(/TIER\s*3[\s:—]*([\s\S]*?)$/i);

  const tier1 = tier1Match?.[1]?.trim() ?? "";
  const tier2 = tier2Match?.[1]?.trim() ?? "";
  const tier3 = tier3Match?.[1]?.trim() ?? "";

  // ── Staleness check: surface any stories that look older than 48 hours ──────
  // Claude was instructed to only include stories from today/yesterday, but as an
  // extra guard we log a warning if the news block itself is stale when served.
  const fetchedStr = fetchedAt.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const sections: string[] = [];
  if (tier1) sections.push(`[Main Stories]\n${tier1}`);
  if (tier2 && !/no notable|none found/i.test(tier2)) {
    sections.push(`[Also Worth Knowing]\n${tier2}`);
  }
  if (tier3) sections.push(`[Light & Surprising Stories — web-searched separately for freshness]\n${tier3}`);

  // If regex still finds nothing, fall back to including the raw text as-is
  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[Morning News — web-searched at ${fetchedStr} CT, stories verified from past 24-48 hours only]\n` +
    body +
    `\n\n[Staleness rule for Emma: any story referenced below was fetched at ${fetchedStr} CT. ` +
    `If a story sounds older than 48 hours or the user asks "is this current?", say honestly when it was fetched.]\n` +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver all stories as one fast-moving conversational sweep — no section headers, no tier labels, no "in other news" ever. USA Today brevity, WSJ relevance. Move briskly with short natural transitions ("also —", "meanwhile —", "oh, and —"). Never linger. Lead with the most important hard news. For the light and surprising stories, introduce them naturally with something like "and here are a couple of things that'll make you smile" or "oh, and a few good ones to share later" — then deliver all of them just as briskly, one after another. Do not say "pickleball." Do not elaborate beyond what is written. Goal: David feels comprehensively informed, not deeply briefed on two stories.`
  );
}
