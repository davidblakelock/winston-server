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

// Classifies a URL's booking platform, when it happens to be one. Only used
// for MANUALLY-entered URLs now (routes/lists.ts PUT/POST with a user-typed
// url) — the auto-lookup path below no longer looks for booking platforms at
// all, so this naturally returns null for anything it resolves.
export function detectBookingPlatform(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
    if (hostname.includes("opentable.com")) return "OpenTable";
    if (hostname.includes("resy.com")) return "Resy";
    if (hostname.includes("yelp.com")) return "Yelp";
    if (hostname.includes("tock.com") || hostname.includes("exploretock.com")) return "Tock";
    if (hostname.includes("sevenrooms.com")) return "SevenRooms";
    if (hostname.includes("tableagent.com")) return "Table Agent";
    if (hostname.includes("bookatable.com")) return "Bookatable";
    if (hostname.includes("quandoo.com")) return "Quandoo";
  } catch {
    // ignore malformed URLs
  }
  return null;
}

// Verify a URL actually resolves (not a 404). Only used to sanity-check the
// web-search fallback result below — Google Places' websiteUri is already
// authoritative and doesn't need this.
// Rejects on HTTP 404 or a DNS resolution failure (the domain genuinely
// doesn't exist) — 403/503/timeouts are treated as "unknown, assume OK" to
// avoid falsely discarding URLs that block bots.
async function verifyUrlExists(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Winston-Bot/1.0)" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (resp.status === 404) {
      logger.warn({ url, status: resp.status }, "[AutoURL] URL HEAD check returned 404 — rejecting");
      return false;
    }
    return true;
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      logger.warn({ url, code }, "[AutoURL] URL domain does not resolve — rejecting");
      return false;
    }
    return true; // network error / bot-blocked → assume URL exists
  }
}

// ── Official-site lookup ──────────────────────────────────────────────────────
// General-purpose lookup for every save path EXCEPT the "make a reservation"
// flow — that flow needs a booking-platform link, not a website, and keeps
// its own separate, synchronous lookup in restaurantIntelligence.ts. This one
// only ever looks for the place's own official site, timeout-guarded end to
// end so no caller can hang waiting on it.

async function lookupWebsiteViaPlaces(name: string, city = ""): Promise<string | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  // This is used for restaurants AND generic "place" saves (parks, venues,
  // museums, anything on a "places to check out"-style list) — don't bias
  // the query toward "restaurant", or a non-restaurant name resolves to some
  // unrelated restaurant's site instead (found via live testing: "Klyde
  // Warren Park" resolved to a random restaurant's website with the old
  // hardcoded "${name} restaurant ${city}" query).
  const nameEncodesCity = / (malibu|manhattan|nyc|new york|miami|chicago|la |los angeles|san francisco|austin|houston|nashville|vegas)/i.test(name);
  const textQuery = nameEncodesCity ? name : `${name} ${city}`;

  try {
    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.websiteUri,places.displayName",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 1, languageCode: "en" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      logger.warn({ name, status: resp.status }, "[AutoURL] Places API error");
      return null;
    }
    const data = (await resp.json()) as { places?: Array<{ websiteUri?: string }> };
    const websiteUri = data.places?.[0]?.websiteUri ?? null;
    if (websiteUri) logger.info({ name, websiteUri }, "[AutoURL] Official site found via Places API");
    return websiteUri;
  } catch (err) {
    logger.warn({ err, name }, "[AutoURL] Places lookup failed");
    return null;
  }
}

// Fallback when Places has no key or no result: a single Claude+web_search
// call asking specifically for the official site (never a booking platform),
// hard-capped at 8s via Promise.race — never chained with a second call.
async function lookupWebsiteViaSearch(name: string, city = ""): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const locationHint = city.trim() ? ` in ${city.trim()}` : "";

  const attempt = (async (): Promise<string | null> => {
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
        messages: [{
          role: "user",
          content:
            `Find the OFFICIAL website for "${name}"${locationHint} — its own site, not a review or ` +
            `booking-platform page (not opentable.com, resy.com, yelp.com, tripadvisor.com, etc.). ` +
            `Return ONLY the URL, no explanation. If you can't find an official site, return exactly: NONE`,
        }],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("").trim();
      if (!text || /^none$/i.test(text)) return null;
      // Extract an actual URL/domain from the response — don't just take the
      // first whitespace-separated token. Claude doesn't reliably return
      // "just the URL" despite the instruction (confirmed live: a response
      // for a restaurant with no site started with "Since..." explanatory
      // prose instead of NONE, and treating the first word as a URL
      // produced the literal string "https://Since").
      const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
      const domainMatch = !urlMatch ? text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>]*)?\b/i) : null;
      const raw = (urlMatch?.[0] ?? domainMatch?.[0] ?? "").replace(/[.,;!?)]+$/, "");
      if (!raw) return null;
      const url = raw.startsWith("http") ? raw : `https://${raw}`;
      try { new URL(url); } catch { return null; }
      if (/opentable\.com|resy\.com|yelp\.com|tripadvisor\.com/i.test(url)) return null; // reject a booking/review link if Claude ignored the instruction
      const exists = await verifyUrlExists(url);
      return exists ? url : null;
    } catch (err) {
      logger.warn({ err, name }, "[AutoURL] Web-search website lookup failed");
      return null;
    }
  })();

  return Promise.race([
    attempt,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
}

/** Looks up a place's official website. Returns null if none is found — no
 *  guaranteed non-null fallback, unlike the old booking-platform lookup. */
export async function lookupOfficialWebsite(name: string, city = ""): Promise<string | null> {
  const viaPlaces = await lookupWebsiteViaPlaces(name, city);
  if (viaPlaces) return viaPlaces;
  return lookupWebsiteViaSearch(name, city);
}

export async function lookupItemUrl(itemText: string, type: AutoLookupType): Promise<string | null> {
  const encoded = encodeURIComponent(itemText);

  switch (type) {
    case "restaurant":
    case "place":
      // Both restaurants and "places to check out" style lists want the
      // official site — never a booking platform.
      return lookupOfficialWebsite(itemText);

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

// ── Fire-and-forget: lookup restaurant's official site and update the restaurants table ──

export async function autoUpdateRestaurantUrl(
  restaurantId: number,
  restaurantName: string,
  city = ""
): Promise<void> {
  try {
    const url = await lookupOfficialWebsite(restaurantName, city);
    if (!url) return;
    await query(
      `UPDATE restaurants SET url = $1, booking_platform = NULL WHERE id = $2`,
      [url, restaurantId]
    );
    logger.info({ restaurantId, restaurantName, url }, "[AutoURL] Restaurant official site saved");
  } catch (err) {
    logger.warn({ err, restaurantId, restaurantName }, "[AutoURL] Failed to auto-update restaurant URL");
  }
}
