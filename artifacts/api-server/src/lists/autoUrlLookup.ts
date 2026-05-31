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

// Step 1: Use Claude web_search to find a direct OpenTable or Resy booking page.
// Returns the booking URL if found, or null if neither platform has a listing.
async function lookupRestaurantBookingUrl(name: string, city = "Dallas"): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const prompt =
    `Find the direct booking page URL for the restaurant "${name}"${city ? ` in ${city}` : ""}.\n\n` +
    `Search for:\n` +
    `  1. "${name} opentable" — look for a URL matching opentable.com/r/... or opentable.com/restaurant/...\n` +
    `  2. "${name} resy" — look for a URL matching resy.com/cities/.../venues/...\n\n` +
    `Rules:\n` +
    `• Return ONLY the single direct booking page URL (not a search results page).\n` +
    `• Prefer OpenTable over Resy if both exist.\n` +
    `• The URL must contain "opentable.com" or "resy.com" — reject anything else.\n` +
    `• If no direct booking page is found on either platform, return exactly: NONE\n` +
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
    if (/opentable\.com|resy\.com/i.test(url)) {
      logger.info({ name, url }, "[AutoURL] Booking URL found via web search");
      return url;
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

// Orchestrator: booking URL only (OpenTable or Resy).
// We intentionally do NOT fall back to the restaurant's own website — a generic
// homepage doesn't open a reservation form, which is the only reason to store a URL
// in the restaurants tab. Return null if no booking platform listing is found.
async function lookupRestaurantUrl(name: string, city = "Dallas"): Promise<string | null> {
  return lookupRestaurantBookingUrl(name, city);
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

export async function autoUpdateRestaurantUrl(
  profileItemId: number,
  restaurantName: string
): Promise<void> {
  try {
    const url = await lookupRestaurantUrl(restaurantName);
    if (!url) return;

    await query(
      `UPDATE profile_items SET url = $1 WHERE id = $2 AND url IS NULL`,
      [url, profileItemId]
    );
    logger.info({ profileItemId, restaurantName, url }, "[AutoURL] Restaurant URL saved");
  } catch (err) {
    logger.warn({ err, profileItemId, restaurantName }, "[AutoURL] Failed to auto-update restaurant URL");
  }
}
