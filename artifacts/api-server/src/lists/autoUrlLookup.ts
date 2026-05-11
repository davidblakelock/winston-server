import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── List type detection ───────────────────────────────────────────────────────

export type AutoLookupType = "restaurant" | "movie" | "tvshow" | "book" | "recipe";

export function detectAutoLookupType(listName: string): AutoLookupType | null {
  const n = listName.toLowerCase().trim();
  if (/restaurants?|favorite\s+restaurants?|dining/i.test(n)) return "restaurant";
  if (/movies?(\s+to\s+watch)?|films?(\s+to\s+watch)?/i.test(n)) return "movie";
  if (/tv\s*shows?|television(\s+shows?)?|series(\s+to\s+watch)?/i.test(n)) return "tvshow";
  if (/books?(\s+to\s+read)?|reading(\s+list)?/i.test(n)) return "book";
  if (/recipes?(\s+to\s+try)?|cooking(\s+ideas?)?/i.test(n)) return "recipe";
  return null;
}

// ── Per-type URL builders ─────────────────────────────────────────────────────

async function lookupRestaurantUrl(name: string): Promise<string | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn("[AutoURL] GOOGLE_PLACES_API_KEY not set — skipping restaurant lookup");
    return null;
  }

  try {
    const searchResp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.websiteUri,places.displayName",
      },
      body: JSON.stringify({
        textQuery: `${name} restaurant`,
        maxResultCount: 1,
        languageCode: "en",
      }),
    });

    if (!searchResp.ok) {
      logger.warn({ status: searchResp.status }, "[AutoURL] Places API error");
      return null;
    }

    const data = (await searchResp.json()) as {
      places?: Array<{ websiteUri?: string; displayName?: { text: string } }>;
    };

    const websiteUri = data.places?.[0]?.websiteUri ?? null;
    logger.info({ name, websiteUri }, "[AutoURL] Restaurant URL found");
    return websiteUri;
  } catch (err) {
    logger.warn({ err }, "[AutoURL] Restaurant lookup failed");
    return null;
  }
}

export async function lookupItemUrl(itemText: string, type: AutoLookupType): Promise<string | null> {
  const encoded = encodeURIComponent(itemText);

  switch (type) {
    case "restaurant":
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
