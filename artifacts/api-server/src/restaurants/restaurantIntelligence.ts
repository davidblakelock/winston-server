import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { toChicagoTime, fetchEventsForDate, chicagoDateStr } from "../google/calendar.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ReservationPlatform = "opentable" | "resy" | "phone";
export type ReservationAction = "reservation" | "directions" | "info";

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
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (cachedAt < thirtyDaysAgo) return null;

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
function detectPlatform(website: string | null | undefined): {
  platform: ReservationPlatform;
  slug: string | null;
  city: string | null;
} {
  if (!website) return { platform: "phone", slug: null, city: null };

  const otMatch = website.match(/opentable\.com\/r\/([\w-]+)/);
  if (otMatch) return { platform: "opentable", slug: otMatch[1], city: null };

  const resyMatch = website.match(/resy\.com\/cities\/([\w-]+)\/(?:venues\/)?([\w-]+)/i);
  if (resyMatch) return { platform: "resy", slug: resyMatch[2], city: resyMatch[1] };

  return { platform: "phone", slug: null, city: null };
}

export function buildReservationUrl(
  details: RestaurantDetails,
  dateISO: string | null,
  timeISO: string | null,
  partySize: number | null
): string | null {
  const n = partySize ?? 2;

  if (details.platform === "opentable" && details.platformSlug) {
    const base = `https://www.opentable.com/r/${details.platformSlug}?covers=${n}`;
    if (dateISO && timeISO) return `${base}&dateTime=${dateISO}T${timeISO}:00`;
    return base;
  }

  if (details.platform === "resy" && details.platformSlug && details.platformCity) {
    const base = `https://resy.com/cities/${details.platformCity}/venues/${details.platformSlug}?seats=${n}`;
    if (dateISO) return `${base}&date=${dateISO}`;
    return base;
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
        maxResultCount: 1,
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
    const { platform, slug, city: platformCity } = detectPlatform(website);
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
      model: "claude-haiku-4-5",
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
