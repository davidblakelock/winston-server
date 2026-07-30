/**
 * Proactive discovery scheduler — twice weekly (Monday: something to do
 * this week; Thursday: plan the weekend) around 9 AM in each user's own
 * local timezone. Consolidates what used to be two unconnected pipelines
 * (this file's Ticketmaster-only event check, and
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
 * favorite restaurants, favorite artists). 4-6 genuine picks max, matching
 * the twice-weekly (not daily) cadence — deliberately not a "here's
 * everything we found" dump. Sends exactly one push notification + SSE
 * broadcast per user per run if anything qualifies — the notification
 * itself is a generic teaser (no picks named in the title/body); the real
 * ranked list is cached server-side (getProactivePicks/setProactivePicks,
 * same in-memory pending-state pattern as pendingSaveOffers/
 * pendingAtticCleanup) and injected into chat context when the
 * notification-triggered message arrives, so Winston answers from the
 * actual curated data instead of re-guessing from the notification text.
 *
 * Dedup is keyed on (user_name, message_type) via proactive_message_log,
 * not just the calendar day the check ran on — so the same event/
 * restaurant/activity is never notified twice while it remains relevant,
 * but a different show, a different new restaurant, etc. still gets its
 * own notification. For anything with a real dateISO (a one-off show on a
 * specific night) the key includes that date, so a different occurrence
 * still gets its own shot. For anything without a real date (a standing
 * farmers market, a weekly jazz night, a newly-opened restaurant) the key
 * is name+venue instead — AI-regenerated names/descriptions aren't stable
 * run to run, so keying dateless candidates on the literal name (as
 * before) caused these long-lived facts to resurface repeatedly once their
 * wording drifted even slightly between runs.
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

// Monday run = "something to do this week"; Thursday run = "plan the
// weekend". Shapes the web-search window and the ranking bias below — the
// Ticketmaster/Places sources aren't filtered by this (no per-request date
// range on that source's shared city-level cache), ranking does the work of
// preferring what's actually imminent given the real dates each candidate
// already carries.
export type RunContext = "week" | "weekend";

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

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function candidateKey(c: Candidate): string {
  if (c.dateISO) {
    // A genuinely one-off dated event — keyed to that specific date, so a
    // different occurrence of a recurring show still gets its own shot.
    return `${c.category}:${normalize(c.name)}:${c.dateISO}`;
  }
  // No real date — treat as a long-lived fact (a standing market, a weekly
  // show, a restaurant that's still "new"). Name alone drifts between runs
  // (AI-regenerated wording), so anchor on name+venue together — venue is
  // the more stable of the two when known.
  const venuePart = c.venue ? normalize(c.venue) : "";
  return `${c.category}:${normalize(c.name)}:${venuePart}`;
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

async function searchSupplementalActivities(city: string, interests: string[], runContext: RunContext): Promise<Candidate[]> {
  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = runContext === "weekend" ? "this coming weekend (Friday through Sunday)" : "this week";
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `You are finding local activities in ${city} that ticket-aggregator sites like Ticketmaster typically don't list — wine tastings, farmers markets, pop-up shops, local meetups, art walks, and similar community/small-scale events.

This person's interests: ${interests.length ? interests.join(", ") : "no specific interests on file — find broadly appealing options"}

Search for what's happening in ${city} ${windowLabel} in these categories specifically. Skip anything that's really a concert, sports game, or theater show — those come from a different source and would be a duplicate.

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

Today is ${today}. Only include things happening ${windowLabel}. Return between 0 and 6 items — quality over quantity, return an empty array if nothing genuinely fits.`,
      messages: [{
        role: "user",
        content: `Find wine tastings, farmers markets, pop-ups, local meetups, and art walks in ${city} happening ${windowLabel}.`,
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
// fires twice across multiple runs while it remains eligible, but a
// different show, a different new restaurant, etc. still gets its own shot.
//
// This table's migration was dropped in an old cleanup pass (it originally
// backed a since-removed pickleball reminder feature) and never restored
// when this scheduler was rebuilt — the queries below have been relying on
// the table already existing in production ever since. Restored here so a
// genuinely fresh database doesn't silently fail on every check.

export async function ensureProactiveMessageLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS proactive_message_log (
      id           SERIAL PRIMARY KEY,
      user_name    TEXT NOT NULL,
      message_type TEXT NOT NULL,
      sent_date    DATE NOT NULL,
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, message_type, sent_date)
    )
  `).catch((err) => logger.warn({ err }, "[Proactive Discovery] ensureProactiveMessageLogTable failed"));
}

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
  runContext: RunContext,
): Promise<RankedPick[]> {
  if (candidates.length === 0) return [];

  const list = candidates.map((c, i) => {
    const when = c.dateLabel || c.dateISO || "ongoing";
    const where = c.venue ? ` at ${c.venue}` : "";
    return `${i + 1}. [${c.category}] "${c.name}"${where} — ${when}. ${c.description}`;
  }).join("\n");

  const biasLine = runContext === "weekend"
    ? "This is the Thursday weekend-planning check-in — favor things happening Friday through Sunday when there's a real choice, though a great weekday pick is still fine if nothing weekend-specific fits as well."
    : "This is the Monday weekly check-in — favor things happening across the coming week broadly, not just the next day or two.";

  const prompt = `${profileContext || "No specific interests on file — pick broadly appealing options."}

Candidates found in ${city}:
${list}

${biasLine}

Pick 4-6 that this specific person would genuinely enjoy — a mix across categories is fine but not required; only pick things that truly fit their interests. Be selective: if fewer than 4 genuinely fit, return fewer (even zero). Never pad the list with a weak match just to reach 4-6.

Return ONLY a JSON array of the chosen item numbers with a one-sentence reason each — no explanation, no markdown fences:
[{"index": 3, "reason": "why this fits them specifically"}]`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700, // raised from 400 — up to 6 picks with reasons now, not 3
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
      .slice(0, 6)
      .map((p) => ({ candidate: candidates[p.index - 1]!, reason: p.reason ?? "" }));
  } catch (err) {
    logger.warn({ err, city }, "[Proactive Discovery] Combined ranking failed");
    return [];
  }
}

// ── Pending picks cache — same in-memory pending-state pattern as
// pendingSaveOffers (listManager.ts) / pendingAtticCleanup
// (atticItemsManager.ts). The notification never names the picks; tapping
// it auto-sends a generic trigger message, and chatHandlerCore.ts injects
// this cached context so Winston answers from the actual curated list
// (names, reasons, venues, dates, URLs) instead of re-guessing from the
// notification text alone. Single slot per user, no TTL for the map entry
// itself — staleness is instead checked by the reader (chatHandlerCore.ts)
// against generatedAt, since a picks batch is only really current until
// the next Monday/Thursday run replaces it.

export interface PendingProactivePick {
  name:        string;
  category:    CandidateCategory;
  reason:      string;
  venue:       string | null;
  dateLabel:   string | null;
  dateISO:     string | null;
  url:         string | null;
}

export interface PendingProactivePicks {
  city:         string;
  runContext:   RunContext;
  picks:        PendingProactivePick[];
  generatedAt:  number; // Date.now() — for the reader's own staleness check
}

const _pendingPicksMap = new Map<string, PendingProactivePicks>();

export function getProactivePicks(userName: string): PendingProactivePicks | null {
  return _pendingPicksMap.get(userName) ?? null;
}

export function setProactivePicks(userName: string, state: PendingProactivePicks | null): void {
  if (state === null) {
    _pendingPicksMap.delete(userName);
  } else {
    _pendingPicksMap.set(userName, state);
  }
}

// ── Notification — a generic teaser, never the picks themselves ────────────
// The curated list is cached (above) and only actually shown once the user
// taps in — the notification tray is not the place to spoil a hand-picked
// list; it's meant to earn the tap, not replace it.

async function sendPicksNotification(userName: string, city: string, picks: RankedPick[], runContext: RunContext): Promise<void> {
  const title = runContext === "weekend"
    ? "✨ Weekend plans?"
    : "✨ A few things worth checking out this week";
  const body = "Tap to see what I found.";

  // Generic trigger — no pick names embedded here. The real content is
  // cached below and injected into chat context, so Winston already has
  // everything it needs to answer from real data the moment this lands.
  const message = "What did you find for me?";

  try {
    await sendFcmNotification({
      userName,
      notificationType: "proactive_event",
      title,
      body,
      data: { action: "send_message", message },
    });
    logger.info({ userName, count: picks.length, runContext }, "[Proactive Discovery] Push sent (teaser — picks cached, not in notification)");
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Discovery] Push send failed");
  }

  try {
    broadcastToUser(userName, "proactive", { message: body, type: "event" });
  } catch (err) {
    logger.warn({ err, userName }, "[Proactive Discovery] SSE broadcast failed");
  }

  setProactivePicks(userName, {
    city,
    runContext,
    generatedAt: Date.now(),
    picks: picks.map((p) => ({
      name:      p.candidate.name,
      category:  p.candidate.category,
      reason:    p.reason,
      venue:     p.candidate.venue,
      dateLabel: p.candidate.dateLabel,
      dateISO:   p.candidate.dateISO,
      url:       p.candidate.url,
    })),
  });

  const markedKeys = picks.map((p) => ({ name: p.candidate.name, venue: p.candidate.venue, key: candidateKey(p.candidate) }));
  logger.info({ userName, markedKeys }, "[Proactive Discovery] Dedup — marking these keys notified");
  await Promise.all(picks.map((p) => markNotified(userName, candidateKey(p.candidate))));
}

// ── Per-user orchestration ──────────────────────────────────────────────────

export async function checkUserForEvent(user: ActiveUser, runContext: RunContext): Promise<void> {
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
    searchSupplementalActivities(city, userInterests, runContext),
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
  const keys = candidates.map((c) => candidateKey(c));
  const alreadyNotified = await Promise.all(keys.map((k) => hasBeenNotified(userName, k)));
  const skippedLog = candidates
    .map((c, i) => ({ name: c.name, venue: c.venue, key: keys[i], skip: alreadyNotified[i] }))
    .filter((c) => c.skip);
  if (skippedLog.length > 0) {
    logger.info({ userName, skipped: skippedLog }, "[Proactive Discovery] Dedup — skipping already-notified candidates");
  }
  candidates = candidates.filter((_, i) => !alreadyNotified[i]);

  if (candidates.length === 0) {
    logger.info({ userName, city }, "[Proactive Discovery] All candidates already notified — skipping");
    return;
  }

  const picks = await rankCandidates(candidates, profileContext, city, runContext);
  if (picks.length === 0) {
    logger.info({ userName, city, candidateCount: candidates.length }, "[Proactive Discovery] Nothing genuinely matched — skipping");
    return;
  }

  await sendPicksNotification(userName, city, picks, runContext);
}

// ── Scheduling — twice weekly, in each user's own local morning ───────────────
// Previously a single fixed cron.schedule("15 9 * * *", ...) with no timezone
// option — node-cron runs that against the server process's own timezone
// (UTC on Railway), so it actually fired at 9:15 AM UTC (3:15/4:15 AM Central),
// not "9:15 AM CT" as the old comments claimed. Fixed by ticking frequently
// and checking each user's own local hour via getUserLocationContext(), same
// per-user-timezone-gate pattern as localContentScanner.ts's scheduler and
// medicationScheduler.ts's cache-gated tick. Monday/Thursday gate added on
// top of that same per-user-local-time check, computed in the user's own
// timezone (not server time) for the same reason the hour check is.
const FIRE_LOCAL_HOUR = 9; // 9:xx AM local — after the morning briefing has landed

function runContextForWeekday(weekday: string): RunContext | null {
  if (weekday === "Mon") return "week";
  if (weekday === "Thu") return "weekend";
  return null;
}

// userName → date (local to that user) already fired, so the check runs
// exactly once per user per eligible day despite the tick running every 10 min.
const _firedToday = new Map<string, string>();

async function runPerUserCheck(user: ActiveUser): Promise<void> {
  const { timezone } = await getUserLocationContext(user.userName).catch(() => ({ timezone: "UTC" }));
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
    10
  );
  if (localHour !== FIRE_LOCAL_HOUR) return;

  const weekday = now.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" });
  const runContext = runContextForWeekday(weekday);
  if (!runContext) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  if (_firedToday.get(user.userName) === today) return;
  _firedToday.set(user.userName, today);

  try {
    await checkUserForEvent(user, runContext);
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
  ensureProactiveMessageLogTable().catch((err) =>
    logger.warn({ err }, "[Proactive Event] ensureProactiveMessageLogTable failed on startup")
  );

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

  logger.info("[Proactive Event] Scheduler started — checking every 10 min for each user's local Monday/Thursday 9am hour");
}
