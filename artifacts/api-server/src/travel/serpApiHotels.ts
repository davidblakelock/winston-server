/**
 * SerpAPI Google Hotels integration
 *
 * Called exclusively from tripPlanningManager.ts after GPT-4o recommends
 * specific hotels by name. Provides real nightly rates and booking URLs for
 * the exact check-in/check-out dates in the itinerary.
 *
 * Free tier: 100 searches/month — enforced via max 3 searches per itinerary.
 * Results cached in the apify_cache table (6 h TTL) — never searches twice
 * for the same hotel + date combo.
 *
 * Fallback chain:
 *   1. SerpAPI Google Hotels (price + booking URL)
 *   2. Google Places text search (website URL only, no pricing)
 *   3. Plain hotel name with no URL
 */

import { logger } from "../lib/logger.js";
import { getCachedApify, setCachedApify } from "../lib/apifyCache.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getSerpApiKey(): string {
  return (process.env.SERPAPI_KEY ?? "").trim();
}

export function isSerpApiReady(): boolean {
  return getSerpApiKey().length > 10;
}

function getPlacesKey(): string {
  return (process.env.GOOGLE_PLACES_API_KEY ?? "").trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 60);
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface SerpHotelResult {
  name: string;
  bookingUrl: string;     // Google Hotels link with date context
  websiteUrl?: string;    // Hotel's own website (from Places fallback)
  pricePerNight?: string; // e.g. "$189/night" — only when SerpAPI returns pricing
  rating?: number;
  reviewCount?: number;
  available: boolean;
  source: "serpapi" | "places" | "none";
}

// ── SerpAPI response shapes ───────────────────────────────────────────────────

interface SerpProperty {
  name?: string;
  link?: string;
  overall_rating?: number;
  reviews?: number;
  hotel_class?: string;
  rate_per_night?: {
    lowest?: string;
    extracted_lowest?: number;
    before_taxes_fees?: string;
  };
}

interface SerpResponse {
  properties?: SerpProperty[];
  error?: string;
}

// ── Name matching ─────────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(hotel|the|a|an|inn|suites?|resort|motel|lodge|boutique|grand|royal|by|at|and|&)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBestMatch(hotelName: string, properties: SerpProperty[]): SerpProperty | null {
  if (!properties.length) return null;

  const normTarget = normalizeForMatch(hotelName);
  let bestScore = 0;
  let bestProp: SerpProperty | null = null;

  for (const prop of properties) {
    if (!prop.name) continue;
    const normProp = normalizeForMatch(prop.name);

    let score = 0;
    if (normProp === normTarget) {
      score = 100;
    } else if (normProp.includes(normTarget) || normTarget.includes(normProp)) {
      score = 80;
    } else {
      const targetWords = normTarget.split(" ").filter((w) => w.length > 2);
      const propWords   = new Set(normProp.split(" ").filter((w) => w.length > 2));
      const overlap     = targetWords.filter((w) => propWords.has(w)).length;
      score = targetWords.length > 0 ? Math.round((overlap / targetWords.length) * 60) : 0;
    }

    if (score > bestScore) {
      bestScore = score;
      bestProp  = prop;
    }
  }

  // Accept if reasonable match, or just take the top result (most relevant to the query)
  return bestProp ?? properties[0] ?? null;
}

// ── Google Places fallback (website URL only) ─────────────────────────────────

async function lookupHotelWebsiteViaPlaces(
  hotelName: string,
  city: string,
): Promise<string | null> {
  const key = getPlacesKey();
  if (!key) return null;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.websiteUri",
      },
      body: JSON.stringify({
        textQuery:       `${hotelName} ${city}`,
        includedType:    "lodging",
        maxResultCount:  1,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { places?: Array<{ websiteUri?: string }> };
    return data.places?.[0]?.websiteUri ?? null;
  } catch {
    return null;
  }
}

// ── Main SerpAPI search ───────────────────────────────────────────────────────

/**
 * Search Google Hotels via SerpAPI for a specific hotel and check-in/check-out dates.
 *
 * Checks cache first — never calls SerpAPI twice for the same hotel + check-in combo.
 * Falls back to Google Places for the website URL if SerpAPI finds nothing.
 * Returns a result with `available: false` and `source: "none"` as a last resort
 * so callers always get a non-null value and can degrade gracefully.
 */
export async function searchHotelViaSerpApi(
  hotelName: string,
  city:      string,
  checkIn:   string,  // YYYY-MM-DD
  checkOut:  string,  // YYYY-MM-DD
  adults:    number,
): Promise<SerpHotelResult> {
  const cacheKey = `serp:hotel:${slugify(hotelName)}:${checkIn}`;

  // ── Cache check ───────────────────────────────────────────────────────────
  const cached = await getCachedApify(cacheKey, CACHE_TTL_MS);
  if (cached) {
    try {
      const result = JSON.parse(cached) as SerpHotelResult;
      logger.info({ hotelName, checkIn, cacheKey }, "[SerpAPI] Cache hit — skipping live search");
      return result;
    } catch { /* fall through to live fetch */ }
  }

  const serpKey = getSerpApiKey();
  if (!serpKey) {
    logger.warn({ hotelName }, "[SerpAPI] SERPAPI_KEY not set — falling back to Places");
    return await placesOnlyResult(hotelName, city, cacheKey);
  }

  // ── Live SerpAPI call ─────────────────────────────────────────────────────
  const query = `${hotelName} ${city} availability ${checkIn}`;
  const url   = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine",          "google_hotels");
  url.searchParams.set("q",               query);
  url.searchParams.set("check_in_date",   checkIn);
  url.searchParams.set("check_out_date",  checkOut);
  url.searchParams.set("adults",          String(adults));
  url.searchParams.set("currency",        "USD");
  url.searchParams.set("api_key",         serpKey);

  logger.info({ hotelName, city, checkIn, checkOut, adults, query }, "[SerpAPI] Searching Google Hotels");

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, hotelName, body: body.slice(0, 200) }, "[SerpAPI] Request failed — falling back to Places");
      return await placesOnlyResult(hotelName, city, cacheKey);
    }

    const data  = await res.json() as SerpResponse;

    if (data.error) {
      logger.warn({ error: data.error, hotelName }, "[SerpAPI] API error — falling back to Places");
      return await placesOnlyResult(hotelName, city, cacheKey);
    }

    const properties = data.properties ?? [];
    logger.info({ hotelName, resultCount: properties.length }, "[SerpAPI] Results received");

    if (!properties.length) {
      logger.info({ hotelName }, "[SerpAPI] No results — falling back to Places");
      return await placesOnlyResult(hotelName, city, cacheKey);
    }

    const match = findBestMatch(hotelName, properties);
    if (!match) {
      return await placesOnlyResult(hotelName, city, cacheKey);
    }

    const price = match.rate_per_night?.lowest;
    const result: SerpHotelResult = {
      name:          match.name ?? hotelName,
      bookingUrl:    match.link ?? "",
      pricePerNight: price ? `${price}/night` : undefined,
      rating:        match.overall_rating,
      reviewCount:   match.reviews,
      available:     true,
      source:        "serpapi",
    };

    await setCachedApify(cacheKey, JSON.stringify(result));
    logger.info(
      { hotelName, matchedName: result.name, price: result.pricePerNight, bookingUrl: result.bookingUrl.substring(0, 60) },
      "[SerpAPI] ✓ Found — result cached",
    );

    return result;

  } catch (err) {
    logger.warn({ err, hotelName }, "[SerpAPI] Request threw — falling back to Places");
    return await placesOnlyResult(hotelName, city, cacheKey);
  }
}

// ── Google Places fallback ────────────────────────────────────────────────────

async function placesOnlyResult(
  hotelName: string,
  city:      string,
  cacheKey:  string,
): Promise<SerpHotelResult> {
  const websiteUrl = await lookupHotelWebsiteViaPlaces(hotelName, city);

  const result: SerpHotelResult = {
    name:       hotelName,
    bookingUrl: websiteUrl ?? "",
    websiteUrl: websiteUrl ?? undefined,
    available:  false,
    source:     websiteUrl ? "places" : "none",
  };

  if (websiteUrl) {
    await setCachedApify(cacheKey, JSON.stringify(result));
    logger.info({ hotelName, websiteUrl }, "[SerpAPI] Places fallback — website found");
  } else {
    logger.info({ hotelName }, "[SerpAPI] No results from SerpAPI or Places");
  }

  return result;
}
