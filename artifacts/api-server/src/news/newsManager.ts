import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";

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

// ── Resolve user context (name + city + sports + interests) ──────────────────

interface NewsContext {
  displayName: string;
  city: string;
  state: string;
  sportsTeams: string[];
  interests: string[];
  musicGenres: string[];
}

async function resolveNewsContext(userName?: string): Promise<NewsContext> {
  if (!userName) return { displayName: "the listener", city: "Dallas", state: "Texas", sportsTeams: [], interests: [], musicGenres: [] };
  const profile = await getProfile(userName).catch(() => null);
  const city = profile?.city ?? "Dallas";
  const raw = (profile?.rawData ?? {}) as Record<string, unknown>;
  const state = (raw.state as string | undefined) ?? "Texas";
  const displayName = (profile?.name ?? userName) as string;
  const sportsTeams = (raw.sportsTeams as string[] | undefined) ?? [];
  const interests = (raw.interests as string[] | undefined) ?? [];
  const musicGenres = (raw.music as string[] | undefined) ?? [];
  return { displayName, city, state, sportsTeams, interests, musicGenres };
}

// ── Core fetch (calls Claude with web_search) ─────────────────────────────────

async function fetchNewsFromClaude(userName?: string): Promise<string> {
  const tz = "America/Chicago";
  const now = new Date();
  const { city, state, sportsTeams, interests, musicGenres } = await resolveNewsContext(userName);

  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });

  // Build personalization lines for the prompt
  const teamsLine = sportsTeams.length > 0
    ? `The listener's sports teams are: ${sportsTeams.join(", ")}. ALWAYS check for news about these teams first.`
    : `No specific sports teams on file — use the most significant US sports story.`;

  const sportsExcludeTeams = sportsTeams.length > 0
    ? `Avoid all other sports leagues and teams not listed above.`
    : "";

  // Build a "wildcard interests" line from non-YMCA interests + music
  const cleanInterests = interests
    .filter((i) => !/YMCA|pickleball|Monday|Wednesday|Friday|Saturday|morning/i.test(i))
    .slice(0, 6);
  const wildcardInterests = [...cleanInterests, ...musicGenres].slice(0, 8);
  const wildcardLine = wildcardInterests.length > 0
    ? `For the wildcard story, prefer topics the listener actually cares about: ${wildcardInterests.join(", ")}. A story about classic rock, jazz, boats, woodworking, or outdoor sports is far more relevant than one about soccer or celebrity gossip.`
    : "";

  // Explicit exclusions — never cover these unless in user's teams/interests
  const sportsExclude = [
    !sportsTeams.some((t) => /\b(lakers|nba|basketball)\b/i.test(t)) ? "NBA / basketball (including playoffs, standings, or trade rumors)" : null,
    !sportsTeams.some((t) => /\b(mls|soccer|football|fifa|world.?cup)\b/i.test(t)) ? "MLS / FIFA / soccer / World Cup" : null,
    !sportsTeams.some((t) => /\bgolf\b/i.test(t)) ? "golf tournament results" : null,
  ].filter(Boolean).join("; ");

  // ── Main headlines: 6 targeted categories ────────────────────────────────
  const mainPrompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating a morning news briefing for a listener in ${city}, ${state}. Use web search to find real, current news. RECENCY IS CRITICAL — every story must be from ${todayStr} or ${yesterdayStr} only.

LISTENER PROFILE:
- Sports teams followed: ${sportsTeams.length > 0 ? sportsTeams.join(", ") : "none specified"}
- Music interests: ${musicGenres.length > 0 ? musicGenres.join(", ") : "general"}
- Other interests: pickleball, woodworking, boats, cooking, stock market, classic rock, jazz

DIVERSITY RULE — MANDATORY: Return EXACTLY 6 stories. Each must come from a DIFFERENT category. NEVER run two stories about the same topic, country, company, person, or theme.

FORMAT: Each story has TWO parts:
1. A bold short title (3-7 words, bold using **asterisks**)
2. One sentence of context on the next line — specific, factual, with key numbers or names

REQUIRED CATEGORIES — one story from each, in this order:

CATEGORY 1 — WORLD NEWS: A major international story (non-US). Geopolitics, conflict, diplomacy, or a significant event outside the United States.

CATEGORY 2 — US POLITICS OR ECONOMY: A domestic US political development OR a notable business/economic story — legislation, White House, Congress, corporate earnings, trade, or labor. Do NOT cover stock index performance.

CATEGORY 3 — TECHNOLOGY: One story about AI, software, a major tech company (Apple, Google, Microsoft, OpenAI, Meta, Amazon), or a significant product launch. Do NOT repeat a company that appeared in Category 2. Avoid covering the same AI company two days in a row if possible.

CATEGORY 4 — SPORTS (PERSONALIZED — MANDATORY):
${teamsLine}
Search explicitly: "${sportsTeams.map((t) => `"${t}" news today`).join(" OR ")}".
Report the most recent game result, standings update, or official transaction for one of these teams.
If none of these teams played in the last 48 hours, report the most important story from any of these teams — a roster move, injury update, or upcoming series.
NEVER use this slot for: ${sportsExclude || "unrelated leagues"}.
${sportsExcludeTeams}

CATEGORY 5 — ${city.toUpperCase()} LOCAL (MANDATORY — never skip): A story specifically about ${city} or the surrounding DFW area — local government, business, development, infrastructure, culture, events, or community. Must be genuinely local. If initial search misses, search explicitly: "${city} news today" or "${city} ${state} breaking news". Always find one.

CATEGORY 6 — WILDCARD (INTEREST-RELEVANT): The most interesting story that fits none of the above AND is genuinely relevant to what this listener cares about.
${wildcardLine}
AVOID for wildcard: ${sportsExclude || "unrelated sports"}. Avoid celebrity gossip, tabloid content, or anything the average person would not find interesting.

STALENESS RULE: Only include stories from ${todayStr} or ${yesterdayStr}. Max 48 hours old.

NO-REPEAT RULE: Before finalizing, check — do any two stories share the same company, person, or topic? If yes, replace one.

Output in EXACTLY this format — no other text, no category labels:

HEADLINES:
**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

**[Short Bold Title]**
[One sentence with specific fact, number, or name.]

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
export async function preFetchMorningNews(userName?: string): Promise<void> {
  try {
    logger.info("Starting morning news pre-fetch");
    const content = await fetchNewsFromClaude(userName);
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
export async function fetchMorningNews(userName?: string): Promise<string> {
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
    const content = await Promise.race([fetchNewsFromClaude(userName), timeout]);
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
  if (headlines) sections.push(`[Headlines — bold title + one sentence summary each]\n${headlines}`);
  if (entertainment && !/^none$/i.test(entertainment)) {
    sections.push(`[Entertainment & Pop Culture]\n${entertainment}`);
  }
  if (watercooler) sections.push(`[Watercooler Story — one fascinating story to share]\n${watercooler}`);

  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[VERIFIED — Web Search News — fetched at ${fetchedStr} CT, stories from past 24-48 hours only]\n` +
    body
  );
}

// ── Daily motivation / inspiration ────────────────────────────────────────────

interface MotivationCache {
  content: string;
  fetchedAt: Date;
}
let _motivationCache: MotivationCache | null = null;

async function fetchMotivationFromClaude(userName?: string): Promise<string> {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const ctx = await resolveNewsContext(userName).catch(() => null);
  const teams = ctx?.sportsTeams ?? ["Texas Rangers", "Dallas Cowboys"];
  const music = ctx?.musicGenres ?? ["classic rock", "jazz", "Jimmy Buffett"];

  const prompt =
    `Today is ${todayStr}. Search the web for something genuinely inspiring, thought-provoking, or fascinating ` +
    `published in the last 24-48 hours.\n\n` +
    `LISTENER CONTEXT: This person loves pickleball, woodworking, classic rock (Rolling Stones, Jackson Browne, Jimmy Buffett), ` +
    `jazz, boats, cooking, and follows these sports teams: ${teams.join(", ")}. ` +
    `They value family (daughter in college, girlfriend in Dallas), integrity, and quiet resilience.\n\n` +
    `PREFERRED TOPICS for the inspiring thought: science or nature discovery, music history or artist news ` +
    `(${music.slice(0, 3).join(", ")}), a Texas Rangers or Cowboys story worth celebrating, ` +
    `remarkable human achievement, woodworking or craftsmanship, or wisdom from a respected figure.\n\n` +
    `AVOID ENTIRELY: soccer, FIFA, World Cup, MLS, NBA, golf tournaments, celebrity gossip, tragedy, crime, ` +
    `politics, or anything that requires following a sport or team not in the listener's list.\n\n` +
    `Return ONE item only. Format:\n` +
    `TITLE: [5-8 word bold title]\n` +
    `CONTENT: [2-3 sentences — what it is, why it's striking, and one sentence that connects it to everyday life, ` +
    `ideally referencing something the listener cares about — family, music, or their sport]\n` +
    `\nNo extra commentary. Only real, verified content — never fabricate.`;

  console.log(`[API] Claude web_search (daily motivation) — starting at ${now.toISOString()}`);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n").trim();

  console.log(`[API] Claude web_search (daily motivation) — complete, ${text.length} chars`);
  return text;
}

export async function preFetchDailyMotivation(userName?: string): Promise<void> {
  try {
    logger.info("Starting daily motivation pre-fetch");
    const content = await fetchMotivationFromClaude(userName);
    _motivationCache = { content, fetchedAt: new Date() };
    logger.info({ chars: content.length }, "Daily motivation pre-fetched and cached");
  } catch (err) {
    logger.warn({ err }, "Daily motivation pre-fetch failed — will use context-based motivation");
  }
}

export async function fetchDailyMotivation(userName?: string): Promise<string> {
  if (_motivationCache && Date.now() - _motivationCache.fetchedAt.getTime() < 6 * 60 * 60 * 1000) {
    return _motivationCache.content;
  }
  try {
    const content = await fetchMotivationFromClaude(userName);
    _motivationCache = { content, fetchedAt: new Date() };
    return content;
  } catch (err) {
    logger.warn({ err }, "Daily motivation fetch failed — skipping");
    return "";
  }
}
