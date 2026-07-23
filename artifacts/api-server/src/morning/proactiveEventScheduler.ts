/**
 * Proactive discovery scheduler — once per day around 9 AM in each user's
 * own local timezone. Consolidates what used to be two unconnected
 * pipelines (this file's Ticketmaster-only event check, and
 * localContent/localContentScanner.ts's separate Claude-web-search-only
 * scan) into one system combining three candidate sources:
 *
 *   1. Ticketmaster events — apifyEventsManager.fetchCandidateEvents()
 *      (direct API, falls back to an Apify actor)
 *   2. Claude web search — categories Ticketmaster covers poorly (wine
 *      tastings, farmers markets, pop-ups, local meetups, art walks)
 *   3. Google Places — newly-opened restaurants (google/places.ts's
 *      searchRestaurants(), previously dead code with zero callers)
 *
 * All candidates are combined and ranked in ONE Claude call against the
 * user's real profile signals (hobbies, music genres, sports teams,
 * favorite restaurants, favorite artists). 2-3 genuine picks max — this is
 * deliberately not a "here's everything we found" dump. Sends exactly one
 * push notification + SSE broadcast per user per day if anything qualifies.
 *
 * Dedup is keyed on (user_name, category + name + date) via
 * proactive_message_log, not just the calendar day the check ran on — so
 * the same event/restaurant/activity is never notified twice while it
 * remains relevant, but a different show, a different new restaurant, etc.
 * still gets its own notification.
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { getActiveUsers, getProfile, type ActiveUser } from "../onboarding/onboardingManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { fetchCandidateEvents, type LocalEvent } from "../events/apifyEventsManager.js";
import { searchRestaurants } from "../google/places.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Unified candidate shape across all three sources ───────────────────────

type CandidateCategory = "event" | "activity" | "restaurant";

interface Candidate {
  category:  CandidateCategory;
  name:      string;
  description: string;
  venue:     string | null;
  dateISO:   string | null;  // null for restaurants — not a dated event
  dateLabel: string | null;
  url:       string | null;
  source:    "ticketmaster" | "web_search" | "google_places";
}

function candidateKey(c: Candidate): string {
  return `${c.category}:${c.name}:${c.dateISO ?? "ongoing"}`;
}

// ── Source 1: Ticketmaster events ───────────────────────────────────────────

function eventsToCandidates(events: LocalEvent[]): Candidate[] {
  return events.map((e): Candidate => ({
    category: "event",
    name: e.name,
    description: e.description,
    venue: e.venue || null,
    dateISO: e.dateISO || null,
    dateLabel: e.date || null,
    url: e.url || null,
    source: "ticketmaster",
  }));
}

// ── Source 2: Claude web search — categories Ticketmaster misses ──────────
// Same web_search_20250305 tool pattern proven in the retired
// localContent/localContentScanner.ts.

interface WebSearchItem {
  name: string;
  description: string;
  venue: string | null;
  eventDate: string | null; // YYYY-MM-DD or null
  url: string | null;
}

async function searchSupplementalActivities(city: string, interests: string[]): Promise<Candidate[]> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `You are finding local activities in ${city} that ticket-aggregator sites like Ticketmaster typically don't list — wine tastings, farmers markets, pop-up shops, local meetups, art walks, and similar community/small-scale events.

This person's interests: ${interests.length ? interests.join(", ") : "no specific interests on file — find broadly appealing options"}

Search for what's happening in ${city} in the next 2 weeks in these categories specifically. Skip anything that's really a concert, sports game, or theater show — those come from a different source and would be a duplicate.

After searching, return ONLY a JSON array — no explanation, no markdown fences:
[
  {
    "name": "clear name of the activity",
    "description": "one sentence — what it is, why it might matter",
    "venue": "location name or null",
    "eventDate": "YYYY-MM-DD or null if recurring/ongoing",
    "url": "direct link or null"
  }
]

Today is ${today}. Only include things happening from today through 2 weeks out. Return between 0 and 6 items — quality over quantity, return an empty array if nothing genuinely fits.`,
      messages: [{
        role: "user",
        content: `Find wine tastings, farmers markets, pop-ups, local meetups, and art walks in ${city} happening soon.`,
      }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return [];

    const jsonMatch = textBlock.text.trim().match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const items = JSON.parse(jsonMatch[0]) as WebSearchItem[];
    if (!Array.isArray(items)) return [];

    return items
      .filter((i) => i.name && i.name.length > 3)
      .map((i): Candidate => ({
        category: "activity",
        name: i.name,
        description: i.description ?? "",
        venue: i.venue ?? null,
        dateISO: i.eventDate ?? null,
        dateLabel: null,
        url: i.url ?? null,
        source: "web_search",
      }));
  } catch (err) {
    logger.warn({ err, city }, "[Proactive Discovery] Web search supplemental pass failed");
    return [];
  }
}

// ── Source 3: Google Places — newly-opened restaurants ─────────────────────
// Reuses searchRestaurants() from google/places.ts, previously dead code
// with zero callers — same cuisine-based query pattern, "new" as the query.

async function searchNewRestaurants(city: string): Promise<Candidate[]> {
  try {
    const places = await searchRestaurants("new", city, 6);
    return places.map((p): Candidate => ({
      category: "restaurant",
      name: p.name,
      description: [
        p.rating ? `${p.rating.toFixed(1)}★${p.userRatingCount ? ` (${p.userRatingCount} reviews)` : ""}` : null,
        p.priceLevel ?? null,
        p.primaryType && p.primaryType.toLowerCase() !== "restaurant" ? p.primaryType : null,
      ].filter(Boolean).join(" · "),
      venue: p.address ?? null,
      dateISO: null,
      dateLabel: null,
      url: null,
      source: "google_places",
    }));
  } catch (err) {
    logger.warn({ err, city }, "[Proactive Discovery] Google Places restaurant search failed");
    return [];
  }
}

// ── Dedup — proactive_message_log, keyed per candidate not just per day ───
// Deliberately not scoped to today's date, so the same candidate never
// fires twice across multiple daily runs while it remains eligible, but a
// different show, a different new restaurant, etc. still gets its own shot.

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
}

async function hasBeenNotified(userName: string, key: string): Promise<boolean> {
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM proactive_message_log
       WHERE user_name = $1 AND message_type = $2`,
      [userName, key]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

async function markNotified(userName: string, key: string): Promise<void> {
  try {
    await query(
      `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, message_type, sent_date) DO NOTHING
       RETURNING user_name`,
      [userName, key, todayStr()]
    );
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Discovery] Failed to mark sent");
  }
}

// ── Combined personalized ranking — ONE Claude call across all sources ────
// Mirrors the relevance-scoring approach from the retired
// localContentScanner.ts, applied across heterogeneous candidate types.

interface RankedPick {
  candidate: Candidate;
  reason: string;
}

async function rankCandidates(
  candidates: Candidate[],
  profileContext: string,
  city: string,
): Promise<RankedPick[]> {
  if (candidates.length === 0) return [];

  const list = candidates.map((c, i) => {
    const when = c.dateLabel || c.dateISO || "ongoing";
    const where = c.venue ? ` at ${c.venue}` : "";
    return `${i + 1}. [${c.category}] "${c.name}"${where} — ${when}. ${c.description}`;
  }).join("\n");

  const prompt = `${profileContext || "No specific interests on file — pick broadly appealing options."}

Candidates found in ${city}:
${list}

Pick 2-3 that this specific person would genuinely enjoy — a mix across categories is fine but not required; only pick things that truly fit their interests. Be selective: if fewer than 2 genuinely fit, return fewer (even zero). Never pad the list with a weak match just to reach 2-3.

Return ONLY a JSON array of the chosen item numbers with a one-sentence reason each — no explanation, no markdown fences:
[{"index": 3, "reason": "why this fits them specifically"}]`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const picks = JSON.parse(jsonMatch[0]) as Array<{ index: number; reason: string }>;
    if (!Array.isArray(picks)) return [];
    return picks
      .filter((p) => p.index >= 1 && p.index <= candidates.length)
      .slice(0, 3)
      .map((p) => ({ candidate: candidates[p.index - 1]!, reason: p.reason ?? "" }));
  } catch (err) {
    logger.warn({ err, city }, "[Proactive Discovery] Combined ranking failed");
    return [];
  }
}

// ── Notification — one push covering all picks ─────────────────────────────

const CATEGORY_EMOJI: Record<CandidateCategory, string> = {
  event: "🎵",
  activity: "📍",
  restaurant: "🍽️",
};

async function sendPicksNotification(userName: string, city: string, picks: RankedPick[]): Promise<void> {
  const single = picks.length === 1 ? picks[0]! : null;

  const title = single
    ? `${CATEGORY_EMOJI[single.candidate.category]} ${single.candidate.name}`
    : `✨ ${picks.length} things you might enjoy in ${city}`;

  const body = single
    ? single.reason || `${single.candidate.dateLabel || single.candidate.dateISO || ""} ${single.candidate.venue ? `at ${single.candidate.venue}` : ""}`.trim()
    : picks.map((p) => {
        const when = p.candidate.dateLabel || p.candidate.dateISO ? ` (${p.candidate.dateLabel || p.candidate.dateISO})` : "";
        return `${p.candidate.name}${when}`;
      }).join(" · ");

  const message =
    `Tell me more about ${picks.length > 1 ? "these" : "this"}: ${picks.map((p) => p.candidate.name).join(", ")} — ` +
    `in ${city}. Why did you think I'd like ${picks.length > 1 ? "them" : "it"}?`;

  try {
    await sendFcmNotification({
      userName,
      notificationType: "proactive_event",
      title,
      body,
      data: { action: "send_message", message },
    });
    logger.info({ userName, picks: picks.map((p) => p.candidate.name) }, "[Proactive Discovery] Push sent");
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Discovery] Push send failed");
  }

  try {
    broadcastToUser(userName, "proactive", { message: body, type: "event" });
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Discovery] SSE broadcast failed");
  }

  await Promise.all(picks.map((p) => markNotified(userName, candidateKey(p.candidate))));
}

// ── Per-user orchestration ──────────────────────────────────────────────────

async function checkUserForEvent(user: ActiveUser): Promise<void> {
  const { userName } = user;

  const profile = await getProfile(userName).catch(() => null);
  const location = await getUserLocationContext(userName).catch(() => null);
  const city = location?.city ?? profile?.city ?? "";
  if (!city) {
    logger.info({ userName }, "[Proactive Discovery] No known city — skipping");
    return;
  }

  const favoriteArtists = profile?.favoriteArtists ?? [];
  const musicGenres = profile?.musicGenres ?? [];
  const hobbies = profile?.hobbies ?? [];
  const sportsTeams = profile?.sportsTeams
    ? profile.sportsTeams.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const favoriteRestaurants = profile?.favoriteRestaurants
    ? profile.favoriteRestaurants.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const userInterests = [...sportsTeams, ...hobbies, ...musicGenres].filter(Boolean);

  // Same personalization-context shape as the retired localContentScanner.ts.
  const profileContext = [
    musicGenres.length ? `Music they love: ${musicGenres.join(", ")}` : null,
    favoriteArtists.length ? `Favorite artists: ${favoriteArtists.join(", ")}` : null,
    sportsTeams.length ? `Sports teams: ${sportsTeams.join(", ")}` : null,
    hobbies.length ? `Hobbies and interests: ${hobbies.join(", ")}` : null,
    favoriteRestaurants.length ? `Favorite restaurants: ${favoriteRestaurants.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const [events, activities, restaurants] = await Promise.all([
    fetchCandidateEvents(city, favoriteArtists).catch((): LocalEvent[] => []),
    searchSupplementalActivities(city, userInterests),
    searchNewRestaurants(city),
  ]);

  let candidates: Candidate[] = [
    ...eventsToCandidates(events),
    ...activities,
    ...restaurants,
  ];

  if (candidates.length === 0) {
    logger.info({ userName, city }, "[Proactive Discovery] No candidates found from any source");
    return;
  }

  // Drop anything already notified before spending a ranking call on it.
  const alreadyNotified = await Promise.all(candidates.map((c) => hasBeenNotified(userName, candidateKey(c))));
  candidates = candidates.filter((_, i) => !alreadyNotified[i]);

  if (candidates.length === 0) {
    logger.info({ userName, city }, "[Proactive Discovery] All candidates already notified — skipping");
    return;
  }

  const picks = await rankCandidates(candidates, profileContext, city);
  if (picks.length === 0) {
    logger.info({ userName, city, candidateCount: candidates.length }, "[Proactive Discovery] Nothing genuinely matched — skipping");
    return;
  }

  await sendPicksNotification(userName, city, picks);
}

// ── Scheduling — once daily, in each user's own local morning ─────────────────
// Previously a single fixed cron.schedule("15 9 * * *", ...) with no timezone
// option — node-cron runs that against the server process's own timezone
// (UTC on Railway), so it actually fired at 9:15 AM UTC (3:15/4:15 AM Central),
// not "9:15 AM CT" as the old comments claimed. Fixed by ticking frequently
// and checking each user's own local hour via getUserLocationContext(), same
// per-user-timezone-gate pattern as localContentScanner.ts's scheduler and
// medicationScheduler.ts's cache-gated tick.
const FIRE_LOCAL_HOUR = 9; // 9:xx AM local — after the morning briefing has landed

// userName → date (local to that user) already fired, so the check runs
// exactly once per user per day despite the tick running every 10 min.
const _firedToday = new Map<string, string>();

async function runPerUserCheck(user: ActiveUser): Promise<void> {
  const { timezone } = await getUserLocationContext(user.userName).catch(() => ({ timezone: "UTC" }));
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
    10
  );
  if (localHour !== FIRE_LOCAL_HOUR) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  if (_firedToday.get(user.userName) === today) return;
  _firedToday.set(user.userName, today);

  try {
    await checkUserForEvent(user);
  } catch (err) {
    logger.warn({ err, userName: user.userName }, "[Proactive Event] Per-user check failed");
  }
}

async function runProactiveEventCheck(): Promise<void> {
  let users: ActiveUser[];
  try {
    users = await getActiveUsers();
  } catch (err) {
    logger.warn({ err }, "[Proactive Event] Failed to load active users");
    return;
  }

  await Promise.allSettled(users.map((u) => runPerUserCheck(u)));
}

export function startProactiveEventScheduler(): void {
  let _running = false;
  cron.schedule("*/10 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      await runProactiveEventCheck();
    } catch (err) {
      logger.error({ err }, "[Proactive Event] Scheduler tick error");
    } finally {
      _running = false;
    }
  });

  logger.info("[Proactive Event] Scheduler started — checking every 10 min for each user's local 9am hour");
}
