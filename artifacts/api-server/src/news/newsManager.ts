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

You are curating the morning news for David Blakelock in Dallas, Texas. Use web search to find real current news from the past 24-48 hours. Aim for 6-8 total stories. USA Today brevity, Wall Street Journal relevance.

STORY FORMAT — strictly 3 sentences max per story:
• Sentence 1: What happened. Plain, crisp, specific (scores, percentages, names).
• Sentence 2: Why it matters to David — his portfolio (heavy in tech/AI/energy), his teams (Rangers, Cowboys, Mavericks), the AI space he works in, or Dallas/Texas impact.
• Sentence 3 (optional): What to watch next, or one additional fact that adds real context.

Search for and organize into three tiers:

TIER 1 — HARD NEWS (3-4 stories):
Search for: Texas Rangers game score ${yesterdayStr} (did they play? final score), stock market performance ${yesterdayStr} (S&P, what moved and why), major US or global political news past 24 hours, top AI or tech news past 48 hours (OpenAI, Anthropic, Google, Apple), significant Dallas/Texas news only if major.

TIER 2 — CULTURAL (1-2 stories):
Search for: notable celebrity or public figure death ${todayStr}, major entertainment or sports moment today. Skip if nothing genuinely notable.

TIER 3 — WATERCOOLER (1-2 stories):
Search for: one surprising, funny, or fascinating story David would bring up at pickleball today.

Output in EXACTLY this format (bullet points, no extra commentary):

TIER1:
• [story — max 3 sentences]
• [story — max 3 sentences]
• [story — max 3 sentences]

TIER2:
• [story — max 3 sentences]

TIER3:
• [story — max 3 sentences]

Only report real stories you found. Never invent or embellish.`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2000,
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
  if (tier3) sections.push(`[Share at Pickleball]\n${tier3}`);

  // If regex still finds nothing, fall back to including the raw text as-is
  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[Morning News — web-searched this morning, real stories from past 24-48 hours]\n` +
    body +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver all stories as one fast-moving conversational sweep — no section headers, no tier labels, no "in other news" ever. Aim for USA Today brevity with WSJ relevance. Move briskly: one story flows directly into the next with a short natural transition (2-4 words max: "also —", "meanwhile —", "oh, and —"). Never linger on a single story. Each story gets exactly what's written: Sentence 1 as stated, Sentence 2 as stated, Sentence 3 only if it appears. Do not elaborate beyond what's written. Do not add commentary or analysis. Lead with the most important hard news story. End with the watercooler story — frame it naturally as something worth bringing up. Goal: David feels comprehensively informed in under 2 minutes, not deeply briefed on two stories.`
  );
}
