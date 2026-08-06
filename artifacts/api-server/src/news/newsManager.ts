import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
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

// ── Midday news check ─────────────────────────────────────────────────────────

/**
 * Re-fetches Reuters + AP via NewsAPI and asks Claude if there is ONE genuinely
 * important story worth a midday interruption.
 *
 * Returns a push notification body string, or null if nothing significant.
 * Call this at 12:00 PM local time from morningPushScheduler.
 */
export async function checkMiddayNews(userName: string): Promise<string | null> {
  if (!isNewsApiConfigured()) {
    logger.info({ userName }, "[MiddayNews] NewsAPI not configured — skipping midday check");
    return null;
  }

  const current: ScrapedArticle[] =
    await fetchNewsApiHeadlines("reuters,the-associated-press", 25).catch(() => []);
  logger.info({ count: current.length }, "[MiddayNews] Fetched via NewsAPI");

  if (current.length === 0) {
    logger.info({ userName }, "[MiddayNews] No headlines returned — skipping");
    return null;
  }

  const currentBlock = formatArticlesForClaude(current, "Current Reuters + AP Headlines", 20);

  const ctx      = await resolveNewsContext(userName).catch(() => null);
  const now      = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: (ctx?.timezone ?? "UTC"), weekday: "long", month: "long", day: "numeric",
  });

  const prompt =
    `Today is ${todayStr}. It is now noon.\n\n` +
    `${currentBlock}\n\n` +
    `Based only on the current headlines above, is there ONE genuinely important story ` +
    `worth a midday interruption?\n\n` +
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
