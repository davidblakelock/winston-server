import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { toChicagoTime, fetchEventsForDate, chicagoDateStr } from "../google/calendar.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ReservationPlatform = "opentable" | "resy" | "yelp" | "phone";
export type ReservationAction = "reservation" | "directions" | "info";

// ── Booking platform metro/city lookup ───────────────────────────────────────

/** OpenTable metro IDs keyed by normalised city name. */
const OPENTABLE_METRO: Record<string, number> = {
  "new york":        1,
  "los angeles":     2,
  "chicago":         3,
  "san francisco":   4,
  "washington":      5,
  "washington dc":   5,
  "boston":          6,
  "philadelphia":    7,
  "denver":          8,
  "phoenix":         9,
  "san diego":      10,
  "miami":          12,
  "seattle":        13,
  "las vegas":      14,
  "dallas":         15,
  "fort worth":     15,
  "houston":        16,
  "portland":       18,
  "minneapolis":    19,
  "atlanta":        22,
  "austin":         24,
  "nashville":      55,
  "new orleans":    56,
};

/** Resy city slugs keyed by normalised city name. */
const RESY_CITY: Record<string, string> = {
  "new york":       "nyc",
  "los angeles":    "la",
  "chicago":        "chi",
  "san francisco":  "sf",
  "washington":     "dc",
  "washington dc":  "dc",
  "boston":         "bos",
  "miami":          "mia",
  "las vegas":      "lv",
  "seattle":        "sea",
  "houston":        "hou",
  "philadelphia":   "phl",
  "denver":         "den",
  "austin":         "atx",
  "nashville":      "nash",
  "atlanta":        "atl",
  "dallas":         "dal",
  "fort worth":     "dal",
  "portland":       "por",
  "minneapolis":    "min",
  "new orleans":    "nola",
  "san diego":      "sd",
  "phoenix":        "phx",
  "charlotte":      "char",
  "richmond":       "rva",
};

/**
 * Extract the city name from a Google Places formatted address.
 * e.g. "4217 Oak Lawn Ave, Dallas, TX 75219, USA" → "Dallas"
 */
export function extractCityFromAddress(formattedAddress: string): string | null {
  const parts = formattedAddress.split(",");
  return parts.length >= 2 ? parts[1].trim() : null;
}

/** Returns the OpenTable metroId for a given city name, or null if unknown. */
export function getOpenTableMetroId(city: string): number | null {
  return OPENTABLE_METRO[city.toLowerCase()] ?? null;
}

/** Returns the Resy city slug for a given city name, or null if unknown. */
export function getResyCitySlug(city: string): string | null {
  return RESY_CITY[city.toLowerCase()] ?? null;
}

export interface RestaurantIntent {
  restaurantName: string;
  action: ReservationAction;
  dateISO: string | null;
  dateLabel: string | null;
  timeISO: string | null;
  timeLabel: string | null;
  partySize: number | null;
}

export interface RestaurantDetails {
  name: string;
  phone: string | null;
  formattedAddress: string | null;
  website: string | null;
  platform: ReservationPlatform;
  platformSlug: string | null;
  platformCity: string | null;
  mapsUrl: string;
}

export interface PendingReservation {
  restaurantName: string;
  details: RestaurantDetails;
  action: ReservationAction;
  dateISO: string | null;
  dateLabel: string | null;
  timeISO: string | null;
  timeLabel: string | null;
  partySize: number | null;
  calendarConflict: string | null;
  reservationUrl: string | null;
}

// ── In-memory state (single-user) ─────────────────────────────────────────────
let _pendingReservation: PendingReservation | null = null;
export function getPendingReservation(): PendingReservation | null { return _pendingReservation; }
export function setPendingReservation(r: PendingReservation | null): void { _pendingReservation = r; }
export function clearPendingReservation(): void { _pendingReservation = null; }

// ── Booking confirmation state ─────────────────────────────────────────────
// Stores context after we've opened the booking deep link, while waiting for
// the user to tell us they've confirmed and who's joining them.
export interface PendingBookingConfirmation {
  restaurantName:     string;
  details:            RestaurantDetails;
  dateISO:            string;
  timeISO:            string | null;
  dateLabel:          string;
  timeLabel:          string | null;
  partySize:          number;
  restaurantCity:     string;
  openTableSearchUrl: string;
  resySearchUrl:      string;
  yelpSearchUrl:      string;
  conflictNote:       string;
}

let _pendingBookingConf: PendingBookingConfirmation | null = null;
export function getPendingBookingConfirmation(): PendingBookingConfirmation | null {
  return _pendingBookingConf;
}
export function setPendingBookingConfirmation(s: PendingBookingConfirmation | null): void {
  _pendingBookingConf = s;
}
export function clearPendingBookingConfirmation(): void {
  _pendingBookingConf = null;
}

// ── Last booking attempt ──────────────────────────────────────────────────
// Short-term context injected into the system prompt so Claude can answer
// follow-up questions ("Did you book that?") accurately instead of
// defaulting to "I can't make reservations."
export interface LastBookingAttempt {
  restaurantName:  string;
  dateLabel:       string;
  timeLabel:       string | null;
  partySize:       number;
  status:          "link_opened" | "calendar_created";
  phone?:          string;
  bookingUrl?:     string;
  timestamp:       number;
}

let _lastBookingAttempt: LastBookingAttempt | null = null;
export function getLastBookingAttempt(): LastBookingAttempt | null {
  if (!_lastBookingAttempt) return null;
  if (Date.now() - _lastBookingAttempt.timestamp > 30 * 60 * 1000) {
    _lastBookingAttempt = null;
    return null;
  }
  return _lastBookingAttempt;
}
export function setLastBookingAttempt(a: LastBookingAttempt): void {
  _lastBookingAttempt = a;
}

// ── DB cache ──────────────────────────────────────────────────────────────────
export async function ensureRestaurantCacheTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS restaurant_places_cache (
      id serial PRIMARY KEY,
      user_name text NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
      restaurant_name_lower text NOT NULL,
      display_name text,
      phone text,
      formatted_address text,
      website text,
      platform text NOT NULL DEFAULT 'phone',
      platform_slug text,
      platform_city text,
      cached_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS restaurant_places_cache_user_name_idx
    ON restaurant_places_cache (user_name, restaurant_name_lower)
  `).catch(() => {});
}

export async function getCachedRestaurantDetails(
  userName: string,
  restaurantName: string
): Promise<RestaurantDetails | null> {
  try {
    const result = await query<{
      display_name: string;
      phone: string | null;
      formatted_address: string | null;
      website: string | null;
      platform: string;
      platform_slug: string | null;
      platform_city: string | null;
      cached_at: string;
    }>(
      `SELECT display_name, phone, formatted_address, website, platform, platform_slug, platform_city, cached_at
       FROM restaurant_places_cache
       WHERE user_name = $1 AND restaurant_name_lower = $2`,
      [userName, restaurantName.toLowerCase()]
    );
    if (!result.rows.length) return null;

    const row = result.rows[0];
    const cachedAt = new Date(row.cached_at);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (cachedAt < sevenDaysAgo) return null;

    // Entries with slugs from AI web search are untrusted (Claude can hallucinate
    // the slug). Treat them as a cache miss so a fresh Places lookup re-fetches
    // and tries the scrape / web-search chain again to find a verified slug.
    // "direct:" slugs come from the restaurant's own homepage scrape or Google
    // Places websiteUri — reliable enough to cache and use.
    const slug = row.platform_slug ?? "";
    if (slug.startsWith("ws:")) return null;

    const addr = row.formatted_address;
    return {
      name: row.display_name ?? restaurantName,
      phone: row.phone,
      formattedAddress: addr,
      website: row.website,
      platform: (row.platform ?? "phone") as ReservationPlatform,
      platformSlug: row.platform_slug,
      platformCity: row.platform_city,
      mapsUrl: addr
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurantName)}`,
    };
  } catch {
    return null;
  }
}

export async function cacheRestaurantDetails(
  userName: string,
  restaurantName: string,
  details: RestaurantDetails
): Promise<void> {
  await query(
    `INSERT INTO restaurant_places_cache
       (user_name, restaurant_name_lower, display_name, phone, formatted_address, website, platform, platform_slug, platform_city, cached_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (user_name, restaurant_name_lower)
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       phone = EXCLUDED.phone,
       formatted_address = EXCLUDED.formatted_address,
       website = EXCLUDED.website,
       platform = EXCLUDED.platform,
       platform_slug = EXCLUDED.platform_slug,
       platform_city = EXCLUDED.platform_city,
       cached_at = NOW()
     RETURNING id`,
    [
      userName,
      restaurantName.toLowerCase(),
      details.name,
      details.phone,
      details.formattedAddress,
      details.website,
      details.platform,
      details.platformSlug,
      details.platformCity,
    ]
  );
}

export async function updateProfileItemWithAddress(
  userName: string,
  restaurantName: string,
  address: string
): Promise<void> {
  await query(
    `UPDATE profile_items SET detail = $1
     WHERE user_name = $2 AND LOWER(name) = LOWER($3) AND category = 'restaurants' AND (detail IS NULL OR detail = '')
     RETURNING id`,
    [address, userName, restaurantName]
  );
}

// ── Platform detection ────────────────────────────────────────────────────────
// Works on both a single URL string and raw HTML (scans for the first match).
function detectPlatform(text: string | null | undefined): {
  platform: ReservationPlatform;
  slug: string | null;
  city: string | null;
} {
  if (!text) return { platform: "phone", slug: null, city: null };

  // OpenTable canonical: /r/<slug>
  const otMatch = text.match(/opentable\.com\/r\/([\w-]+)/);
  if (otMatch) return { platform: "opentable", slug: otMatch[1], city: null };

  // OpenTable restaurant profile: /restaurant/profile/<id>
  const otProfileMatch = text.match(/opentable\.com\/restaurant\/profile\/([\w-]+)/i);
  if (otProfileMatch) return { platform: "opentable", slug: `restaurant/profile/${otProfileMatch[1]}`, city: null };

  // OpenTable direct slug: opentable.com/<restaurant-slug> (no /r/ prefix)
  // e.g. opentable.com/nick-and-sams-steakhouse
  // Exclude known non-restaurant paths: s (search), about, home, login, widget, etc.
  const otDirectMatch = text.match(/opentable\.com\/(?!r\/|restaurant|s[/?]|about|home|login|widget|privacy|terms|help)([\w-]{4,})/i);
  if (otDirectMatch) return { platform: "opentable", slug: `direct:${otDirectMatch[1]}`, city: null };

  // Resy: /cities/<city>/venues/<slug>  OR  /cities/<city>/<slug>
  const resyMatch = text.match(/resy\.com\/cities\/([\w-]+)\/(?:venues\/)?([\w-]+)/i);
  if (resyMatch) return { platform: "resy", slug: resyMatch[2], city: resyMatch[1] };

  // Yelp Reservations: yelp.com/reservations/<slug>
  const yelpResMatch = text.match(/yelp\.com\/reservations\/([\w-]+)/i);
  if (yelpResMatch) return { platform: "yelp", slug: yelpResMatch[1], city: "reservation" };

  // Yelp Waitlist: yelp.com/waitlist/<slug>
  const yelpWaitMatch = text.match(/yelp\.com\/waitlist\/([\w-]+)/i);
  if (yelpWaitMatch) return { platform: "yelp", slug: yelpWaitMatch[1], city: "waitlist" };

  return { platform: "phone", slug: null, city: null };
}

// Use Anthropic web search to find the restaurant's OpenTable, Resy, or Yelp listing.
// OpenTable and Resy both block server-side HTTP fetches (return 000/Forbidden),
// so direct scraping of their search pages is impossible. Anthropic's web_search
// tool uses real indexed results and reliably returns the restaurant's listing URL.
// Results are cached in the DB for 30 days so this only fires once per restaurant.
// Priority order: OpenTable > Resy > Yelp Reservations/Waitlist > phone.
export async function findBookingPlatformByWebSearch(
  restaurantName: string,
  city: string
): Promise<{ platform: ReservationPlatform; slug: string | null; city: string | null }> {
  const none = { platform: "phone" as ReservationPlatform, slug: null, city: null };
  try {
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      tools: [{ type: "web_search_20250305" as "web_search_20250305", name: "web_search", max_uses: 3 }],
      system:
        "Search for the restaurant's online reservation or waitlist page. " +
        "Check OpenTable first, then Resy, then Yelp Reservations or Yelp Waitlist. " +
        "Return ONLY the single best direct URL for this specific restaurant in priority order: " +
        "1) OpenTable direct link (e.g. https://www.opentable.com/r/al-biernats-dallas), " +
        "2) Resy direct link (e.g. https://resy.com/cities/dal/venues/al-biernats), " +
        "3) Yelp Reservations link (e.g. https://www.yelp.com/reservations/al-biernats-dallas), " +
        "4) Yelp Waitlist link (e.g. https://www.yelp.com/waitlist/al-biernats-dallas). " +
        "Return nothing else — just the URL. " +
        "If the restaurant is genuinely not on any of these platforms, return exactly: NOT_FOUND",
      messages: [{
        role: "user",
        content: `Find the reservation or waitlist page for "${restaurantName}" in ${city}. Check OpenTable, Resy, and Yelp.`,
      }],
    });

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const text = block.text.trim();
      if (!text || text === "NOT_FOUND") continue;
      const detected = detectPlatform(text);
      if (detected.platform !== "phone") return detected;
    }
    return none;
  } catch {
    return none;
  }
}


export function buildReservationUrl(
  details: RestaurantDetails,
  dateISO: string | null,
  timeISO: string | null,
  partySize: number | null
): string | null {
  const n = partySize ?? 2;
  const slug = details.platformSlug;

  // Slugs prefixed with "ws:" were found via AI web search. Strip the prefix
  // and build a direct booking URL — the web search slug is correct.
  if (slug?.startsWith("ws:")) {
    const realSlug = slug.slice(3);
    if (details.platform === "opentable") {
      const cleanSlug = realSlug.startsWith("direct:") ? realSlug.slice(7) : realSlug;
      const base = `https://www.opentable.com/${cleanSlug}?p=${n}`;
      return dateISO && timeISO ? `${base}&sd=${dateISO}+${timeISO}` : base;
    }
    if (details.platform === "resy") {
      console.log(`[buildReservationUrl] Resy ws: slug=${realSlug} city=${details.platformCity} dateISO=${dateISO} timeISO=${timeISO}`);
      const base = details.platformCity
        ? `https://resy.com/cities/${details.platformCity}/venues/${realSlug}?seats=${n}`
        : `https://resy.com/venues/${realSlug}?seats=${n}`;
      return dateISO ? `${base}&date=${dateISO}` : base;
    }
    if (details.platform === "yelp") {
      const yelpType = details.platformCity;
      const path = yelpType === "waitlist" ? "waitlist" : "reservations";
      const params = new URLSearchParams({ covers: String(n) });
      if (yelpType !== "waitlist") {
        if (dateISO) params.set("date", dateISO);
        if (timeISO) params.set("time", timeISO);
      }
      return `https://www.yelp.com/${path}/${realSlug}?${params.toString()}`;
    }
    return null;
  }

  if (details.platform === "opentable" && slug) {
    let base: string;
    if (slug.startsWith("restaurant/profile/")) {
      base = `https://www.opentable.com/${slug}?p=${n}`;
    } else if (slug.startsWith("direct:")) {
      // Bare slug (opentable.com/<slug>) detected in Google Places website field.
      // Keep the bare form — adding /r/ can cause 404s for some slug variants.
      base = `https://www.opentable.com/${slug.slice(7)}?p=${n}`;
    } else {
      base = `https://www.opentable.com/${slug}?p=${n}`;
    }
    if (dateISO && timeISO) return `${base}&sd=${dateISO}+${timeISO}`;
    return base;
  }

  if (details.platform === "resy" && slug && details.platformCity) {
    // Skip "ws:" already handled above; skip "ws:"-city combos too
    const city = details.platformCity?.startsWith("ws:") ? null : details.platformCity;
    if (!city) return null;
    console.log(`[buildReservationUrl] Resy direct — slug=${slug} city=${city} dateISO=${dateISO} timeISO=${timeISO}`);
    const base = `https://resy.com/cities/${city}/venues/${slug}?seats=${n}`;
    return dateISO ? `${base}&date=${dateISO}` : base;
  }

  if (details.platform === "yelp" && slug) {
    const yelpType = details.platformCity;
    const path = yelpType === "waitlist" ? "waitlist" : "reservations";
    const params = new URLSearchParams({ covers: String(n) });
    if (yelpType !== "waitlist") {
      if (dateISO) params.set("date", dateISO);
      if (timeISO) params.set("time", timeISO);
    }
    return `https://www.yelp.com/${path}/${slug}?${params.toString()}`;
  }

  return null;
}

// ── Google Places API lookup ──────────────────────────────────────────────────
export async function lookupRestaurantDetails(
  restaurantName: string,
  city: string
): Promise<RestaurantDetails | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("[RestaurantIntel] GOOGLE_PLACES_API_KEY not set — skipping live lookup");
    return null;
  }

  const textQuery = `${restaurantName} restaurant ${city}`;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.nationalPhoneNumber",
          "places.formattedAddress",
          "places.websiteUri",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery,
        pageSize: 1,
        languageCode: "en",
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[RestaurantIntel] Places API error ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text: string };
        nationalPhoneNumber?: string;
        formattedAddress?: string;
        websiteUri?: string;
      }>;
    };

    const place = data.places?.[0];
    if (!place) return null;

    const website = place.websiteUri ?? null;
    let { platform, slug, city: platformCity } = detectPlatform(website);

    // Web search for the restaurant's OpenTable, Resy, or Yelp listing.
    // OpenTable blocks server-side HTTP requests; most restaurant sites use
    // client-side rendering so scraping the homepage never finds booking links.
    // Anthropic's web_search tool uses real indexed results and reliably finds
    // the correct listing URL directly.
    if (platform === "phone") {
      const restaurantCity = place.formattedAddress
        ? (extractCityFromAddress(place.formattedAddress) ?? city)
        : city;
      console.log(`[RestaurantIntel] Web searching for "${restaurantName}" booking page in ${restaurantCity}…`);
      const webResult = await findBookingPlatformByWebSearch(restaurantName, restaurantCity);
      if (webResult.platform !== "phone") {
        console.log(`[RestaurantIntel] Found ${webResult.platform} via web search: ${webResult.slug}`);
        platform = webResult.platform;
        slug = webResult.slug ? `ws:${webResult.slug}` : null;
        platformCity = webResult.city;
      }
    }

    const address = place.formattedAddress ?? null;

    return {
      name: place.displayName?.text ?? restaurantName,
      phone: place.nationalPhoneNumber ?? null,
      formattedAddress: address,
      website,
      platform,
      platformSlug: slug,
      platformCity,
      mapsUrl: address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurantName + " " + city)}`,
    };
  } catch (err) {
    console.error("[RestaurantIntel] Places lookup failed:", err);
    return null;
  }
}

// ── Intent parsing ────────────────────────────────────────────────────────────
export async function parseReservationIntent(
  message: string,
  currentDateISO: string
): Promise<RestaurantIntent | null> {
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 300,
      system: `Extract restaurant reservation/directions intent from a user message.
Today's date: ${currentDateISO}
Return ONLY valid JSON:
{
  "restaurantName": string,
  "action": "reservation" | "directions" | "info",
  "dateISO": "YYYY-MM-DD" or null,
  "dateLabel": "Friday, January 15th" or null,
  "timeISO": "HH:MM" (24-hour) or null,
  "timeLabel": "7:00 PM" or null,
  "partySize": number or null
}

Rules:
- "make a reservation at Al Biernat's Friday at 7 for 2" → action="reservation", restaurantName="Al Biernat's", partySize=2
- "directions to Nobu" → action="directions", restaurantName="Nobu"
- "book a table at Pappas Bros tonight at 8" → action="reservation"
- "what's the number for Tate's Pizza" → action="info"
- "can we get in at Bullion" → action="reservation"
- "check Resy for Establishment tonight" → action="reservation"
- Resolve relative dates: "tonight"=today, "tomorrow"=today+1, "Friday"=next Friday if it hasn't passed
- TIME INFERENCE: restaurant reservations are almost always in the evening. If the user says "at 7" or "at 8" with no AM/PM, assume PM (19:00, 20:00). Only use AM if they explicitly say "breakfast" or "lunch" or "AM".
- Always output timeISO in 24-hour HH:MM format
- If restaurant name is not identifiable, return null
- If this is NOT a reservation/directions/info request, return null (the literal word null, not JSON)`,
      messages: [{ role: "user", content: message }],
    });

    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text === "null") return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as RestaurantIntent;
    if (!parsed.restaurantName || !parsed.action) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Calendar conflict check ───────────────────────────────────────────────────
export async function checkCalendarConflict(
  userName: string,
  dateISO: string,
  timeISO: string | null
): Promise<string | null> {
  if (!timeISO) return null;
  try {
    const events = await fetchEventsForDate(dateISO, userName);
    if (!events || !events.length) return null;

    const [h, m] = timeISO.split(":").map(Number);
    const resTime = h * 60 + m;

    for (const ev of events) {
      if (ev.allDay || !ev.startIso || !ev.endIso) continue;
      const evStart = toChicagoTime(ev.startIso);
      const evEnd = toChicagoTime(ev.endIso);
      const evStartMin = evStart.getHours() * 60 + evStart.getMinutes();
      const evEndMin = evEnd.getHours() * 60 + evEnd.getMinutes();
      if (resTime >= evStartMin - 30 && resTime <= evEndMin + 30) {
        return `"${ev.summary}" from ${ev.start} to ${ev.end}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export { chicagoDateStr };
