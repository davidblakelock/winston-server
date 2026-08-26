import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { getCachedResult, setCachedResult } from "../lib/resultCache.js";
import {
  formatArticlesForClaude,
  isNewsApiConfigured,
  fetchNewsApiHeadlines,
  type ScrapedArticle,
} from "./newsApiManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Resolve user context ──────────────────────────────────────────────────────

interface ProfilePerson {
  name:         string;
  relationship: string;
  city?:        string;
}

interface NewsContext {
  displayName:   string;
  companionName: string;
  city:          string;
  state:         string;
  sportsTeams:   string[];
  interests:     string[];
  musicGenres:   string[];
  timezone:      string;
  partner:       ProfilePerson | null;
  family:        ProfilePerson[];
}

const PARTNER_RELS = /^(partner|girlfriend|boyfriend|spouse|wife|husband|fiancée?|fiancee?)/i;
const FAMILY_RELS  = /^(daughter|son|child|parent|mother|father|mom|dad|brother|sister|sibling|grandm|grandp|stepmom|stepdad|stepson|stepdaughter)/i;

async function resolveNewsContext(userName?: string): Promise<NewsContext> {
  if (!userName) return {
    displayName: "the listener", companionName: "your companion",
    city: "", state: "",
    sportsTeams: [], interests: [], musicGenres: [], timezone: "UTC",
    partner: null, family: [],
  };
  const profile = await getProfile(userName).catch(() => null);
  const city    = profile?.city ?? "";
  const raw     = (profile?.rawData ?? {}) as Record<string, unknown>;
  const people  = (raw["people"] as ProfilePerson[] | undefined) ?? [];
  const partner = people.find((p) => PARTNER_RELS.test(p.relationship)) ?? null;
  const family  = people.filter((p) => FAMILY_RELS.test(p.relationship));
  return {
    displayName:   (profile?.name ?? userName) as string,
    companionName: (profile?.companionName as string | undefined) ?? "your companion",
    city,
    state:         (raw["state"] as string | undefined) ?? "",
    sportsTeams:   (raw["sportsTeams"] as string[] | undefined) ?? [],
    interests:     (raw["interests"]   as string[] | undefined) ?? [],
    musicGenres:   (raw["music"]       as string[] | undefined) ?? [],
    timezone:      profile?.timezone ?? "UTC",
    partner,
    family,
  };
}

// ── Breaking news polling ─────────────────────────────────────────────────────

const STATE_CACHE_KEY_PREFIX = "breaking_news_state:";
// No real cap needed — setCachedResult overwrites this key every poll, so
// TTL here only matters if polling stops entirely; a generous window just
// avoids an ancient row being misread as fresh in that dead-feature case.
const STATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface BreakingNewsState {
  date:           string;   // en-CA date key, resets alertedStories when it changes
  alertedStories: string[]; // brief alert texts already sent today — prevents re-alerting the same story every poll while it's still leading
  lastPolledAt:   string;   // ISO timestamp — gates poll frequency, restart-safe since it's DB-persisted
}

async function loadState(userName: string, todayKey: string): Promise<BreakingNewsState> {
  const raw = await getCachedResult(STATE_CACHE_KEY_PREFIX + userName, STATE_CACHE_TTL_MS).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BreakingNewsState;
      if (parsed.date === todayKey) return parsed;
    } catch { /* fall through to fresh state */ }
  }
  return { date: todayKey, alertedStories: [], lastPolledAt: "" };
}

async function saveState(userName: string, state: BreakingNewsState): Promise<void> {
  await setCachedResult(STATE_CACHE_KEY_PREFIX + userName, JSON.stringify(state));
}

/**
 * Returns true if enough real time has passed since the last poll to run
 * another one — the actual gate on poll frequency. Callers should poll
 * frequently (e.g. every tick of a per-minute cron) and rely on this to
 * self-throttle rather than trying to align calls to exact clock marks,
 * which doesn't survive server restarts cleanly.
 */
export async function shouldPollBreakingNews(userName: string, intervalMinutes: number): Promise<boolean> {
  const todayKey = new Date().toLocaleDateString("en-CA");
  const state = await loadState(userName, todayKey);
  if (!state.lastPolledAt) return true;
  const elapsedMin = (Date.now() - new Date(state.lastPolledAt).getTime()) / 60000;
  return elapsedMin >= intervalMinutes;
}

/**
 * Re-fetches AP + BBC via NewsAPI and asks Claude if there is ONE genuinely
 * important NEW story worth an interruption — "new" meaning not already
 * alerted today, so a major story that's still leading the headlines an
 * hour after it broke doesn't trigger a repeat push every time this runs.
 *
 * Returns a push notification body string, or null if nothing significant.
 * Intended to be called periodically (see shouldPollBreakingNews) rather
 * than at one fixed time — a single once-a-day check misses anything that
 * breaks outside that exact window until the next day's check, by which
 * point it's no longer breaking news.
 */
export async function checkForBreakingNews(userName: string): Promise<string | null> {
  if (!isNewsApiConfigured()) {
    logger.info({ userName }, "[BreakingNews] NewsAPI not configured — skipping check");
    return null;
  }

  const todayKey = new Date().toLocaleDateString("en-CA");
  const state = await loadState(userName, todayKey);

  const current: ScrapedArticle[] =
    await fetchNewsApiHeadlines("associated-press,bbc-news", 25).catch(() => []);
  logger.info({ count: current.length, userName }, "[BreakingNews] Fetched via NewsAPI");

  // Record the poll attempt regardless of outcome below — this is what
  // shouldPollBreakingNews throttles against, so a thin/failed fetch still
  // needs to count as "checked" or the next tick would just retry immediately.
  state.lastPolledAt = new Date().toISOString();

  if (current.length === 0) {
    logger.info({ userName }, "[BreakingNews] No headlines returned — skipping");
    await saveState(userName, state);
    return null;
  }

  const currentBlock = formatArticlesForClaude(current, "Current AP + BBC Headlines", 20);

  const ctx      = await resolveNewsContext(userName).catch(() => null);
  const now      = new Date();
  const timeStr  = now.toLocaleTimeString("en-US", {
    timeZone: (ctx?.timezone ?? "UTC"), hour: "numeric", minute: "2-digit",
  });
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: (ctx?.timezone ?? "UTC"), weekday: "long", month: "long", day: "numeric",
  });

  const alreadyAlertedBlock = state.alertedStories.length > 0
    ? `\n\nAlready alerted today (do NOT re-flag these, or a continuation/update of the same event, unless something SUBSTANTIALLY new has happened since):\n${state.alertedStories.map((s) => `- ${s}`).join("\n")}`
    : "";

  const prompt =
    `Today is ${todayStr}. It is now ${timeStr}.\n\n` +
    `${currentBlock}${alreadyAlertedBlock}\n\n` +
    `Based only on the current headlines above, is there ONE genuinely important NEW story ` +
    `worth an interruption right now?\n\n` +
    `Selection bar: a story is worth a notification ONLY if it is major breaking news — ` +
    `a significant geopolitical event, a major market-moving announcement, an emergency of national significance, ` +
    `or a substantial new development in an ongoing major story. NOT a routine update, NOT sports scores, ` +
    `NOT local news, NOT celebrity news, NOT anything that can wait until tomorrow morning, and NOT ` +
    `something already covered by the "already alerted today" list above unless there's a real, substantial development.\n\n` +
    `If YES: Respond with a single sentence starting with "Breaking: " that summarises what happened. ` +
    `Max 20 words. Specific and factual.\n` +
    `If NO: Respond with exactly "NONE".\n\n` +
    `Be selective. Most checks the answer is NONE. Only flag something genuinely significant and genuinely new.`;

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
      logger.info({ userName }, "[BreakingNews] No significant new story — skipping push");
      await saveState(userName, state);
      return null;
    }

    logger.info({ userName, story: text.slice(0, 80) }, "[BreakingNews] Significant story found — push warranted");
    state.alertedStories.push(text);
    await saveState(userName, state);
    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[BreakingNews] Claude check threw");
    await saveState(userName, state);
    return null;
  }
}
