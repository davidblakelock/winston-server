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
export function yelpFallbackUrl(restaurantName: string, city = ""): string {
  const base = `https://www.yelp.com/search?find_desc=${encodeURIComponent(restaurantName)}`;
  return city.trim() ? `${base}&find_loc=${encodeURIComponent(city.trim())}` : base;
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
// Returns the booking URL with a restaurant-specific path, or null if not found.
async function lookupRestaurantBookingUrl(name: string, city = ""): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const locationHint = city.trim() ? ` in ${city.trim()}` : "";
  const prompt =
    `I need the SPECIFIC restaurant page URL for "${name}"${locationHint} on a booking platform.\n\n` +
    `Search the web and find the restaurant's own listing page on one of these platforms:\n\n` +
    `OPENTABLE — URL format examples (the slug after /r/ is the restaurant's unique identifier):\n` +
    `  https://www.opentable.com/r/nobu-malibu\n` +
    `  https://www.opentable.com/r/eleven-madison-park-new-york\n` +
    `  https://www.opentable.com/restaurant/profile/12345\n\n` +
    `RESY — URL format examples:\n` +
    `  https://resy.com/cities/nyc/venues/eleven-madison-park\n` +
    `  https://resy.com/cities/mia/venues/nobu-miami\n\n` +
    `YELP — the restaurant's own business listing page (NOT a search results page):\n` +
    `  https://www.yelp.com/biz/nobu-malibu\n` +
    `  https://www.yelp.com/biz/the-mercury-dallas-2\n\n` +
    `RULES — read carefully:\n` +
    `• The URL MUST include the restaurant's name or ID in the path (not just the domain).\n` +
    `• REJECT these — they are homepages or search pages, not the restaurant's page:\n` +
    `    opentable.com  (no path)\n` +
    `    resy.com  (no path)\n` +
    `    yelp.com  (no path)\n` +
    `    yelp.com/search?...  (search results page — not valid)\n` +
    `• Return ONLY the single URL — no explanation, no extra text.\n` +
    `• If you cannot find a listing with the restaurant's name/ID in the path, return exactly: NONE\n\n` +
    `Search for: "${name} opentable" OR "${name} resy" OR "${name} yelp${city.trim() ? ` ${city.trim()}` : ""}"`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^none$/i.test(text.trim())) return null;

    // Take the first word in case Claude adds any commentary
    const rawUrl = text.trim().split(/[\s\n]/)[0] ?? "";
    const url = rawUrl.replace(/[.,;!?]$/, ""); // strip trailing punctuation

    // Must be on a recognised booking platform
    if (!/opentable\.com|resy\.com|yelp\.com/i.test(url)) return null;

    // Must have a meaningful path (not just the bare domain or root /)
    // e.g. opentable.com/r/nobu-dallas  ✓
    //      opentable.com                ✗
    //      resy.com/                    ✗
    //      yelp.com/search?...          ✗ (search page, not a listing)
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      const path = parsed.pathname.replace(/\/+$/, ""); // strip trailing slashes
      if (path.length < 4) {
        logger.warn({ name, url }, "[AutoURL] Booking URL rejected — no restaurant-specific path");
        return null;
      }
      // Yelp: reject search pages
      if (/yelp\.com/i.test(url) && parsed.pathname.startsWith("/search")) {
        logger.warn({ name, url }, "[AutoURL] Yelp search page rejected — need /biz/ page");
        return null;
      }
    } catch {
      return null;
    }

    logger.info({ name, url }, "[AutoURL] Booking URL found via web search");
    return url;
  } catch (err) {
    logger.warn({ err, name }, "[AutoURL] Booking URL web search failed");
    return null;
  }
}

// Step 2 fallback: Google Places API websiteUri (the restaurant's own website).
async function lookupRestaurantWebsite(name: string, city = ""): Promise<string | null> {
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
async function lookupRestaurantUrl(name: string, city = ""): Promise<string> {
  const bookingUrl = await lookupRestaurantBookingUrl(name, city);
  if (bookingUrl) return bookingUrl;
  // Guaranteed fallback: Yelp search for this restaurant, optionally filtered by city.
  // Retried later by backfill because yelp.com/search is not a "direct" booking URL.
  return yelpFallbackUrl(name, city);
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
  restaurantName: string,
  city = ""
): Promise<void> {
  try {
    // lookupRestaurantUrl always returns a string (never null):
    // OpenTable → Resy → Yelp direct → Yelp search fallback.
    const url = await lookupRestaurantUrl(restaurantName, city);

    await query(
      `UPDATE profile_items SET url = $1 WHERE id = $2`,
      [url, profileItemId]
    );
    logger.info({ profileItemId, restaurantName, url }, "[AutoURL] Restaurant booking URL saved");
  } catch (err) {
    logger.warn({ err, profileItemId, restaurantName }, "[AutoURL] Failed to auto-update restaurant URL");
  }
}
