/**
 * localContentScanner.ts
 *
 * Finds personalized local content for any city using Claude web search.
 * No hardcoded cities, venues, or publication names.
 * Uses the user's CURRENT location (from device GPS), not their profile city.
 * Profile interests drive what to search for and how to score results.
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers } from "../onboarding/onboardingManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { query } from "../db.js";
import {
  insertLocalContentItem,
  hasScannedTodayForCity,
  cleanupExpiredItems,
} from "./localContentManager.js";
import { notifyLocalContent } from "./localContentNotifier.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Expires in 7 days — gives events time to be notified before they pass
function expiresAt(daysFromNow = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// Reverse geocode lat/lon to city name using Nominatim (free, no API key)
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      {
        headers: { "User-Agent": "WinstonApp/1.0" },
        signal: AbortSignal.timeout(5000),
      }
    );
    const data = await res.json() as {
      address?: { city?: string; town?: string; village?: string; county?: string };
    };
    return (
      data.address?.city ??
      data.address?.town ??
      data.address?.village ??
      data.address?.county ??
      null
    );
  } catch {
    return null;
  }
}

interface ScannedItem {
  category: string;
  headline: string;
  summary: string;
  url: string | null;
  eventDate: string | null;
  relevanceScore: number;
  reason: string;
  source: string | null;
}

/**
 * Main scanner function.
 * Called from the background scheduler with the user's current GPS coordinates.
 */
export async function scanLocalContent(
  userName: string,
  lat?: number | null,
  lon?: number | null
): Promise<number> {
  let city: string | null = null;

  // Priority 1: live GPS coordinates passed in (from HTTP request)
  if (lat != null && lon != null) {
    city = await reverseGeocode(lat, lon);
  }

  // Priority 2: last known location stored from native app foreground ping
  if (!city) {
    const { rows } = await query<{
      last_known_city: string | null;
      last_known_lat: number | null;
      last_known_lon: number | null;
      last_location_at: Date | null;
    }>(
      `SELECT last_known_city, last_known_lat, last_known_lon, last_location_at
       FROM user_profiles WHERE user_name = $1 LIMIT 1`,
      [userName]
    );
    const loc = rows[0];
    if (loc?.last_known_city && loc.last_location_at) {
      const ageHours = (Date.now() - new Date(loc.last_location_at).getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) {
        city = loc.last_known_city;
        logger.info({ userName, city, ageHours: ageHours.toFixed(1) }, "[LocalContent] Using last known location");
      }
    }
    // If last known location is stale but we have coordinates, still use them
    if (!city && loc?.last_known_lat != null && loc?.last_known_lon != null) {
      city = await reverseGeocode(loc.last_known_lat, loc.last_known_lon);
    }
  }

  // Priority 3: profile home location
  if (!city) {
    const { rows } = await query<{
      city: string | null;
      latitude: number | null;
      longitude: number | null;
    }>(
      `SELECT city, latitude, longitude FROM user_profiles WHERE user_name = $1 LIMIT 1`,
      [userName]
    );
    const profile = rows[0];
    city = profile?.city ?? null;
    if (!city && profile?.latitude != null && profile?.longitude != null) {
      city = await reverseGeocode(profile.latitude, profile.longitude);
    }
  }

  if (!city) {
    logger.warn({ userName, lat, lon }, "[LocalContent] Could not resolve city from any source");
    return 0;
  }

  // Skip if we already scanned this city for this user recently
  if (await hasScannedTodayForCity(userName, city)) {
    logger.info({ userName, city }, "[LocalContent] Already scanned today — skipping");
    return 0;
  }

  // Load user profile for personalization
  const profile = await getProfile(userName).catch(() => null);

  // Build interest context from profile — all real, user-entered user_profiles
  // columns. profile_items ("interests"/"places" categories) is retired: there
  // was never a legitimate writer for a "favorite places" concept beyond the
  // now-deleted hardcoded seed block, and these five signals already give the
  // search prompt plenty to personalize against.
  const musicGenres = profile?.musicGenres ?? [];
  const sportsTeams = (profile?.sportsTeams ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const hobbies = profile?.hobbies ?? [];
  const favoriteRestaurants = (profile?.favoriteRestaurants ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const favoriteArtists = profile?.favoriteArtists ?? [];

  // Build the profile context string for Claude
  const profileContext = [
    musicGenres.length ? `Music they love: ${musicGenres.join(", ")}` : null,
    favoriteArtists.length ? `Favorite artists: ${favoriteArtists.join(", ")}` : null,
    sportsTeams.length ? `Sports teams: ${sportsTeams.join(", ")}` : null,
    hobbies.length ? `Hobbies and interests: ${hobbies.join(", ")}` : null,
    favoriteRestaurants.length ? `Favorite restaurants: ${favoriteRestaurants.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const today = new Date().toISOString().slice(0, 10);

  logger.info({ userName, city, lat, lon }, "[LocalContent] Starting scan");

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search" }],
      system: `You are finding local content for a specific person in ${city}.
Your job is to find things happening RIGHT NOW or in the next 2 weeks that THIS SPECIFIC PERSON
would genuinely want to know about — based on their interests below.

User's interests:
${profileContext || "No specific interests on file — find broadly appealing local events."}

Search for: concerts, live music, restaurant openings, local events, festivals, sports,
things to do — anything that would matter to this person specifically.

Be selective. Only return items that are genuinely relevant to their interests.
A jazz concert for someone who loves jazz = highly relevant.
A country concert for the same person = skip it.
A new steakhouse for a vegetarian = skip it.
A new vegan restaurant for a vegetarian = highly relevant.

After searching, return ONLY a JSON array — no explanation, no markdown fences:
[
  {
    "category": "concert|restaurant|event|sports|news",
    "headline": "one clear sentence — what it is, where, when",
    "summary": "two sentences max — why it matters, key details",
    "url": "direct link or null",
    "eventDate": "YYYY-MM-DD or null",
    "relevanceScore": 0-100,
    "reason": "one sentence — why this is relevant to this specific user",
    "source": "publication or website name or null"
  }
]

Score relevance strictly:
- 90-100: directly matches a stated interest (their favorite artist is playing, cuisine they love)
- 70-89: strong match (genre they love, type of food they prefer)
- 50-69: general interest match (something most people in their demographic would enjoy)
- Below 50: skip it entirely — don't include low-relevance items

Today is ${today}. Only include upcoming events (today through 2 weeks from now).
Return between 3 and 8 items maximum. Quality over quantity.`,
      messages: [
        {
          role: "user",
          content: `Find local content for ${city} for someone with these interests. Search for what's happening now.`,
        },
      ],
    });

    // Extract text from response
    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      logger.warn({ userName, city }, "[LocalContent] No text in Claude response");
      return 0;
    }

    // Parse JSON array from response
    const raw = textBlock.text.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn({ userName, city, preview: raw.slice(0, 200) }, "[LocalContent] No JSON array in response");
      return 0;
    }

    let items: ScannedItem[];
    try {
      items = JSON.parse(jsonMatch[0]) as ScannedItem[];
    } catch {
      logger.warn({ userName, city }, "[LocalContent] JSON parse failed");
      return 0;
    }

    if (!Array.isArray(items) || items.length === 0) {
      logger.info({ userName, city }, "[LocalContent] No items returned");
      return 0;
    }

    // Filter to high-relevance items only
    const highRelevance = items.filter(item => item.relevanceScore >= 70);

    // Save to DB
    let saved = 0;
    for (const item of highRelevance) {
      if (!item.headline || !item.category) continue;

      // Set expiry: event date + 1 day, or 7 days from now if no date
      const expiry = item.eventDate
        ? (() => {
            const d = new Date(item.eventDate + "T12:00:00");
            d.setDate(d.getDate() + 1);
            return d.toISOString().slice(0, 10);
          })()
        : expiresAt(7);

      const id = await insertLocalContentItem({
        userName,
        category: item.category,
        headline: item.headline,
        summary: item.summary ?? null,
        url: item.url ?? null,
        city,
        eventDate: item.eventDate ?? null,
        relevanceScore: item.relevanceScore,
        expiresAt: expiry,
        source: item.source ?? null,
      });

      if (id !== null) saved++;
    }

    logger.info(
      { userName, city, found: items.length, highRelevance: highRelevance.length, saved },
      "[LocalContent] Scan complete"
    );

    // Cleanup old expired items in background
    cleanupExpiredItems(userName).catch(() => {});

    return saved;
  } catch (err) {
    logger.error({ err, userName, city }, "[LocalContent] Scan failed");
    return 0;
  }
}

// ── Scheduler — twice daily per user, in each user's own local timezone ───────
// Previously a single fixed cron.schedule("0 10,15 * * *", ...) in index.ts —
// 10am/3pm UTC, which is 4-5am/9-10am Central. Fixed by ticking frequently and
// checking each user's own local hour (same per-user-timezone-gate pattern as
// backgroundEmailScanner.ts's pause-hour check), rather than one UTC cron
// expression that can only ever be correct for one timezone at a time.
//
// Windows: 11am and 3pm local. 11am (not 10am) keeps clear separation from
// morningPushScheduler's WAKE_WINDOW_MINUTES=120 retry window (a 6am wake
// time can still be retrying push delivery until 8am) and gives the morning
// briefing a few hours to have already landed, so this reads as fresh
// "what's new today" rather than duplicating the briefing. 3pm is a
// mid-afternoon lull, well ahead of evening dinner-planning time, so same-day
// evening events still have useful lead time.
const LOCAL_CONTENT_WINDOWS: Array<{ label: string; hour: number }> = [
  { label: "late-morning", hour: 11 },
  { label: "mid-afternoon", hour: 15 },
];

// userName → Set of "YYYY-MM-DD:window-label" already fired, so each window
// fires exactly once per user per day despite the tick running every 10 min.
const _firedLocalContentWindows = new Map<string, Set<string>>();

async function runLocalContentScanForUser(userName: string): Promise<void> {
  const { timezone } = await getUserLocationContext(userName).catch(() => ({ timezone: "UTC" }));
  const now = new Date();
  const nowHour = parseInt(
    now.toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
    10
  );

  const window = LOCAL_CONTENT_WINDOWS.find((w) => w.hour === nowHour);
  if (!window) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const key = `${today}:${window.label}`;
  const fired = _firedLocalContentWindows.get(userName) ?? new Set<string>();
  if (fired.has(key)) return;
  fired.add(key);
  _firedLocalContentWindows.set(userName, fired);

  try {
    const saved = await scanLocalContent(userName);
    if (saved > 0) {
      await notifyLocalContent(userName);
    }
    logger.info({ userName, window: window.label, saved }, "[LocalContent] Scheduled scan complete");
  } catch (err) {
    logger.warn({ err, userName, window: window.label }, "[LocalContent] Scheduled scan failed");
  }
}

export function startLocalContentScheduler(): void {
  let _running = false;
  cron.schedule("*/10 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers();
      await Promise.allSettled(users.map((u) => runLocalContentScanForUser(u.userName)));
    } catch (err) {
      logger.warn({ err }, "[LocalContent] Scheduler tick failed");
    } finally {
      _running = false;
    }
  });
  logger.info("[LocalContent] Scheduler started — checking every 10 min for each user's local 11am/3pm window");
}
