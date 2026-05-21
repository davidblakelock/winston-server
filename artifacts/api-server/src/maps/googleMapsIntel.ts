import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "../lib/models.js";

const GOOGLE_MAPS_ACTOR_ID = "compass/crawler-google-places";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoogleMapsPlace {
  name: string;
  address: string | null;
  phone: string | null;
  rating: number | null;
  reviewsCount: number | null;
  priceLevel: string | null;
  website: string | null;
  isOpen: boolean | null;
  todayHours: string | null;
  weeklyHours: string[] | null;
  lat: number | null;
  lng: number | null;
}

// ── DB cache ──────────────────────────────────────────────────────────────────

export async function ensureGoogleMapsCacheTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS google_maps_place_cache (
      id         serial      PRIMARY KEY,
      cache_key  text        NOT NULL UNIQUE,
      data       jsonb       NOT NULL,
      cached_at  timestamptz NOT NULL DEFAULT NOW()
    )
  `);
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCached(key: string): Promise<GoogleMapsPlace[] | null> {
  try {
    const { rows } = await query<{ data: GoogleMapsPlace[]; cached_at: string }>(
      `SELECT data, cached_at FROM google_maps_place_cache WHERE cache_key = $1`,
      [key]
    );
    if (!rows.length) return null;
    const ageMs = Date.now() - new Date(rows[0]!.cached_at).getTime();
    if (ageMs > CACHE_TTL_MS) return null;
    return rows[0]!.data as GoogleMapsPlace[];
  } catch {
    return null;
  }
}

async function setCached(key: string, data: GoogleMapsPlace[]): Promise<void> {
  try {
    await query(
      `INSERT INTO google_maps_place_cache (cache_key, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET data = $2::jsonb, cached_at = NOW()`,
      [key, JSON.stringify(data)]
    );
  } catch { /* non-fatal */ }
}

// ── Apify actor runner ────────────────────────────────────────────────────────

function normalizePlace(raw: Record<string, unknown>): GoogleMapsPlace | null {
  const name = String(raw["title"] ?? raw["name"] ?? "").trim();
  if (!name) return null;

  const address = raw["address"] ? String(raw["address"]) : null;

  const rawPhone = raw["phone"] ?? raw["phoneUnformatted"];
  const phone = rawPhone ? String(rawPhone) : null;

  const rating = typeof raw["rating"] === "number" ? raw["rating"] : null;
  const reviewsCount = typeof raw["reviewsCount"] === "number" ? raw["reviewsCount"] : null;

  let priceLevel: string | null = null;
  if (typeof raw["priceLevel"] === "string" && raw["priceLevel"]) {
    priceLevel = raw["priceLevel"];
  } else if (typeof raw["price"] === "string" && raw["price"]) {
    priceLevel = raw["price"];
  }

  const website = raw["website"] ? String(raw["website"]) : null;

  let isOpen: boolean | null = null;
  const curOH = raw["currentOpeningHours"] as Record<string, unknown> | null | undefined;
  if (curOH && typeof curOH["isOpen"] === "boolean") {
    isOpen = curOH["isOpen"];
  } else if (typeof raw["isOpen"] === "boolean") {
    isOpen = raw["isOpen"];
  } else if (typeof raw["permanentlyClosed"] === "boolean" && raw["permanentlyClosed"]) {
    isOpen = false;
  }

  let todayHours: string | null = null;
  if (curOH) {
    const ohArr = curOH["openNow"] ?? curOH["hours"];
    if (typeof ohArr === "string") todayHours = ohArr;
    else if (Array.isArray(ohArr) && ohArr.length) todayHours = String(ohArr[0]);
  }

  let weeklyHours: string[] | null = null;
  const rawOH = raw["openingHours"];
  if (Array.isArray(rawOH) && rawOH.length) {
    weeklyHours = (rawOH as Array<Record<string, string> | string>).map((h) =>
      typeof h === "string" ? h : `${h["day"] ?? h["dayOfWeek"] ?? ""}: ${h["hours"] ?? h["hoursRaw"] ?? ""}`.trim()
    ).filter(Boolean);
  }

  const loc = raw["location"] as { lat?: number; lng?: number } | null | undefined;
  const lat = typeof loc?.lat === "number" ? loc.lat : null;
  const lng = typeof loc?.lng === "number" ? loc.lng : null;

  return { name, address, phone, rating, reviewsCount, priceLevel, website, isOpen, todayHours, weeklyHours, lat, lng };
}

async function runApifyActor(
  queries: string[],
  maxPerSearch: number,
  timeoutSeconds: number
): Promise<GoogleMapsPlace[]> {
  const token = (process.env.APIFY_API_KEY ?? "").trim();
  if (!token) {
    logger.warn("[GoogleMapsIntel] APIFY_API_KEY not configured — skipping");
    return [];
  }

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(GOOGLE_MAPS_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSeconds}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchStringsArray: queries,
        maxCrawledPlacesPerSearch: maxPerSearch,
        language: "en",
        maxImages: 0,
        maxReviews: 0,
        includeHistogram: false,
        includePeopleAlsoSearch: false,
        exportPlaceUrls: false,
        deeperCitiesMode: false,
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 4) * 1000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, queries, body: body.slice(0, 200) }, "[GoogleMapsIntel] Actor run failed");
      return [];
    }

    const data = (await res.json()) as unknown;
    const items = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const places = items.map(normalizePlace).filter((p): p is GoogleMapsPlace => p !== null);
    logger.info({ queries, count: places.length }, "[GoogleMapsIntel] Actor returned results");
    return places;
  } catch (err) {
    logger.warn({ err, queries }, "[GoogleMapsIntel] Actor request threw");
    return [];
  }
}

// ── Public search API ─────────────────────────────────────────────────────────

/**
 * Search Google Maps via Apify for businesses matching a query.
 * Results are cached for 24 hours.
 *
 * @param searchQuery  Full search string, e.g. "steakhouse Dallas TX"
 * @param maxResults   Max places to return (keep ≤5 for fast responses)
 * @param timeoutSecs  Apify actor timeout (8s for chat, 20s for background tasks)
 */
export async function searchGoogleMapsPlaces(
  searchQuery: string,
  maxResults = 4,
  timeoutSecs = 8
): Promise<GoogleMapsPlace[]> {
  const cacheKey = searchQuery.toLowerCase().replace(/\s+/g, " ").trim();

  const cached = await getCached(cacheKey);
  if (cached) {
    logger.info({ cacheKey, count: cached.length }, "[GoogleMapsIntel] Cache hit");
    return cached;
  }

  logger.info({ cacheKey, maxResults, timeoutSecs }, "[GoogleMapsIntel] Running Apify Maps actor");
  const places = await runApifyActor([searchQuery], maxResults, timeoutSecs);
  if (places.length > 0) await setCached(cacheKey, places);
  return places;
}

/**
 * Search for multiple venue types near a destination address.
 * Used by departure alerts to find parking + nearby spots.
 * All searches run in parallel; each is individually cached.
 *
 * @param destination  Address string of the event destination
 * @param venueTypes   Human-readable venue types, e.g. ["parking", "cocktail bar"]
 * @param maxPerType   Max results per type (default 2)
 */
export async function searchNearbyVenueTypes(
  destination: string,
  venueTypes: string[],
  maxPerType = 2
): Promise<Map<string, GoogleMapsPlace[]>> {
  const results = new Map<string, GoogleMapsPlace[]>();

  await Promise.allSettled(
    venueTypes.map(async (type) => {
      const q = `${type} near ${destination}`;
      const cacheKey = q.toLowerCase().replace(/\s+/g, " ").trim();

      const cached = await getCached(cacheKey);
      if (cached) {
        results.set(type, cached);
        return;
      }

      const places = await runApifyActor([q], maxPerType, 20);
      if (places.length > 0) await setCached(cacheKey, places);
      results.set(type, places);
    })
  );

  return results;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatPlaceForPrompt(p: GoogleMapsPlace): string {
  const parts: string[] = [`**${p.name}**`];
  if (p.address) parts.push(`Address: ${p.address}`);
  if (p.phone) parts.push(`Phone: ${p.phone}`);
  if (p.rating != null) {
    const rev = p.reviewsCount ? ` (${p.reviewsCount.toLocaleString()} reviews)` : "";
    parts.push(`Rating: ${p.rating}⭐${rev}`);
  }
  if (p.priceLevel) parts.push(`Price: ${p.priceLevel}`);
  if (p.website) parts.push(`Website: ${p.website}`);
  if (p.isOpen != null) parts.push(p.isOpen ? "Status: Open now ✅" : "Status: Closed now ❌");
  if (p.todayHours) parts.push(`Today's hours: ${p.todayHours}`);
  return parts.join(" | ");
}

/**
 * Format a list of Google Maps places for injection into the chat system prompt.
 */
export function formatGoogleMapsPlacesForPrompt(
  places: GoogleMapsPlace[],
  cuisine: string,
  city: string
): string {
  if (!places.length) return "";
  const header =
    `\n\n[Live Google Maps Data — ${cuisine || "restaurant"} options in ${city}]\n` +
    `This is REAL current data from Google Maps (ratings, hours, phone numbers, prices). ` +
    `Base your recommendations on these actual businesses — do not invent restaurants.\n\n`;
  return header + places.map((p, i) => `${i + 1}. ${formatPlaceForPrompt(p)}`).join("\n");
}

// ── Neighborhood brief (for departure alerts) ─────────────────────────────────

/**
 * Use Claude Haiku to synthesize Google Maps neighborhood data into a natural
 * departure brief: parking tip + nearby recommendation based on user preferences.
 *
 * @param eventTitle     e.g. "Dinner at Knife"
 * @param eventTimeStr   e.g. "8:00 PM"
 * @param leaveTimeStr   e.g. "7:15 PM"
 * @param driveMinutes   e.g. 22
 * @param destination    Full address of the destination
 * @param nearbyData     Results from searchNearbyVenueTypes
 * @param userPrefs      User's food/drink preferences from profile
 */
export async function buildNeighborhoodBrief(
  eventTitle: string,
  eventTimeStr: string,
  leaveTimeStr: string,
  driveMinutes: number,
  destination: string,
  nearbyData: Map<string, GoogleMapsPlace[]>,
  userPrefs: string[]
): Promise<string | null> {
  const parking = nearbyData.get("parking") ?? [];
  const nearby = [...(nearbyData.get("bar") ?? []), ...(nearbyData.get("cocktail bar") ?? []), ...(nearbyData.get("coffee") ?? [])];

  if (!parking.length && !nearby.length) return null;

  const parkingText = parking.map((p) => formatPlaceForPrompt(p)).join("\n");
  const nearbyText = nearby.slice(0, 2).map((p) => formatPlaceForPrompt(p)).join("\n");
  const prefsNote = userPrefs.length ? `User preferences: ${userPrefs.join(", ")}` : "";

  const prompt =
    `Build a departure neighborhood brief — 2-3 SHORT sentences only. ` +
    `Be specific, natural, conversational. No greetings. No sign-offs.\n\n` +
    `Event: ${eventTitle}\n` +
    `Event time: ${eventTimeStr}\n` +
    `Leave by: ${leaveTimeStr}\n` +
    `Drive: ~${Math.round(driveMinutes / 5) * 5} min\n` +
    `Destination: ${destination}\n` +
    (parkingText ? `\nParking nearby:\n${parkingText}\n` : "") +
    (nearbyText ? `\nNearby spots:\n${nearbyText}\n` : "") +
    (prefsNote ? `\n${prefsNote}\n` : "") +
    `\nExample format: "Leave by 7:15 for your 8pm dinner at Knife. Park on McKinney Ave — easier than the lot. If you want a drink first, Midnight Rambler is a 2-minute walk."`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.find((b) => b.type === "text")?.text?.trim();
    return text ?? null;
  } catch (err) {
    logger.warn({ err }, "[GoogleMapsIntel] Neighborhood brief generation failed");
    return null;
  }
}
