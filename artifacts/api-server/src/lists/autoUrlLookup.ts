import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── List type detection ───────────────────────────────────────────────────────

export type AutoLookupType = "restaurant" | "movie" | "tvshow" | "book" | "recipe" | "place";

export function detectAutoLookupType(listName: string): AutoLookupType | null {
  const n = listName.toLowerCase().trim();
  if (/restaurants?|favorite\s+restaurants?|dining/i.test(n)) return "restaurant";
  if (/movies?(\s+to\s+watch)?|films?(\s+to\s+watch)?/i.test(n)) return "movie";
  if (/tv\s*shows?|television(\s+shows?)?|series(\s+to\s+watch)?/i.test(n)) return "tvshow";
  if (/books?(\s+to\s+read)?|reading(\s+list)?/i.test(n)) return "book";
  if (/recipes?(\s+to\s+try)?|cooking(\s+ideas?)?/i.test(n)) return "recipe";
  // Places, venues, bars, clubs — use restaurant-style venue URL lookup
  if (/places?(\s+to\s+(check\s+out|visit|try|go))?|venues?|bars?(\s+to\s+(try|visit))?|clubs?|spots?(\s+to\s+(try|visit|check\s+out))?/i.test(n)) return "place";
  return null;
}

// ── Per-type URL builders ─────────────────────────────────────────────────────

// Constructs a Yelp search URL for a restaurant — used as a guaranteed fallback
// when no direct OpenTable / Resy / Yelp listing can be found via web search.
// The URL opens Yelp filtered to the restaurant name + city so the user can
// browse reviews and book via Yelp Waitlist even without a direct listing.
export function yelpFallbackUrl(restaurantName: string, city = "Dallas, TX"): string {
  return `https://www.yelp.com/search?find_desc=${encodeURIComponent(restaurantName)}&find_loc=${encodeURIComponent(city)}`;
}

// Returns true when a stored URL is a DIRECT reservation/listing page on a known
// booking platform (not a generic search page). Used by backfill logic — Yelp search
// URLs are intentionally excluded so those rows are retried for a direct listing.
export function isBookingPlatformUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  // Direct OpenTable listing
  if (/opentable\.com\/(r|restaurant)\//i.test(url)) return true;
  // Direct Resy venue page
  if (/resy\.com\/cities\/.+\/venues\//i.test(url)) return true;
  // Direct Yelp business listing (yelp.com/biz/...) — NOT yelp.com/search
  if (/yelp\.com\/biz\//i.test(url)) return true;
  return false;
}

// Step 1: Use Claude web_search to find a direct OpenTable, Resy, or Yelp booking page.
// Returns the booking URL if found, or null if no platform has a listing.
async function lookupRestaurantBookingUrl(name: string, city = "Dallas"): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const prompt =
    `Find the direct reservation/booking page URL for the restaurant "${name}"${city ? ` in ${city}` : ""}.\n\n` +
    `Search in this order of preference:\n` +
    `  1. "${name} opentable" — look for opentable.com/r/... or opentable.com/restaurant/...\n` +
    `  2. "${name} resy" — look for resy.com/cities/.../venues/...\n` +
    `  3. "${name} yelp reservations" — look for yelp.com/reservations/... or the restaurant's yelp.com listing page\n\n` +
    `Rules:\n` +
    `• Return ONLY the single direct booking/listing page URL (not a search results page, not google.com).\n` +
    `• Prefer OpenTable first, then Resy, then Yelp.\n` +
    `• The URL MUST contain "opentable.com", "resy.com", or "yelp.com" — reject anything else.\n` +
    `• For Yelp: the restaurant's own Yelp listing page (e.g. yelp.com/biz/restaurant-name-city) is acceptable.\n` +
    `• If no listing is found on any of these three platforms, return exactly: NONE\n` +
    `• No explanation, no extra text — just the URL or NONE.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^none$/i.test(text.trim())) return null;

    // Validate it's actually a booking platform URL
    const url = text.trim().split(/\s/)[0]; // take first word in case Claude adds commentary
    if (/opentable\.com|resy\.com|yelp\.com/i.test(url ?? "")) {
      logger.info({ name, url }, "[AutoURL] Booking URL found via web search");
      return url ?? null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, name }, "[AutoURL] Booking URL web search failed");
    return null;
  }
}

// Step 2 fallback: Google Places API websiteUri (the restaurant's own website).
async function lookupRestaurantWebsite(name: string, city = "Dallas"): Promise<string | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  // Skip city suffix for restaurants that are clearly in specific non-default locations
  // (e.g. "Nobu Malibu" already encodes the city, "Eleven Madison Park" is NYC)
  const nameEncodeCity = / (malibu|manhattan|nyc|new york|miami|chicago|la |los angeles|san francisco|austin|houston|nashville|vegas)/i.test(name);
  const query_text = nameEncodeCity ? `${name} restaurant` : `${name} restaurant ${city}`;

  const PLACES_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
  logger.info({ label: "PlacesText", url: PLACES_TEXT_URL, query_text }, "[AutoURL] → Places request");

  try {
    const searchResp = await fetch(PLACES_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.websiteUri,places.displayName",
      },
      body: JSON.stringify({
        textQuery: query_text,
        maxResultCount: 1,
        languageCode: "en",
      }),
      signal: AbortSignal.timeout(10000),
    });

    const clonedResp = searchResp.clone();
    const bodySnippet = (await clonedResp.text()).slice(0, 300);
    logger.info(
      { label: "PlacesText", status: searchResp.status, statusText: searchResp.statusText, body: bodySnippet },
      "[AutoURL] ← Places response"
    );

    if (!searchResp.ok) {
      logger.warn({ status: searchResp.status }, "[AutoURL] Places API error");
      return null;
    }

    const data = (await searchResp.json()) as {
      places?: Array<{ websiteUri?: string; displayName?: { text: string } }>;
    };

    const websiteUri = data.places?.[0]?.websiteUri ?? null;
    logger.info({ name, websiteUri }, "[AutoURL] Restaurant website found via Places API");
    return websiteUri;
  } catch (err) {
    logger.warn({ err }, "[AutoURL] Restaurant Places lookup failed");
    return null;
  }
}

// Orchestrator: always returns a URL — direct booking page if found, Yelp search as fallback.
// Priority: OpenTable → Resy → Yelp direct listing → Yelp search (guaranteed non-null).
async function lookupRestaurantUrl(name: string, city = "Dallas"): Promise<string> {
  const bookingUrl = await lookupRestaurantBookingUrl(name, city);
  if (bookingUrl) return bookingUrl;
  // Guaranteed fallback: Yelp search filtered to this restaurant + city.
  // Better than returning null — opens Yelp where the user can find reviews,
  // the menu, and use Yelp Waitlist. The backfill will still retry this row
  // later because yelp.com/search is not treated as a "direct" booking URL.
  return yelpFallbackUrl(name, `${city}, TX`);
}

export { lookupRestaurantUrl };

export async function lookupItemUrl(itemText: string, type: AutoLookupType): Promise<string | null> {
  const encoded = encodeURIComponent(itemText);

  switch (type) {
    case "restaurant":
    case "place":
      // Both restaurants and "places to check out" style lists use venue URL lookup
      return lookupRestaurantUrl(itemText);

    case "movie":
      return `https://www.imdb.com/find/?q=${encoded}&s=tt&ttype=ft`;

    case "tvshow":
      return `https://www.imdb.com/find/?q=${encoded}&s=tt&ttype=tv`;

    case "book":
      return `https://www.goodreads.com/search?q=${encoded}`;

    case "recipe":
      return `https://www.allrecipes.com/search?q=${encoded}`;

    default:
      return null;
  }
}

// ── Fire-and-forget: lookup URL and update list_items ───────────────────────

export async function autoUpdateItemUrl(
  itemId: number,
  itemText: string,
  listName: string
): Promise<void> {
  const lookupType = detectAutoLookupType(listName);
  if (!lookupType) return;

  try {
    const url = await lookupItemUrl(itemText, lookupType);
    if (!url) return;

    await query(
      `UPDATE list_items SET url = $1 WHERE id = $2 AND url IS NULL`,
      [url, itemId]
    );
    logger.info({ itemId, itemText, listName, url }, "[AutoURL] URL saved to list_items");
  } catch (err) {
    logger.warn({ err, itemId, listName }, "[AutoURL] Failed to auto-update URL");
  }
}

// ── Fire-and-forget: lookup restaurant URL and update profile_items ──────────
// Always tries to find a booking platform URL.
// Updates the row whether or not it already has a URL — the goal is to replace
// any stored restaurant website with an OpenTable / Resy / Yelp booking link.
// If no booking link is found, the existing URL (if any) is left unchanged.

export async function autoUpdateRestaurantUrl(
  profileItemId: number,
  restaurantName: string
): Promise<void> {
  try {
    // lookupRestaurantUrl always returns a string (never null):
    // OpenTable → Resy → Yelp direct → Yelp search fallback.
    const url = await lookupRestaurantUrl(restaurantName);

    await query(
      `UPDATE profile_items SET url = $1 WHERE id = $2`,
      [url, profileItemId]
    );
    logger.info({ profileItemId, restaurantName, url }, "[AutoURL] Restaurant booking URL saved");
  } catch (err) {
    logger.warn({ err, profileItemId, restaurantName }, "[AutoURL] Failed to auto-update restaurant URL");
  }
}
