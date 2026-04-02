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

You are curating the morning news for David Blakelock in Dallas, Texas. Use web search to find real current news from the past 24-48 hours.

Search for and organize into three tiers:

TIER 1 — HARD RELEVANT NEWS (3-4 stories, the most significant):
Search for: Texas Rangers game score ${yesterdayStr} (did they play? final score, key moments), stock market performance ${yesterdayStr} (S&P Dow what moved and why), major global political news today, top AI or tech news past 48 hours (OpenAI Anthropic Google Apple major announcements), significant Dallas Texas news (only if major).

TIER 2 — CULTURAL MOMENTS (1-2 stories):
Search for: notable celebrity or public figure death ${todayStr}, major entertainment or sports news today.

TIER 3 — WATERCOOLER (1 story only):
Search for: one interesting surprising funny news story today that David would share at pickleball.

Output in EXACTLY this format:

TIER1:
• [2-3 sentence story with specific numbers, names, context for why it matters to David]
• [2-3 sentence story]
• [2-3 sentence story]

TIER2:
• [1-2 sentence story. If notable death: name, why known.]
• [1-2 sentence story — only if genuinely notable]

TIER3:
• [1-2 sentences. Be specific and concrete.]

Only report real stories you found. Include specific scores, percentages, names.`;

  const response = await anthropic.messages.create({
    model: "claude-3-5-haiku-20241022",
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

  // Slow path: fetch now, but bail if it takes more than 45 seconds
  const TIMEOUT_MS = 45_000;
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("News fetch timed out after 45s")), TIMEOUT_MS)
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
  const tier1Match = rawText.match(/TIER1:([\s\S]*?)(?=TIER2:|$)/i);
  const tier2Match = rawText.match(/TIER2:([\s\S]*?)(?=TIER3:|$)/i);
  const tier3Match = rawText.match(/TIER3:([\s\S]*?)$/i);

  const tier1 = tier1Match?.[1]?.trim() ?? "";
  const tier2 = tier2Match?.[1]?.trim() ?? "";
  const tier3 = tier3Match?.[1]?.trim() ?? "";

  const sections: string[] = [];
  if (tier1) sections.push(`[TIER 1 — Hard Relevant News]\n${tier1}`);
  if (tier2 && !/no notable|none found/i.test(tier2)) {
    sections.push(`[TIER 2 — Cultural Moments]\n${tier2}`);
  }
  if (tier3) sections.push(`[TIER 3 — Watercooler]\n${tier3}`);

  if (!sections.length) return "";

  return (
    `\n\n[Morning News — web-searched this morning, real stories from past 24-48 hours]\n` +
    sections.join("\n\n") +
    `\n\n[News delivery guidance for Emma]\n` +
    `Deliver the news as one flowing conversation — no tier labels, no section headers, no "in other news." Lead with the Tier 1 story most relevant to David today — Rangers game if they played, big market move, major breaking story. Each story: 2-3 sentences including why it matters to David (his portfolio, his teams, the AI space he watches). Tier 2: introduce naturally, 1-2 sentences, frame as "worth knowing." Tier 3: end the news with it — "And here's one you'll want to share at pickleball today —" or similar. Entire news section: max 2 minutes spoken aloud.`
  );
}
