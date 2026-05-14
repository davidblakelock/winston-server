import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { getUpcomingDates } from "../dates/datesManager.js";
import {
  fetchReutersHeadlines,
  fetchAPNewsHeadlines,
  fetchReutersOddlyEnough,
  fetchAPOddities,
  formatArticlesForClaude,
  extractTitles,
  isApifyNewsConfigured,
  type ScrapedArticle,
} from "./apifyNewsManager.js";
import { isNewsApiConfigured, fetchNewsApiHeadlines } from "./newsApiManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory news cache ──────────────────────────────────────────────────────

interface NewsCache {
  content:   string;
  fetchedAt: Date;
}

let _cache: NewsCache | null = null;
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;
const STALE_WARN_MS = 12 * 60 * 60 * 1000;

function isCacheFresh(): boolean {
  if (!_cache) return false;
  return Date.now() - _cache.fetchedAt.getTime() < CACHE_TTL_MS;
}

// ── Morning raw headline cache (used by midday news comparison) ───────────────

/** Per-user store of raw article titles seen at morning briefing time. */
const _morningHeadlines = new Map<string, string[]>();

export function storeMorningHeadlines(userName: string, titles: string[]): void {
  _morningHeadlines.set(userName, titles);
}

export function getMorningHeadlines(userName: string): string[] {
  return _morningHeadlines.get(userName) ?? [];
}

// ── Numbered story cache — powers "tell me more about number N" ───────────────

export interface ParsedStory {
  number:  number;
  title:   string;
  summary: string;
}

let _parsedStories: ParsedStory[] = [];

export function getStoredHeadlines(): ParsedStory[] {
  return _parsedStories;
}

// ── Resolve user context ──────────────────────────────────────────────────────

interface NewsContext {
  displayName:   string;
  companionName: string;
  city:          string;
  state:         string;
  sportsTeams:   string[];
  interests:     string[];
  musicGenres:   string[];
}

async function resolveNewsContext(userName?: string): Promise<NewsContext> {
  if (!userName) return {
    displayName: "the listener", companionName: "your companion",
    city: "Dallas", state: "Texas",
    sportsTeams: [], interests: [], musicGenres: [],
  };
  const profile = await getProfile(userName).catch(() => null);
  const city    = profile?.city ?? "Dallas";
  const raw     = (profile?.rawData ?? {}) as Record<string, unknown>;
  return {
    displayName:   (profile?.name ?? userName) as string,
    companionName: (profile?.companionName as string | undefined) ?? "your companion",
    city,
    state:         (raw["state"] as string | undefined) ?? "Texas",
    sportsTeams:   (raw["sportsTeams"] as string[] | undefined) ?? [],
    interests:     (raw["interests"]   as string[] | undefined) ?? [],
    musicGenres:   (raw["music"]       as string[] | undefined) ?? [],
  };
}

// ── Watercooler via Apify (primary) ───────────────────────────────────────────

async function fetchWatercoolerViaApify(): Promise<string> {
  const now     = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const currentYear = now.getFullYear();

  // Fetch both oddity feeds concurrently
  const [reutersOdd, apOdd] = await Promise.allSettled([
    fetchReutersOddlyEnough(12),
    fetchAPOddities(12),
  ]);

  const combined: ScrapedArticle[] = [
    ...(reutersOdd.status === "fulfilled" ? reutersOdd.value : []),
    ...(apOdd.status     === "fulfilled" ? apOdd.value     : []),
  ];

  if (combined.length === 0) {
    throw new Error("[Watercooler] Apify returned no oddity articles");
  }

  const headlinesBlock = formatArticlesForClaude(combined, "Feel-Good / Bizarre Stories — Reuters Oddly Enough + AP Oddities", 15);

  const prompt =
    `Today is ${todayStr}. The current year is ${currentYear}.\n\n` +
    `Here are scraped headlines from Reuters "Oddly Enough" and AP Oddities:\n\n${headlinesBlock}\n\n` +
    `Select ONE feel-good, bizarre, or delightfully unexpected story from this list. ` +
    `STRICTLY AVOID: politics, crime, violence, tragedy, death, accidents, disasters, controversy.\n\n` +
    `Focus on: record-breaking feats, bizarre but charming events, unusual animal behavior, ` +
    `unexpected human-interest moments, quirky cultural happenings, heartwarming community stories, ` +
    `or genuinely surprising scientific discoveries. Rotate across categories — do NOT default to science every time.\n\n` +
    `Return EXACTLY ONE story in TWO sentences:\n` +
    `Sentence 1: What happened — specific, vivid, surprising.\n` +
    `Sentence 2: Why it's remarkable or what makes it delightful.\n` +
    `No headers, no bullet points, no source attribution — just the two sentences.`;

  logger.info("[News] Claude (watercooler-apify) — selecting from Apify headlines");

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text) throw new Error("Empty watercooler response from Claude (Apify path)");
  logger.info({ chars: text.length }, "[News] Watercooler via Apify complete");
  return text;
}

// ── Watercooler via web_search (fallback) ─────────────────────────────────────

async function fetchWatercoolerViaWebSearch(): Promise<string> {
  const now       = new Date();
  const todayStr  = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const cutoff    = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });
  const currentYear = now.getFullYear();

  const prompt =
    `Today is ${todayStr}. The current year is ${currentYear}. ` +
    `Use web search to find ONE feel-good, bizarre, or delightfully unexpected story from the last 24 hours. ` +
    `Search these sources first: Reuters "Oddly Enough" section (reuters.com/oddly-enough), AP Oddities, and similar quirky wire feeds. ` +
    `If those are thin, broaden to any story published after ${cutoffStr} that qualifies. ` +
    `The story must be from ${currentYear} — REJECT any story from ${currentYear - 1} or earlier.\n\n` +
    `Focus on: record-breaking feats, bizarre but charming events, unusual animal behavior, ` +
    `unexpected human-interest moments, quirky cultural happenings, heartwarming community stories, ` +
    `or genuinely surprising scientific discoveries. Rotate across categories.\n\n` +
    `STRICTLY AVOID: politics, crime, violence, tragedy, death, accidents, disasters, controversy.\n\n` +
    `Return EXACTLY ONE story in TWO sentences:\n` +
    `Sentence 1: What happened — specific, vivid, surprising.\n` +
    `Sentence 2: Why it's remarkable or what makes it delightful.\n` +
    `No headers, no bullet points, no commentary — just the two sentences.`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text) throw new Error("Empty watercooler response (web_search fallback)");
  return text;
}

// ── Watercooler: Apify primary, web_search fallback ───────────────────────────

async function fetchWatercoolerStories(): Promise<string> {
  if (isApifyNewsConfigured()) {
    try {
      return await fetchWatercoolerViaApify();
    } catch (err) {
      logger.warn({ err }, "[News] Watercooler Apify path failed — falling back to web_search");
    }
  }
  return fetchWatercoolerViaWebSearch();
}

// ── Entertainment: celebrity news, releases, cultural moments ─────────────────

async function fetchEntertainmentNews(
  userMusicGenres?: string[],
  userInterests?:   string[],
): Promise<string> {
  const now       = new Date();
  const todayStr  = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const cutoff    = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });
  const in30days  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const futureStr = in30days.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric",
  });

  const likedGenres = (userMusicGenres ?? []).join(", ") || "classic rock, jazz";
  const avoidNote   =
    `\n\nLISTENER PREFERENCES: The listener enjoys ${likedGenres}. ` +
    `SKIP deaths or news about: classical music conductors, classical composers, opera singers, ` +
    `or any genre/figure the listener clearly has no connection to. ` +
    `Only include a death if it would genuinely resonate with someone who likes ${likedGenres} ` +
    `or if it is truly historic (e.g. major film star, household name).`;

  const currentYear = now.getFullYear();
  const prompt =
    `Today is ${todayStr}. The current year is ${currentYear}. Use web search to find 2 notable entertainment or pop culture items. ` +
    `Focus exclusively on: (1) major celebrity or public figure deaths in the past 48 hours, ` +
    `(2) highly anticipated movie or TV releases opening before ${futureStr}, ` +
    `(3) major awards shows or significant cultural moments from the past 48 hours. ` +
    `\n\nEach item: ONE sentence only. Specific names, dates, and facts. ` +
    `Search terms: "celebrity death today ${currentYear}", "movie opening this month ${currentYear}", "awards news today", "entertainment news ${todayStr}". ` +
    `Only use stories from ${cutoffStr} or later for deaths/awards — must be from ${currentYear}, REJECT any story from ${currentYear - 1} or earlier. Upcoming releases can be within 30 days. ` +
    `If only 1 qualifying story exists, return only 1. If none qualify, return "NONE". ` +
    `\n\nReturn as bullet points: • [one sentence]. No headers, no tier labels.` +
    avoidNote;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text || /^none$/i.test(text.trim())) return "";
  return text;
}

// ── Top stories via Apify (primary) ───────────────────────────────────────────

async function fetchTopStoriesViaApify(userName?: string): Promise<{ text: string; rawTitles: string[] }> {
  const ctx         = await resolveNewsContext(userName);
  const now         = new Date();
  const todayStr    = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const yesterday   = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric",
  });
  const currentYear = now.getFullYear();

  // Fetch Reuters + AP concurrently
  const [reutersResult, apResult] = await Promise.allSettled([
    fetchReutersHeadlines(25),
    fetchAPNewsHeadlines(25),
  ]);

  const combined: ScrapedArticle[] = [
    ...(reutersResult.status === "fulfilled" ? reutersResult.value : []),
    ...(apResult.status      === "fulfilled" ? apResult.value      : []),
  ];

  if (combined.length === 0) {
    throw new Error("[TopStories] Apify returned no articles — falling through to web_search");
  }

  const rawTitles    = extractTitles(combined);
  const headlinesBlock = formatArticlesForClaude(combined, "Reuters + AP News — Current Headlines", 30);

  const teamsLine = ctx.sportsTeams.length > 0
    ? `The listener follows these teams: ${ctx.sportsTeams.join(", ")}. Include a story about one if there is significant news from the last 48 hours.`
    : `No specific sports teams on file.`;

  const prompt =
    `Today is ${todayStr}. Yesterday was ${yesterdayStr}. The current year is ${currentYear}.\n\n` +
    `Here are real, scraped headlines from Reuters and AP News:\n\n${headlinesBlock}\n\n` +
    `Select the 2 most genuinely important stories for a morning briefing. Prioritise:\n` +
    `• Major world events, significant US political or economic developments, important technology or science news\n` +
    `• Broad relevance — NOT regional, NOT routine, NOT filler\n` +
    `• ${teamsLine}\n\n` +
    `NO LOCAL NEWS. NO WEATHER. NO STOCK MARKET. NO FILLER.\n\n` +
    `For EACH of the 2 selected stories, write exactly TWO sentences:\n` +
    `• Sentence 1: What happened — specific, factual, with names and numbers. Max 25 words.\n` +
    `• Sentence 2: Why it matters — real-world consequence or why a listener should care. Max 25 words.\n\n` +
    `OUTPUT FORMAT (follow exactly):\n` +
    `1. **[Bold Title — 4–6 words]** — [What happened.] [Why it matters.]\n\n` +
    `2. **[Bold Title — 4–6 words]** — [What happened.] [Why it matters.]\n\n` +
    `RULES: Exactly 2 stories. No two stories on the same topic. Never fabricate — only use headlines from the list above.`;

  logger.info("[News] Claude (top-stories-apify) — curating from Apify headlines");

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text) throw new Error("Empty top-stories response from Claude (Apify path)");
  logger.info({ chars: text.length }, "[News] Top stories via Apify complete");
  return { text, rawTitles };
}

// ── Top stories via NewsAPI.org (preferred) ───────────────────────────────────

async function fetchTopStoriesViaNewsApi(userName?: string): Promise<{ text: string; rawTitles: string[] }> {
  const ctx         = await resolveNewsContext(userName);
  const now         = new Date();
  const todayStr    = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const yesterday   = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric",
  });
  const currentYear = now.getFullYear();

  const articles = await fetchNewsApiHeadlines("reuters,the-associated-press", 30);

  if (articles.length === 0) {
    throw new Error("[TopStories] NewsAPI returned no articles — falling through to next source");
  }

  const rawTitles   = articles.map((a) => a.title).filter((t) => t.length > 5);
  const headlinesBlock = formatArticlesForClaude(articles, "Reuters + AP News (NewsAPI.org) — Current Headlines", 30);

  const teamsLine = ctx.sportsTeams.length > 0
    ? `The listener follows these teams: ${ctx.sportsTeams.join(", ")}. Include a story about one if there is significant news from the last 48 hours.`
    : `No specific sports teams on file.`;

  const prompt =
    `Today is ${todayStr}. Yesterday was ${yesterdayStr}. The current year is ${currentYear}.\n\n` +
    `Here are real headlines from Reuters and AP News:\n\n${headlinesBlock}\n\n` +
    `Select the 2 most genuinely important stories for a morning briefing. Prioritise:\n` +
    `• Major world events, significant US political or economic developments, important technology or science news\n` +
    `• Broad relevance — NOT regional, NOT routine, NOT filler\n` +
    `• ${teamsLine}\n\n` +
    `NO LOCAL NEWS. NO WEATHER. NO STOCK MARKET. NO FILLER.\n\n` +
    `For EACH of the 2 selected stories, write exactly TWO sentences:\n` +
    `• Sentence 1: What happened — specific, factual, with names and numbers. Max 25 words.\n` +
    `• Sentence 2: Why it matters — real-world consequence or why a listener should care. Max 25 words.\n\n` +
    `OUTPUT FORMAT (follow exactly):\n` +
    `1. **[Bold Title — 4–6 words]** — [What happened.] [Why it matters.]\n\n` +
    `2. **[Bold Title — 4–6 words]** — [What happened.] [Why it matters.]\n\n` +
    `RULES: Exactly 2 stories. No two stories on the same topic. Never fabricate — only use headlines from the list above.`;

  logger.info("[News] Claude (top-stories-newsapi) — curating from NewsAPI headlines");

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text) throw new Error("Empty top-stories response from Claude (NewsAPI path)");
  logger.info({ chars: text.length }, "[News] Top stories via NewsAPI complete");
  return { text, rawTitles };
}

// ── Top stories via web_search (fallback) ─────────────────────────────────────

async function fetchTopStoriesViaWebSearch(userName?: string): Promise<string> {
  const ctx         = await resolveNewsContext(userName);
  const now         = new Date();
  const todayStr    = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const yesterday   = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric",
  });

  const teamsLine = ctx.sportsTeams.length > 0
    ? `The listener follows these teams: ${ctx.sportsTeams.join(", ")}. Always include a story about one of them if there is relevant news from the last 48 hours.`
    : `No specific sports teams on file — use the most significant US sports story.`;

  const currentYear = now.getFullYear();

  const mainPrompt =
    `Today is ${todayStr}. Yesterday was ${yesterdayStr}. The current year is ${currentYear}.\n\n` +
    `You are selecting the 2 most genuinely important news stories for a morning briefing. Use web search to find real, current breaking news. RECENCY IS CRITICAL — every story must be from ${todayStr} or ${yesterdayStr} only.\n\n` +
    `MANDATORY DATE VALIDATION — before including ANY story you MUST verify its publication date via web search:\n` +
    `• REJECT any story published before ${yesterdayStr} — no exceptions\n` +
    `• REJECT any story from ${currentYear - 1} or earlier\n` +
    `• If you cannot confirm a publication date of ${todayStr} or ${yesterdayStr}, skip and find another\n\n` +
    `SELECTION CRITERIA — pick the 2 stories that are:\n` +
    `• Genuinely on people's lips today — major world events, significant US political or economic developments, important technology or science news\n` +
    `• Broad in relevance — NOT regional, NOT routine, NOT filler\n` +
    `• Stories that actually matter to an intelligent adult starting their day\n\n` +
    `${teamsLine}\n\n` +
    `NO LOCAL NEWS. NO SPORTS. NO WEATHER. NO STOCK MARKET UPDATES. NO FILLER.\n\n` +
    `For EACH of the 2 stories, write exactly TWO sentences:\n` +
    `• Sentence 1: What happened — specific, factual, with names and numbers where relevant. Max 25 words.\n` +
    `• Sentence 2: Why it matters — the real-world consequence, what it signals, or why a listener should care. Max 25 words.\n\n` +
    `OUTPUT FORMAT (follow exactly — no deviations):\n` +
    `1. **[Bold Title — 4–6 words]** — [What happened, one sentence.] [Why it matters, one sentence.]\n\n` +
    `2. **[Bold Title — 4–6 words]** — [What happened, one sentence.] [Why it matters, one sentence.]\n\n` +
    `RULES:\n` +
    `• Exactly 2 stories — no more, no less\n` +
    `• Stories from ${todayStr} or ${yesterdayStr} only — publication year must be ${currentYear}\n` +
    `• No local news, no sports, no weather, no stock market, no entertainment — those have their own sections\n` +
    `• No two stories on the same topic or person\n` +
    `• Never fabricate — only real, verified, current stories`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    messages:   [{ role: "user", content: mainPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();

  if (!text) throw new Error("Empty response from Claude news web_search");
  return text;
}

// ── Core fetch: top stories + entertainment + watercooler ─────────────────────

async function fetchNewsFromClaude(userName?: string): Promise<string> {
  const { musicGenres, interests } = await resolveNewsContext(userName);
  const cleanInterests = interests
    .filter((i) => !/YMCA|pickleball|Monday|Wednesday|Friday|Saturday|morning/i.test(i))
    .slice(0, 6);

  let mainText:    string;
  let rawTitles:   string[] = [];

  if (isNewsApiConfigured()) {
    try {
      const result = await fetchTopStoriesViaNewsApi(userName);
      mainText  = result.text;
      rawTitles = result.rawTitles;
    } catch (err) {
      logger.warn({ err }, "[News] NewsAPI path failed — trying Apify fallback");
      if (isApifyNewsConfigured()) {
        const r2 = await fetchTopStoriesViaApify(userName).catch(() => null);
        if (r2) { mainText = r2.text; rawTitles = r2.rawTitles; }
        else mainText = await fetchTopStoriesViaWebSearch(userName);
      } else {
        mainText = await fetchTopStoriesViaWebSearch(userName);
      }
    }
  } else if (isApifyNewsConfigured()) {
    try {
      const result = await fetchTopStoriesViaApify(userName);
      mainText  = result.text;
      rawTitles = result.rawTitles;
    } catch (err) {
      logger.warn({ err }, "[News] Apify top-stories path failed — falling back to web_search");
      mainText = await fetchTopStoriesViaWebSearch(userName);
    }
  } else {
    mainText = await fetchTopStoriesViaWebSearch(userName);
  }

  // Store raw titles for midday comparison (keyed by userName or "_default")
  const storeKey = userName ?? "_default";
  storeMorningHeadlines(storeKey, rawTitles);

  const [watercoolerText, entertainmentText] = await Promise.all([
    fetchWatercoolerStories().catch((err) => {
      logger.warn({ err }, "[News] Watercooler fetch failed — skipping");
      return "";
    }),
    fetchEntertainmentNews(musicGenres, cleanInterests).catch((err) => {
      logger.warn({ err }, "[News] Entertainment fetch failed — skipping");
      return "";
    }),
  ]);

  const combined = [
    mainText,
    entertainmentText ? `ENTERTAINMENT:\n${entertainmentText}` : "",
    watercoolerText   ? `WATERCOOLER:\n${watercoolerText}`     : "",
  ].filter(Boolean).join("\n\n");

  logger.info({ chars: combined.length }, "[News] Morning news assembled");
  return formatNewsBlock(combined, new Date());
}

// ── Midday news check ─────────────────────────────────────────────────────────

/**
 * Re-fetches Reuters + AP via Apify and asks Claude if there is ONE genuinely
 * important story that broke since the morning briefing.
 *
 * Returns a push notification body string, or null if nothing significant.
 * Call this at 12:00 PM local time from morningPushScheduler.
 */
export async function checkMiddayNews(userName: string): Promise<string | null> {
  if (!isNewsApiConfigured() && !isApifyNewsConfigured()) {
    logger.info({ userName }, "[MiddayNews] No news source configured — skipping midday check");
    return null;
  }

  const morningTitles = getMorningHeadlines(userName);

  let current: ScrapedArticle[] = [];

  if (isNewsApiConfigured()) {
    current = await fetchNewsApiHeadlines("reuters,the-associated-press", 25).catch(() => []);
    logger.info({ count: current.length }, "[MiddayNews] Fetched via NewsAPI");
  }

  if (current.length === 0 && isApifyNewsConfigured()) {
    const [reutersResult, apResult] = await Promise.allSettled([
      fetchReutersHeadlines(20),
      fetchAPNewsHeadlines(20),
    ]);
    current = [
      ...(reutersResult.status === "fulfilled" ? reutersResult.value : []),
      ...(apResult.status      === "fulfilled" ? apResult.value      : []),
    ];
    logger.info({ count: current.length }, "[MiddayNews] Fetched via Apify fallback");
  }

  if (current.length === 0) {
    logger.info({ userName }, "[MiddayNews] No articles fetched — skipping");
    return null;
  }

  const currentBlock = formatArticlesForClaude(current, "Current Reuters + AP Headlines", 20);

  const morningBlock = morningTitles.length > 0
    ? `Morning briefing headlines (already seen):\n${morningTitles.slice(0, 15).map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "Morning headlines: not available (this is the first midday check).";

  const now      = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric",
  });

  const prompt =
    `Today is ${todayStr}. It is now noon.\n\n` +
    `${morningBlock}\n\n` +
    `${currentBlock}\n\n` +
    `Based only on the current headlines above, is there ONE genuinely important story ` +
    `that broke since this morning AND is NOT already covered by the morning headlines?\n\n` +
    `Selection bar: a story is worth a midday notification ONLY if it is major breaking news — ` +
    `a significant geopolitical event, a major market-moving announcement, an emergency of national significance, ` +
    `or a significant development in an ongoing major story. NOT a routine update, NOT sports scores, ` +
    `NOT local news, NOT celebrity news, NOT anything that can wait until tomorrow morning.\n\n` +
    `If YES: Respond with a single sentence starting with "Breaking: " that summarises what happened. ` +
    `Max 20 words. Specific and factual.\n` +
    `If NO: Respond with exactly "NONE".\n\n` +
    `Be selective. Most days the answer is NONE. Only flag something genuinely significant.`;

  try {
    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages:   [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^none$/i.test(text)) {
      logger.info({ userName }, "[MiddayNews] No significant new story — skipping push");
      return null;
    }

    logger.info({ userName, story: text.slice(0, 80) }, "[MiddayNews] Significant story found — push warranted");
    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[MiddayNews] Claude check threw");
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function preFetchMorningNews(userName?: string): Promise<void> {
  try {
    logger.info("[News] Starting morning news pre-fetch");
    const content = await fetchNewsFromClaude(userName);
    _cache = { content, fetchedAt: new Date() };
    logger.info({ chars: content.length }, "[News] Morning news pre-fetched and cached");
  } catch (err) {
    logger.warn({ err }, "[News] Morning news pre-fetch failed — will retry on demand");
  }
}

export async function fetchMorningNews(userName?: string): Promise<string> {
  if (isCacheFresh() && _cache) {
    const ageMs    = Date.now() - _cache.fetchedAt.getTime();
    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
    if (ageMs > STALE_WARN_MS) {
      logger.warn({ ageHours }, "[News] Serving STALE cached news");
    } else {
      logger.info({ ageHours, chars: _cache.content.length }, "[News] Morning news served from cache");
    }
    return _cache.content;
  }

  const TIMEOUT_MS = 120_000;
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("News fetch timed out after 120s")), TIMEOUT_MS)
  );

  try {
    const content = await Promise.race([fetchNewsFromClaude(userName), timeout]);
    _cache = { content, fetchedAt: new Date() };
    return content;
  } catch (err) {
    logger.warn({ err }, "[News] Morning news fetch failed or timed out — skipping news section");
    return "";
  }
}

// ── Formatting — parse numbered stories, populate lookup cache ────────────────

function parseNumberedStories(text: string): ParsedStory[] {
  const stories:      ParsedStory[] = [];
  const storyPattern  = /^(\d+)\.\s+\*\*(.+?)\*\*\s*[—\-:]\s*(.+)$/gm;
  let   match: RegExpExecArray | null;
  while ((match = storyPattern.exec(text)) !== null) {
    const num = parseInt(match[1]!, 10);
    if (num >= 1 && num <= 10) {
      stories.push({ number: num, title: match[2]!.trim(), summary: match[3]!.trim() });
    }
  }
  return stories;
}

function formatNewsBlock(rawText: string, fetchedAt: Date): string {
  const entertainmentMatch = rawText.match(/ENTERTAINMENT[\s:—]*([\s\S]*?)(?=WATERCOOLER[\s:—]|$)/i);
  const watercoolerMatch   = rawText.match(/WATERCOOLER[\s:—]*([\s\S]*?)$/i);
  const mainText           = rawText
    .replace(/ENTERTAINMENT[\s:—][\s\S]*/i, "")
    .replace(/WATERCOOLER[\s:—][\s\S]*/i, "")
    .trim();

  const entertainment = entertainmentMatch?.[1]?.trim() ?? "";
  const watercooler   = watercoolerMatch?.[1]?.trim()   ?? "";

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
      `[Top Stories — 2 stories, bold title + what happened + why it matters]\n\n` + mainText
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
    `\n\n[VERIFIED — Reuters + AP News — fetched at ${fetchedStr} CT, stories from past 24-48 hours]\n` +
    body
  );
}

// ── ZenQuotes daily quote ──────────────────────────────────────────────────────

async function fetchZenQuote(): Promise<{ q: string; a: string } | null> {
  try {
    const res = await fetch("https://zenquotes.io/api/today", {
      headers: { "User-Agent": "WinstonAI/1.0 morning-briefing" },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data  = await res.json() as Array<{ q: string; a: string }>;
    const quote = data[0];
    if (!quote?.q || !quote?.a) return null;
    return quote;
  } catch (err) {
    logger.warn({ err }, "[ZenQuotes] Fetch failed");
    return null;
  }
}

// ── Daily motivation ──────────────────────────────────────────────────────────

interface MotivationCache { content: string; fetchedAt: Date; }
let _motivationCache: MotivationCache | null = null;

async function fetchMotivationFromClaude(userName?: string): Promise<string> {
  const now       = new Date();
  const tz        = "America/Chicago";
  const todayStr  = now.toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const dayName         = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const ctx          = await resolveNewsContext(userName).catch(() => null);
  const displayName  = ctx?.displayName  ?? "the listener";
  const companionName = ctx?.companionName ?? "your companion";
  const teams         = ctx?.sportsTeams  ?? [];
  const music         = ctx?.musicGenres  ?? ["classic rock", "jazz"];
  const interests     = ctx?.interests    ?? [];

  // ── Step 1: Personal override (upcoming birthday/anniversary within 14 days) ──
  const upcomingDates  = await getUpcomingDates(14, userName).catch(() => []);
  const soonPersonal   = upcomingDates.filter((d) => {
    const daysOut = d.daysUntil ?? 999;
    return daysOut >= 0 && daysOut <= 14;
  });

  if (soonPersonal.length > 0) {
    const items = soonPersonal.map((d) => {
      const who  = `${d.personName}'s ${d.eventType}`;
      const days = d.daysUntil === 0 ? "TODAY" : d.daysUntil === 1 ? "tomorrow" : `in ${d.daysUntil} days`;
      return `${who}: ${days} (${d.label})`;
    }).join("; ");

    const personalPrompt =
      `Today is ${todayStr}. You are ${companionName}, ${displayName}'s trusted morning companion.\n\n` +
      `UPCOMING PERSONAL DATES: ${items}\n\n` +
      `Write a warm, genuine 2-3 sentence personal observation about this — specific, thoughtful, and personal. ` +
      `If it's a birthday, you might mention something to do for them or acknowledge the relationship. ` +
      `If it's an anniversary, acknowledge what it means. Sound like a caring friend, not a calendar app. ` +
      `Keep it brief — 2-3 sentences maximum. Do not use generic phrases like "make the most of today."`;

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages:   [{ role: "user", content: personalPrompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n").trim();
    return `[Personal Override — Morning Note]\n${text}`;
  }

  // ── Step 2: ZenQuotes + Claude personalization ──
  const zenQuote = await fetchZenQuote();
  if (zenQuote) {
    const personalizationPrompt =
      `Today is ${todayStr} (${dayName}). You are ${companionName}, ${displayName}'s trusted morning companion.\n\n` +
      `TODAY'S QUOTE: "${zenQuote.q}" — ${zenQuote.a}\n\n` +
      `CONTEXT ABOUT ${displayName.toUpperCase()}:\n` +
      `• Sports teams followed: ${teams.join(", ") || "none on file"}\n` +
      `• Music loves: ${music.join(", ")}\n` +
      (interests.length > 0 ? `• Interests: ${interests.slice(0, 6).join(", ")}\n` : "") +
      `\n` +
      `TASK: Deliver this quote naturally in 2-3 sentences, with a genuine personal connection to ${displayName}'s real life. ` +
      `Rules:\n` +
      `• Don't announce it as "today's quote" or "here's a quote"\n` +
      `• Weave it in naturally — e.g. "Here's something worth carrying through your ${dayName}:"\n` +
      `• After the quote, add one sentence connecting it to something specific in his life\n` +
      `• Sound like a trusted friend sharing something interesting, not a motivational poster\n` +
      `• Keep it to 2-3 sentences total — tight and warm\n` +
      `• STRICT PROHIBITION: Never reference current events, news, politics, world conflicts, protests, legislation, or government.`;

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 250,
      messages:   [{ role: "user", content: personalizationPrompt }],
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
    `Today is ${todayStr} (${dayName}). You are ${companionName}, ${displayName}'s trusted morning companion.\n\n` +
    `No external quote or personal override today. Generate a warm, specific, grounding 2-3 sentence thought for ${displayName}. ` +
    `Connect it to something real in ${displayName}'s life — ${interests.length > 0 ? `his interests (${interests.slice(0, 5).join(", ")}), ` : ""}his routines, or something ahead in his day. ` +
    `Sound like a trusted friend. STRICT PROHIBITION: Never reference current events, politics, or news.`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages:   [{ role: "user", content: fallbackPrompt }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n").trim();
  return text || "Today is yours to shape — make it count.";
}

export async function preFetchDailyMotivation(userName?: string): Promise<void> {
  try {
    const content = await fetchMotivationFromClaude(userName);
    _motivationCache = { content, fetchedAt: new Date() };
    logger.info({ chars: content.length }, "[Motivation] Pre-fetched and cached");
  } catch (err) {
    logger.warn({ err }, "[Motivation] Pre-fetch failed");
  }
}

export async function fetchDailyMotivation(userName?: string): Promise<string> {
  if (_motivationCache) {
    const ageMs = Date.now() - _motivationCache.fetchedAt.getTime();
    if (ageMs < 8 * 60 * 60 * 1000) {
      logger.info({ ageHours: (ageMs / 3_600_000).toFixed(1) }, "[Motivation] Served from cache");
      return _motivationCache.content;
    }
  }
  try {
    const content = await fetchMotivationFromClaude(userName);
    _motivationCache = { content, fetchedAt: new Date() };
    return content;
  } catch (err) {
    logger.warn({ err }, "[Motivation] Fetch failed — returning empty");
    return "";
  }
}
