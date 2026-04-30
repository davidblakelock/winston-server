import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { getUpcomingDates } from "../dates/datesManager.js";
import { isTodayPickleballDay } from "../pickleball/pickleballManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory cache ──────────────────────────────────────────────────────────

interface NewsCache {
  content: string;
  fetchedAt: Date;
}

let _cache: NewsCache | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_WARN_MS = 12 * 60 * 60 * 1000;

function isCacheFresh(): boolean {
  if (!_cache) return false;
  return Date.now() - _cache.fetchedAt.getTime() < CACHE_TTL_MS;
}

// ── Numbered story cache — powers "tell me more about number N" ───────────────

export interface ParsedStory {
  number: number;
  title: string;
  summary: string;
}

let _parsedStories: ParsedStory[] = [];

export function getStoredHeadlines(): ParsedStory[] {
  return _parsedStories;
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

// ── Watercooler: ONE fascinating story from the last 24h ─────────────────────

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
    `\n\nFocus on variety — pick from any of these categories: record-breaking achievements, ` +
    `surprising historical or archaeological discoveries, unusual animal behavior, unexpected tech or science firsts, ` +
    `remarkable human interest stories, viral real-world moments, quirky cultural events, ` +
    `sports records or upsets, music or entertainment surprises (no deaths). ` +
    `Rotate across categories — do NOT default to science every time. ` +
    `\n\nSTRICTLY AVOID: politics, crime, violence, tragedy, death, accidents, disasters, controversy. ` +
    `\n\nReturn EXACTLY ONE story in TWO sentences maximum. ` +
    `Sentence 1: What happened (specific, vivid, surprising). ` +
    `Sentence 2: Why it's fascinating or what makes it remarkable. ` +
    `No headers, no bullet points, no commentary — just the two sentences. ` +
    `If you cannot find a qualifying story from the last 24 hours, search for "amazing story today", ` +
    `"record broken today", "incredible achievement today". Do not use a story older than 24 hours.`;

  console.log(`[API] Claude web_search (watercooler) — starting at ${new Date().toISOString()}`);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
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

async function fetchEntertainmentNews(userMusicGenres?: string[], userInterests?: string[]): Promise<string> {
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

  // Build an exclusion note based on the user's actual interests
  const likedGenres = (userMusicGenres ?? []).join(", ") || "classic rock, jazz";
  const avoidNote =
    `\n\nLISTENER PREFERENCES: The listener enjoys ${likedGenres}. ` +
    `SKIP deaths or news about: classical music conductors, classical composers, opera singers, ` +
    `or any genre/figure the listener clearly has no connection to. ` +
    `Only include a death if it would genuinely resonate with someone who likes ${likedGenres} ` +
    `or if it is truly historic (e.g. major film star, household name).`;

  const prompt =
    `Today is ${todayStr}. Use web search to find 2 notable entertainment or pop culture items. ` +
    `Focus exclusively on: (1) major celebrity or public figure deaths in the past 48 hours, ` +
    `(2) highly anticipated movie or TV releases opening before ${futureStr}, ` +
    `(3) major awards shows or significant cultural moments from the past 48 hours. ` +
    `\n\nEach item: ONE sentence only. Specific names, dates, and facts. ` +
    `Search terms: "celebrity death today", "movie opening this month", "awards news today", "entertainment news ${todayStr}". ` +
    `Only use stories from ${cutoffStr} or later for deaths/awards; upcoming releases can be within 30 days. ` +
    `If only 1 qualifying story exists, return only 1. If none qualify, return "NONE". ` +
    `\n\nReturn as bullet points: • [one sentence]. No headers, no tier labels.` +
    avoidNote;

  console.log(`[API] Claude web_search (entertainment) — starting at ${new Date().toISOString()}`);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n").trim();

  console.log(`[API] Claude web_search (entertainment) — complete, ${text.length} chars`);
  if (!text || /^none$/i.test(text.trim())) return "";
  return text;
}

// ── Core fetch: TOP 10 in 4/3/3 format ────────────────────────────────────────
// 4 global/world + 3 national (US) + 3 local (user's city)
// Each story is ONE sentence max, numbered 1-10 for "tell me more about number N"

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

  const teamsLine = sportsTeams.length > 0
    ? `The listener follows these teams: ${sportsTeams.join(", ")}. Always include a story about one of them if there is relevant news from the last 48 hours.`
    : `No specific sports teams on file — use the most significant US sports story.`;

  const sportsExclude = [
    !sportsTeams.some((t) => /\b(lakers|nba|basketball)\b/i.test(t)) ? "NBA / basketball" : null,
    !sportsTeams.some((t) => /\b(mls|soccer|football|fifa|world.?cup)\b/i.test(t)) ? "MLS / FIFA / soccer" : null,
    !sportsTeams.some((t) => /\bgolf\b/i.test(t)) ? "golf" : null,
  ].filter(Boolean).join(", ");

  const cleanInterests = interests
    .filter((i) => !/YMCA|pickleball|Monday|Wednesday|Friday|Saturday|morning/i.test(i))
    .slice(0, 6);
  const wildcardInterests = [...cleanInterests, ...musicGenres].slice(0, 8);

  const mainPrompt = `Today is ${todayStr}. Yesterday was ${yesterdayStr}.

You are curating a morning news briefing for a listener in ${city}, ${state}. Use web search to find real, current news. RECENCY IS CRITICAL — every story must be from ${todayStr} or ${yesterdayStr} only.

LISTENER PROFILE:
- Sports teams followed: ${sportsTeams.length > 0 ? sportsTeams.join(", ") : "none specified"}
- Music interests: ${musicGenres.length > 0 ? musicGenres.join(", ") : "general"}
- Other interests: pickleball, woodworking, boats, cooking, stock market, classic rock, jazz

STRUCTURE — Deliver EXACTLY 10 stories in this order:

STORIES 1–2: GLOBAL / WORLD NEWS (2 stories only)
Two significant international stories that directly affect the United States or are of genuinely major world importance.
STRICT GLOBAL EXCLUSIONS — skip any story about:
• FIFA, World Cup, soccer/football trophies, international soccer competitions
• Colombia, Mali, Sudan, or other countries with no direct US relevance today
• Regional conflicts with no US involvement or global significance
• Sports leagues that are not the listener's followed teams
Choose only stories with direct US relevance (trade, diplomacy, military, economy) or genuinely historic global significance.

STORIES 3–7: NATIONAL (US) NEWS (5 stories)
Five domestic US stories. Mix from these categories — each story from a DIFFERENT category:
• US Politics / White House / Congress / legislation / Supreme Court
• US Economy / business / corporate / trade / labor / market news
• Technology: AI, software, major tech company (Apple, Google, Microsoft, OpenAI, Meta, Amazon)
• Health / science / environment (US-focused)
• Personalized wildcard: A US story relevant to the listener's interests — music (${musicGenres.join(", ") || "classic rock, jazz"}), woodworking, boats, cooking, stock market, or any other significant national story not covered above
IMPORTANT: NO sports stories in Stories 1–10. Sports belongs exclusively to the dedicated Sports section delivered separately. Do NOT include any sports result, game, trade, draft, or team news in the Top 10 — not even for the listener's followed teams.

STORIES 8–10: LOCAL NEWS — ${city.toUpperCase()}, ${state.toUpperCase()}
Three stories specifically about ${city} or the DFW area — local government, business, development, infrastructure, culture, community events. Must be genuinely local to ${city}.
LOCAL EXCLUSIONS — skip any story about:
• Weather alerts, tornado warnings, or severe weather notices — weather is covered separately. Do NOT include any severe weather warnings, watches, or past weather events in local news.
• Events that happened more than 24 hours ago
If initial search is thin, search explicitly: "${city} news today", "${city} breaking news", "${city} ${state} news ${todayStr}". Always find three.

FORMATTING — MANDATORY:
• Number every story 1 through 10
• Each story: number + period + bold title (4-8 words) + em dash + ONE sentence only (max 25 words, specific facts/names/numbers)
• ONE blank line between stories
• No category labels, no headers, no extra commentary

OUTPUT FORMAT (follow exactly):
1. **[Bold Title Here]** — [One sentence, max 25 words.]

2. **[Bold Title Here]** — [One sentence, max 25 words.]

... (continue through 10)

GLOBAL RULES:
• All stories from ${todayStr} or ${yesterdayStr} only — max 48 hours old
• No two stories about the same person, company, or topic
• NEVER include any sports stories in Stories 1–10 — sports is covered in a dedicated section
• NEVER include FIFA, World Cup, soccer trophies, or international soccer in any section
• NEVER include weather alerts, tornado warnings, or severe weather notices — weather has its own section
• Only report real, verified stories — never fabricate`;

  console.log(`[API] Claude web_search (news headlines) — starting at ${new Date().toISOString()}`);

  const [mainResponse, watercoolerText, entertainmentText] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: mainPrompt }],
    }),
    fetchWatercoolerStories().catch((err) => {
      logger.warn({ err }, "Watercooler fetch failed — skipping");
      return "";
    }),
    fetchEntertainmentNews(musicGenres, cleanInterests).catch((err) => {
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

export async function fetchMorningNews(userName?: string): Promise<string> {
  if (isCacheFresh() && _cache) {
    const ageMs = Date.now() - _cache.fetchedAt.getTime();
    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
    if (ageMs > STALE_WARN_MS) {
      console.warn(`[News] Serving STALE cached news — ${ageHours}h old`);
    } else {
      logger.info({ ageHours, chars: _cache.content.length }, "Morning news served from cache");
    }
    return _cache.content;
  }

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

// ── Formatting — parse numbered stories, populate lookup cache ────────────────

function parseNumberedStories(text: string): ParsedStory[] {
  const stories: ParsedStory[] = [];
  // Match "1. **Title** — sentence" or "1. **Title**: sentence"
  const storyPattern = /^(\d+)\.\s+\*\*(.+?)\*\*\s*[—\-:]\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = storyPattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 10) {
      stories.push({
        number: num,
        title: match[2].trim(),
        summary: match[3].trim(),
      });
    }
  }
  return stories;
}

function formatNewsBlock(rawText: string, fetchedAt: Date): string {
  // Separate main 10-story block from entertainment/watercooler
  const entertainmentMatch = rawText.match(/ENTERTAINMENT[\s:—]*([\s\S]*?)(?=WATERCOOLER[\s:—]|$)/i);
  const watercoolerMatch = rawText.match(/WATERCOOLER[\s:—]*([\s\S]*?)$/i);
  const mainText = rawText
    .replace(/ENTERTAINMENT[\s:—][\s\S]*/i, "")
    .replace(/WATERCOOLER[\s:—][\s\S]*/i, "")
    .trim();

  const entertainment = entertainmentMatch?.[1]?.trim() ?? "";
  const watercooler = watercoolerMatch?.[1]?.trim() ?? "";

  // Parse and cache numbered stories for "tell me more about number N"
  const parsed = parseNumberedStories(mainText);
  if (parsed.length > 0) {
    _parsedStories = parsed;
    logger.info({ count: parsed.length }, "[News] Parsed and cached numbered stories");
  }

  const fetchedStr = fetchedAt.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
  });

  const sections: string[] = [];
  if (mainText) {
    sections.push(
      `[Top 10 Stories — numbered, bold title + one sentence each]\n` +
      `(Stories 1-2 are global/world with US relevance, 3-7 are national/US, 8-10 are local ${fetchedAt.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric" })})\n\n` +
      mainText
    );
  }
  if (entertainment && !/^none$/i.test(entertainment)) {
    sections.push(`[Entertainment & Pop Culture]\n${entertainment}`);
  }
  if (watercooler) {
    sections.push(`[Watercooler Story — one fascinating story to share]\n${watercooler}`);
  }

  const body = sections.length > 0 ? sections.join("\n\n") : rawText;

  return (
    `\n\n[VERIFIED — Web Search News — fetched at ${fetchedStr} CT, stories from past 24-48 hours only]\n` +
    body
  );
}

// ── ZenQuotes daily quote ──────────────────────────────────────────────────────
// Free API, no key required. Returns one curated philosophical/inspirational quote per day.

async function fetchZenQuote(): Promise<{ q: string; a: string } | null> {
  try {
    const res = await fetch("https://zenquotes.io/api/today", {
      headers: { "User-Agent": "WinstonAI/1.0 morning-briefing" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[ZenQuotes] API returned ${res.status}`);
      return null;
    }
    const data = await res.json() as Array<{ q: string; a: string }>;
    const quote = data[0];
    if (!quote?.q || !quote?.a) return null;
    console.log(`[ZenQuotes] Quote fetched: "${quote.q.slice(0, 60)}..." — ${quote.a}`);
    return quote;
  } catch (err) {
    console.warn("[ZenQuotes] Fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Daily motivation / closing thought ────────────────────────────────────────
// Priority order:
//   1. Personal override — birthday/anniversary within 14 days → skip quote, deliver personal note
//   2. ZenQuotes + Claude personalization — quote delivered naturally with real-life connection
//   3. Fallback — Claude generates an original thought based on user context

interface MotivationCache {
  content: string;
  fetchedAt: Date;
}
let _motivationCache: MotivationCache | null = null;

async function fetchMotivationFromClaude(userName?: string): Promise<string> {
  const now = new Date();
  const tz = "America/Chicago";
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const dayName = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const isPickleballDay = isTodayPickleballDay();

  const ctx = await resolveNewsContext(userName).catch(() => null);
  const displayName = ctx?.displayName ?? "David";
  const teams = ctx?.sportsTeams ?? ["Texas Rangers", "Dallas Cowboys"];
  const music = ctx?.musicGenres ?? ["classic rock", "jazz"];

  // ── Step 1: Check for personal override (upcoming birthday/anniversary within 14 days) ──
  const upcomingDates = await getUpcomingDates(14, userName).catch(() => []);
  const soonPersonal = upcomingDates.filter((d) => {
    const daysOut = d.daysUntil ?? 999;
    return daysOut >= 0 && daysOut <= 14;
  });

  if (soonPersonal.length > 0) {
    // Generate a personal observation — skip ZenQuotes entirely
    const items = soonPersonal.map((d) => {
      const who = `${d.personName}'s ${d.eventType}`;
      const days = d.daysUntil === 0 ? "TODAY" : d.daysUntil === 1 ? "tomorrow" : `in ${d.daysUntil} days`;
      return `${who}: ${days} (${d.label})`;
    }).join("; ");

    const personalPrompt =
      `Today is ${todayStr}. You are James Bond, ${displayName}'s trusted morning companion.\n\n` +
      `UPCOMING PERSONAL DATES: ${items}\n\n` +
      `Write a warm, genuine 2-3 sentence personal observation about this — specific, thoughtful, and personal. ` +
      `If it's a birthday, you might mention something to do for them or acknowledge the relationship. ` +
      `If it's an anniversary, acknowledge what it means. Sound like a caring friend, not a calendar app. ` +
      `Keep it brief — 2-3 sentences maximum. Do not use generic phrases like "make the most of today."`;

    console.log(`[Motivation] Personal override — upcoming: ${items}`);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: personalPrompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n").trim();
    return `[Personal Override — Morning Note]\n${text}`;
  }

  // ── Step 2: Fetch ZenQuotes + Claude personalization ──
  const zenQuote = await fetchZenQuote();

  if (zenQuote) {
    const activityNote = isPickleballDay
      ? `${displayName} has pickleball this morning (indoor at the YMCA).`
      : `Today is a non-pickleball day for ${displayName}.`;

    const personalizationPrompt =
      `Today is ${todayStr} (${dayName}). You are James Bond, ${displayName}'s trusted morning companion.\n\n` +
      `TODAY'S QUOTE: "${zenQuote.q}" — ${zenQuote.a}\n\n` +
      `CONTEXT ABOUT ${displayName.toUpperCase()}:\n` +
      `• ${activityNote}\n` +
      `• Sports teams followed: ${teams.join(", ")}\n` +
      `• Music loves: ${music.join(", ")}, and Jimmy Buffett\n` +
      `• Other interests: woodworking, boats, cooking, family (daughter Olivia in Knoxville, girlfriend Susan in Dallas)\n\n` +
      `TASK: Deliver this quote naturally in 2-3 sentences, with a genuine personal connection to ${displayName}'s real life. ` +
      `Rules:\n` +
      `• Don't announce it as "today's quote" or "here's a quote"\n` +
      `• Weave it in naturally — e.g. "Here's something worth carrying through your ${dayName}:"\n` +
      `• After the quote, add one sentence connecting it to something specific in his life (an activity, a value he holds, a relationship)\n` +
      `• Sound like a trusted friend sharing something interesting, not a motivational poster\n` +
      `• Keep it to 2-3 sentences total — tight and warm`;

    console.log(`[Motivation] ZenQuotes + Claude personalization`);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      messages: [{ role: "user", content: personalizationPrompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n").trim();

    if (text) {
      return `[VERIFIED — ZenQuotes — Today's Wisdom]\nQuote: "${zenQuote.q}" — ${zenQuote.a}\n\nDelivery:\n${text}`;
    }
  }

  // ── Step 3: Fallback — Claude original thought ──
  const fallbackPrompt =
    `Today is ${todayStr}. You are James Bond, ${displayName}'s morning companion.\n\n` +
    `${displayName}'s interests: pickleball (indoor YMCA), woodworking, boats, classic rock (Rolling Stones, Jackson Browne, Jimmy Buffett), jazz, cooking. Teams: ${teams.join(", ")}.\n\n` +
    `Write a warm, specific 2-3 sentence motivating thought for ${dayName}. ` +
    `Reference something he actually cares about. No generic phrases. No "seize the day." ` +
    `Sound like a sharp, caring friend.`;

  console.log(`[Motivation] Fallback — Claude original thought`);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{ role: "user", content: fallbackPrompt }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();
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
