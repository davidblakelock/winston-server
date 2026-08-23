import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { lookupOfficialWebsite } from "../lists/autoUrlLookup.js";

// Was a general "profile_items" junk-drawer table with several categories
// (places, shows, people, interests, pets, other) plus this dedicated
// restaurants path. Confirmed dead on inspection: grepped every call site in
// the codebase, and getProfileItems()/addProfileItem() were NEVER actually
// called with an explicit category anywhere — only ever with the category
// omitted (which merged in restaurants) or "restaurants" itself. Confirmed
// again against the live table: 15 total rows for the only real user, all
// under category names ("favorite_venues", "music") that don't even match
// this file's own category list — leftover from a schema that predates the
// current one, nothing written in 24+ days. "shows" was separately already
// dead — formatProfileForContext excluded it on purpose since watched_shows
// became the real source of truth. The one still-live write (category
// "people", from contactHandlers.ts) never produced a single row despite
// running for a while — it was always redundant with saveCuratedContact's
// real write to key_people, called immediately before it every time.
// Restaurants were the only category ever actually exercised, and restaurants
// already live in their own dedicated table below, not profile_items — so
// this file now only does that. profile_items itself is left in place, per
// the no-drop-tables policy, just no longer read or written.
export interface Restaurant {
  id: number;
  name: string;
  detail: string | null;
  createdAt: Date;
  url: string | null;
  bookingPlatform: string | null;
}

interface RestaurantRow {
  id: number;
  name: string;
  detail: string | null;
  created_at: Date;
  url: string | null;
  booking_platform: string | null;
}

function mapRestaurantRow(r: RestaurantRow): Restaurant {
  return {
    id: r.id,
    name: r.name,
    detail: r.detail,
    createdAt: r.created_at,
    url: r.url,
    bookingPlatform: r.booking_platform,
  };
}

export async function addRestaurant(
  name: string,
  detail: string | null,
  userName = NATIVE_STORED_NAME
): Promise<Restaurant> {
  const cleanName = name?.trim();
  if (!cleanName) {
    throw new Error(`addRestaurant: name is required (got "${name}")`);
  }
  const cleanDetail = (!detail || detail.trim() === "" || detail.trim().toLowerCase() === "null")
    ? null
    : detail.trim();

  const existing = await query<{ id: number; detail: string | null }>(
    `SELECT id, detail FROM restaurants WHERE user_name = $1 AND LOWER(name) = LOWER($2)`,
    [userName, cleanName]
  );

  if (existing.rows.length > 0) {
    if (cleanDetail !== null) {
      await query(
        `UPDATE restaurants SET detail = $1 WHERE id = $2 RETURNING id`,
        [cleanDetail, existing.rows[0].id]
      );
    }
    const updated = await query<RestaurantRow>(
      `SELECT id, name, detail, created_at, url, booking_platform FROM restaurants WHERE id = $1`,
      [existing.rows[0].id]
    );
    return mapRestaurantRow(updated.rows[0]);
  }

  // Look up the user's city so URL lookups are location-aware (not hardcoded).
  const userCityRow = await query<{ city: string | null }>(
    `SELECT city FROM user_profiles WHERE user_name = $1`,
    [userName]
  ).catch(() => ({ rows: [] as Array<{ city: string | null }> }));
  const userCity = userCityRow.rows[0]?.city ?? "";

  const { rows } = await query<{
    id: number;
    name: string;
    detail: string | null;
    created_at: Date;
  }>(
    `INSERT INTO restaurants (user_name, name, detail, url)
     VALUES ($1, $2, $3, NULL)
     RETURNING id, name, detail, created_at`,
    [userName, cleanName, cleanDetail]
  );

  // This is a background job (nightly memory extraction), not a user-facing
  // request, so a synchronous-but-guarded lookup is fine here — race the
  // official-site lookup against a timeout so the job never hangs.
  let resolvedUrl: string | null = null;

  try {
    const result = await Promise.race([
      lookupOfficialWebsite(cleanName, userCity),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
    if (result) {
      resolvedUrl = result;
      await query(
        `UPDATE restaurants SET url = $1 WHERE id = $2`,
        [resolvedUrl, rows[0].id]
      ).catch(() => {});
    }
  } catch {
    // Best effort — restaurant is saved without a URL, backfilled later
  }

  return {
    id: rows[0].id,
    name: rows[0].name,
    detail: rows[0].detail,
    createdAt: rows[0].created_at,
    url: resolvedUrl,
    bookingPlatform: null,
  };
}

export async function getRestaurants(userName = NATIVE_STORED_NAME): Promise<Restaurant[]> {
  const { rows } = await query<RestaurantRow>(
    `SELECT id, name, detail, created_at, url, booking_platform
     FROM restaurants WHERE user_name = $1
     ORDER BY created_at ASC`,
    [userName]
  );
  return rows.map(mapRestaurantRow);
}

// Format restaurants for injection into system prompt.
export function formatRestaurantsForContext(restaurants: Restaurant[]): string {
  if (restaurants.length === 0) return "";
  const formatted = restaurants
    .map((r) => (r.detail ? `${r.name} (${r.detail})` : r.name))
    .join(", ");
  return `\n\n[Favorite Restaurants — added by the user directly]\n${formatted}\nReference these naturally.`;
}

export { logger };
