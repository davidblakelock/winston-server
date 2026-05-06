/**
 * Geofencing Backend
 * - Checks user's current lat/lng against saved places and shopping list
 * - Uses Google Places API to identify nearby store types
 * - Returns triggered items relevant to the nearby location
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface SavedPlace {
  id: number;
  user_name: string;
  name: string;
  lat: number;
  lng: number;
  place_type: string | null;
  address: string | null;
  created_at: string;
}

const PROXIMITY_METERS = 500;

// ── Table ─────────────────────────────────────────────────────────────────────

export async function ensureSavedPlacesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS saved_places (
      id          SERIAL PRIMARY KEY,
      user_name   text NOT NULL,
      name        text NOT NULL,
      lat         double precision NOT NULL,
      lng         double precision NOT NULL,
      place_type  text,
      address     text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS saved_places_user_name_idx ON saved_places(user_name)`);
  logger.info("[Geofence] saved_places table ready");
}

// ── Haversine distance (meters) ───────────────────────────────────────────────

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Google Places Nearby Search ───────────────────────────────────────────────

interface PlaceResult {
  name: string;
  types: string[];
  vicinity: string;
}

export async function findNearbyStore(
  lat: number,
  lng: number
): Promise<{ storeName: string; storeType: string; storeTypes: string[] } | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn("[Geofence] GOOGLE_PLACES_API_KEY not set — skipping nearby store lookup");
    return null;
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${lat},${lng}`);
    url.searchParams.set("radius", String(PROXIMITY_METERS));
    url.searchParams.set("type", "store");
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;

    const body = (await res.json()) as { results?: PlaceResult[] };
    const place = body.results?.[0];
    if (!place) return null;

    const storeType = classifyStoreType(place.types);
    return { storeName: place.name, storeType, storeTypes: place.types };
  } catch (err) {
    logger.warn({ err }, "[Geofence] Nearby store lookup failed");
    return null;
  }
}

function classifyStoreType(types: string[]): string {
  if (types.some((t) => /pharmacy|drug_store/.test(t))) return "pharmacy";
  if (types.some((t) => /grocery|supermarket|food/.test(t))) return "grocery";
  if (types.some((t) => /hardware|home_improvement/.test(t))) return "hardware";
  if (types.some((t) => /department_store|clothing|shopping_mall/.test(t))) return "clothing";
  if (types.some((t) => /electronics/.test(t))) return "electronics";
  if (types.some((t) => /convenience_store/.test(t))) return "convenience";
  if (types.some((t) => /pet_store/.test(t))) return "pet";
  return "general";
}

// ── Shopping list item matching ───────────────────────────────────────────────

const STORE_ITEM_KEYWORDS: Record<string, RegExp> = {
  pharmacy: /prescription|medication|vitamin|bandage|first aid|medicine|supplement|pharmacy|advil|tylenol|ibuprofen/i,
  grocery: /milk|bread|egg|produce|fruit|vegetable|meat|chicken|beef|fish|butter|cheese|yogurt|cereal|coffee|tea|grocery|food|snack|drink|juice|water/i,
  hardware: /screw|nail|bolt|paint|tool|drill|saw|plumb|electric|lightbulb|battery|garden|hose|rake|shovel|hardware/i,
  pet: /dog food|cat food|pet|treat|leash|collar|litter/i,
  electronics: /cable|charger|battery|adapter|phone|headphone|speaker|electronic/i,
};

async function getRelevantShoppingItems(
  userName: string,
  storeType: string
): Promise<string[]> {
  try {
    const { rows } = await query<{ content: string }>(
      `SELECT li.content FROM list_items li
       JOIN lists l ON l.id = li.list_id
       WHERE l.user_name = $1
         AND l.list_type = 'shopping'
         AND li.completed = false
       LIMIT 50`,
      [userName]
    );

    const pattern = STORE_TYPE_KEYWORDS[storeType];
    if (!pattern) return rows.map((r) => r.content).slice(0, 10);

    const relevant = rows.filter((r) => pattern.test(r.content)).map((r) => r.content);
    if (relevant.length > 0) return relevant;

    return rows.map((r) => r.content).slice(0, 5);
  } catch {
    return [];
  }
}

const STORE_TYPE_KEYWORDS = STORE_ITEM_KEYWORDS;

// ── Saved places CRUD ─────────────────────────────────────────────────────────

export async function getSavedPlaces(userName: string): Promise<SavedPlace[]> {
  const { rows } = await query<SavedPlace>(
    `SELECT id, user_name, name, lat, lng, place_type, address, created_at
     FROM saved_places WHERE user_name = $1 ORDER BY name ASC`,
    [userName]
  );
  return rows;
}

export async function savePlaceForUser(
  userName: string,
  name: string,
  lat: number,
  lng: number,
  placeType?: string,
  address?: string
): Promise<SavedPlace> {
  const { rows } = await query<SavedPlace>(
    `INSERT INTO saved_places (user_name, name, lat, lng, place_type, address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_name, name, lat, lng, place_type, address, created_at`,
    [userName, name, lat, lng, placeType ?? null, address ?? null]
  );
  logger.info({ userName, name, lat, lng }, "[Geofence] Place saved");
  return rows[0];
}

// ── Geofence Check ────────────────────────────────────────────────────────────

export interface GeofenceCheckResult {
  triggered: boolean;
  storeName: string | null;
  storeType: string | null;
  relevantItems: string[];
  nearbyPlace: { name: string; distanceMeters: number } | null;
}

export async function geofenceCheck(
  userName: string,
  lat: number,
  lng: number
): Promise<GeofenceCheckResult> {
  const [savedPlaces, nearbyStore] = await Promise.all([
    getSavedPlaces(userName),
    findNearbyStore(lat, lng),
  ]);

  const nearbyPlace = savedPlaces
    .map((p) => ({ ...p, dist: haversineMeters(lat, lng, p.lat, p.lng) }))
    .filter((p) => p.dist <= PROXIMITY_METERS)
    .sort((a, b) => a.dist - b.dist)[0] ?? null;

  if (!nearbyStore && !nearbyPlace) {
    return { triggered: false, storeName: null, storeType: null, relevantItems: [], nearbyPlace: null };
  }

  const storeType = nearbyStore?.storeType ?? nearbyPlace?.place_type ?? "general";
  const storeName = nearbyStore?.storeName ?? nearbyPlace?.name ?? null;

  const relevantItems = await getRelevantShoppingItems(userName, storeType);

  logger.info({ userName, storeName, storeType, itemCount: relevantItems.length }, "[Geofence] Check triggered");

  return {
    triggered: true,
    storeName,
    storeType,
    relevantItems,
    nearbyPlace: nearbyPlace ? { name: nearbyPlace.name, distanceMeters: Math.round(nearbyPlace.dist) } : null,
  };
}
