/**
 * Route-Aware Proactive Suggestions
 *
 * During morning briefing generation, checks whether the user has calendar
 * events with real locations today or tomorrow. If so, calculates the route
 * from home → event and looks for businesses on the way home that match items
 * on the user's shopping list or to-do list.
 *
 * APIs used:
 *   - Google Maps Directions API  (GOOGLE_PLACES_API_KEY must have it enabled)
 *   - Google Places Nearby Search (New API — same key)
 *   - Google Places Text Search   (New API — for specific business name lookup)
 *
 * All API failures are non-fatal — the feature is silently skipped.
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import type { CalendarEvent } from "../google/calendar.js";

// ── Pending route-reminder state (cleared after user says "yes") ──────────────

export interface PendingRouteReminder {
  userName:      string;
  eventSummary:  string;
  eventEndIso:   string;   // ISO timestamp — reminder fires 30 min before this
  businessName:  string;
  reminderText:  string;   // full text for the push notification
}

let _pendingRouteReminder: PendingRouteReminder | null = null;

export function getPendingRouteReminder(): PendingRouteReminder | null {
  return _pendingRouteReminder;
}
export function setPendingRouteReminder(r: PendingRouteReminder | null): void {
  _pendingRouteReminder = r;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouteAwareSuggestion {
  eventSummary:    string;
  eventEndIso:     string;
  businessName:    string;
  businessAddress: string;
  distanceMiles:   number;
  category:        "grocery" | "pharmacy" | "todo";
  todoItem?:       string;
  /** Single conversational sentence for the briefing. */
  briefingLine:    string;
  /** Text for the push-notification reminder. */
  reminderText:    string;
}

interface PlaceResult {
  name:    string;
  address: string;
  lat:     number;
  lng:     number;
}

// ── Polyline decode (standard Google encoding algorithm) ──────────────────────

function decodePolyline(encoded: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Minimum distance (km) from a lat/lon point to any sampled waypoint on the route. */
function minDistToRoute(lat: number, lon: number, waypoints: Array<[number, number]>): number {
  let min = Infinity;
  for (const [wlat, wlon] of waypoints) {
    const d = haversineKm(lat, lon, wlat, wlon);
    if (d < min) min = d;
  }
  return min;
}

/** Sample up to `count` evenly-spaced points from a decoded polyline. */
function sampleWaypoints(pts: Array<[number, number]>, count: number): Array<[number, number]> {
  if (pts.length <= count) return pts;
  const step = Math.floor(pts.length / count);
  return pts.filter((_, i) => i % step === 0).slice(0, count);
}

// ── Google Directions API ─────────────────────────────────────────────────────

interface DirectionsResult {
  polyline:    string;
  durationMin: number;
  distanceKm:  number;
}

async function fetchRoute(
  origin:      string,
  destination: string,
  apiKey:      string,
): Promise<DirectionsResult | null> {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    `&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json() as {
    status: string;
    routes: Array<{
      overview_polyline: { points: string };
      legs: Array<{ duration: { value: number }; distance: { value: number } }>;
    }>;
  };
  if (data.status !== "OK" || !data.routes.length) return null;
  const route = data.routes[0]!;
  return {
    polyline:    route.overview_polyline.points,
    durationMin: Math.round((route.legs[0]?.duration.value ?? 0) / 60),
    distanceKm:  (route.legs[0]?.distance.value ?? 0) / 1000,
  };
}

// ── Google Places Nearby Search (New API) ─────────────────────────────────────

const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const PLACES_TEXT_URL   = "https://places.googleapis.com/v1/places:searchText";
const PLACES_FIELD_MASK = "places.displayName,places.formattedAddress,places.location";

async function nearbyBusinesses(
  centerWaypoints: Array<[number, number]>,
  includedTypes:   string[],
  radiusM:         number,
  apiKey:          string,
): Promise<PlaceResult[]> {
  const results: PlaceResult[] = [];
  // Search near the midpoint of sampled waypoints for efficiency
  const mid = centerWaypoints[Math.floor(centerWaypoints.length / 2)] ?? centerWaypoints[0];
  if (!mid) return [];

  const body = {
    includedTypes,
    maxResultCount: 5,
    locationRestriction: {
      circle: {
        center:  { latitude: mid[0], longitude: mid[1] },
        radius:  radiusM,
      },
    },
  };

  const res = await fetch(PLACES_NEARBY_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACES_FIELD_MASK },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json() as { places?: Array<{ displayName?: { text?: string }; formattedAddress?: string; location?: { latitude: number; longitude: number } }> };
  for (const p of data.places ?? []) {
    if (p.location && p.displayName?.text) {
      results.push({
        name:    p.displayName.text,
        address: p.formattedAddress ?? "",
        lat:     p.location.latitude,
        lng:     p.location.longitude,
      });
    }
  }
  return results;
}

async function findBusinessByName(
  businessName: string,
  city:         string,
  apiKey:       string,
): Promise<PlaceResult | null> {
  const body = { textQuery: `${businessName} ${city}`, maxResultCount: 1 };
  const res = await fetch(PLACES_TEXT_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACES_FIELD_MASK },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { places?: Array<{ displayName?: { text?: string }; formattedAddress?: string; location?: { latitude: number; longitude: number } }> };
  const p = data.places?.[0];
  if (!p?.location || !p.displayName?.text) return null;
  return {
    name:    p.displayName.text,
    address: p.formattedAddress ?? "",
    lat:     p.location.latitude,
    lng:     p.location.longitude,
  };
}

// ── To-do business name extraction ───────────────────────────────────────────

/**
 * Tries to extract a specific business name from a to-do item.
 * Catches patterns like:
 *   "pick up dry cleaning at Faber Cleaners"
 *   "drop off shoes at Bill's Shoe Repair"
 *   "stop by Central Market"
 *   "go to UPS Store"
 */
function extractTodoBusiness(text: string): string | null {
  // Match "at/from/by/stop by/visit/go to" followed by title-cased words
  const match = text.match(
    /\b(?:at|from|by|stop\s+by|visit|pick\s+up\s+(?:from|at)|drop\s+off\s+(?:at|to)|go\s+to)\s+([A-Z][A-Za-z0-9\s&'.,-]{1,40})(?:\s+(?:on|near|in|before|after|when)|[,.]|$)/
  );
  if (match?.[1]) return match[1].trim();

  // Fallback: "at X" pattern (simpler)
  const at = text.match(/\bat\s+([A-Z][A-Za-z0-9\s&'.-]{1,30})(?:\b|$)/);
  if (at?.[1]) return at[1].trim();

  return null;
}

// ── Location validity check ───────────────────────────────────────────────────

const VIRTUAL_LOCATION = /\b(zoom|teams|meet|hangout|skype|webex|slack|remote|virtual|online|tbd|conference\s+room|room\s+\d|suite\s+\d|building\s+\d|floor\s+\d)\b/i;

function isRealWorldLocation(location: string): boolean {
  if (!location || location.trim().length < 5) return false;
  if (VIRTUAL_LOCATION.test(location)) return false;
  // Must contain either a digit (street number) or a comma (city separator)
  return /\d/.test(location) || /,/.test(location);
}

// ── Shopping / to-do list queries ─────────────────────────────────────────────

interface ShoppingItem {
  item_text: string;
  category:  string | null;
}

async function getShoppingItems(userName: string): Promise<ShoppingItem[]> {
  const { rows } = await query<ShoppingItem>(
    `SELECT item_text, category
     FROM list_items
     WHERE user_name = $1
       AND list_name ILIKE '%shopping%'
       AND (completed IS NULL OR completed = false)
     ORDER BY category, item_text
     LIMIT 50`,
    [userName]
  );
  return rows;
}

async function getTodoItems(userName: string): Promise<string[]> {
  const { rows } = await query<{ item_text: string }>(
    `SELECT item_text
     FROM list_items
     WHERE user_name = $1
       AND (list_name ILIKE '%to%do%' OR list_name ILIKE '%task%')
       AND (completed IS NULL OR completed = false)
     LIMIT 30`,
    [userName]
  );
  return rows.map((r) => r.item_text);
}

// ── Readable distance helper ──────────────────────────────────────────────────

function fmtMiles(km: number): string {
  const m = km * 0.621371;
  return m < 0.2 ? "just off" : `${m.toFixed(1)} mile${m === 1.0 ? "" : "s"} off`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build route-aware suggestions for the morning briefing.
 *
 * @param userName     Authenticated user
 * @param events       Today's + tomorrow's calendar events
 * @param homeAddress  User's home address (authoritative column or rawData fallback)
 * @param city         User's city (for business search context)
 */
export async function buildRouteAwareSuggestions(
  userName:    string,
  events:      CalendarEvent[],
  homeAddress: string,
  city:        string,
): Promise<RouteAwareSuggestion[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn("[RouteAware] GOOGLE_PLACES_API_KEY not set — skipping");
    return [];
  }
  if (!homeAddress?.trim()) {
    logger.info({ userName }, "[RouteAware] No home address — skipping");
    return [];
  }

  // Only timed events with a real physical location and a known end time
  const actionable = events.filter(
    (e) => !e.allDay && e.location && isRealWorldLocation(e.location) && e.endIso
  );
  if (!actionable.length) return [];

  // Fetch lists once — bail early if both are empty
  const [shoppingItems, todoItems] = await Promise.all([
    getShoppingItems(userName).catch((): ShoppingItem[] => []),
    getTodoItems(userName).catch((): string[] => []),
  ]);

  const groceryItems   = shoppingItems.filter((i) => i.category !== "Pharmacy");
  const pharmacyItems  = shoppingItems.filter((i) => i.category === "Pharmacy");
  const todoBusinesses = todoItems.flatMap((t) => {
    const b = extractTodoBusiness(t);
    return b ? [{ business: b, item: t }] : [];
  });

  if (!groceryItems.length && !pharmacyItems.length && !todoBusinesses.length) {
    logger.info({ userName }, "[RouteAware] Lists are empty — skipping");
    return [];
  }

  const suggestions: RouteAwareSuggestion[] = [];

  for (const event of actionable) {
    if (!event.location || !event.endIso) continue;

    // Fetch route (home → event location)
    let route: DirectionsResult | null = null;
    try {
      route = await fetchRoute(homeAddress.trim(), event.location, apiKey);
    } catch (err) {
      logger.warn({ err, event: event.summary }, "[RouteAware] Directions API failed");
      continue;
    }
    if (!route) {
      logger.info({ event: event.summary, location: event.location }, "[RouteAware] No route found — location may not be geocodable");
      continue;
    }

    // Decode and sample waypoints (use return route — event → home)
    const pts = decodePolyline(route.polyline);
    if (pts.length < 2) continue;
    const waypoints = sampleWaypoints(pts, 10);

    const ROUTE_RADIUS_M   = 1609;  // 1 mile
    const MAX_DIST_KM      = 1.609; // 1 mile

    const endTime  = new Date(event.endIso);
    const fireAt   = new Date(endTime.getTime() - 30 * 60 * 1000);
    const endLabel = endTime.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });

    // ── Grocery store ─────────────────────────────────────────────────────────
    if (groceryItems.length > 0 && suggestions.length === 0) {
      try {
        const stores = await nearbyBusinesses(waypoints, ["grocery_or_supermarket", "supermarket"], ROUTE_RADIUS_M, apiKey);
        for (const store of stores) {
          const dist = minDistToRoute(store.lat, store.lng, waypoints);
          if (dist <= MAX_DIST_KM) {
            const n = groceryItems.length;
            const shortAddr = store.address.split(",")[0] ?? store.address;
            suggestions.push({
              eventSummary:    event.summary,
              eventEndIso:     event.endIso,
              businessName:    store.name,
              businessAddress: store.address,
              distanceMiles:   dist * 0.621371,
              category:        "grocery",
              briefingLine:
                `On your way home from ${event.summary} (ends ${endLabel}), ${store.name} is ${fmtMiles(dist)} your route — you have ${n} item${n === 1 ? "" : "s"} on your shopping list.`,
              reminderText:
                `Heading home from ${event.summary}? ${store.name} is on your route — ${n} shopping item${n === 1 ? "" : "s"} to grab.`,
            });
            logger.info({ store: store.name, dist: dist.toFixed(2), event: event.summary }, "[RouteAware] Grocery match");
            break; // one grocery suggestion per event
          }
        }
      } catch (err) {
        logger.warn({ err }, "[RouteAware] Grocery search failed");
      }
    }

    // ── Pharmacy ──────────────────────────────────────────────────────────────
    if (pharmacyItems.length > 0 && suggestions.length === 0) {
      try {
        const pharmacies = await nearbyBusinesses(waypoints, ["pharmacy"], ROUTE_RADIUS_M, apiKey);
        for (const pharm of pharmacies) {
          const dist = minDistToRoute(pharm.lat, pharm.lng, waypoints);
          if (dist <= MAX_DIST_KM) {
            suggestions.push({
              eventSummary:    event.summary,
              eventEndIso:     event.endIso,
              businessName:    pharm.name,
              businessAddress: pharm.address,
              distanceMiles:   dist * 0.621371,
              category:        "pharmacy",
              briefingLine:
                `On your way home from ${event.summary} (ends ${endLabel}), ${pharm.name} is ${fmtMiles(dist)} your route — you have pharmacy items on your shopping list.`,
              reminderText:
                `Heading home from ${event.summary}? ${pharm.name} is on your route — you have pharmacy items to pick up.`,
            });
            logger.info({ pharm: pharm.name, dist: dist.toFixed(2), event: event.summary }, "[RouteAware] Pharmacy match");
            break;
          }
        }
      } catch (err) {
        logger.warn({ err }, "[RouteAware] Pharmacy search failed");
      }
    }

    // ── Specific to-do businesses ─────────────────────────────────────────────
    for (const { business, item } of todoBusinesses) {
      if (suggestions.length >= 2) break; // cap at 2 suggestions total
      try {
        const place = await findBusinessByName(business, city, apiKey);
        if (!place) continue;
        const dist = minDistToRoute(place.lat, place.lng, waypoints);
        if (dist <= MAX_DIST_KM) {
          suggestions.push({
            eventSummary:    event.summary,
            eventEndIso:     event.endIso,
            businessName:    place.name,
            businessAddress: place.address,
            distanceMiles:   dist * 0.621371,
            category:        "todo",
            todoItem:        item,
            briefingLine:
              `${place.name} is ${fmtMiles(dist)} your route home from ${event.summary} (ends ${endLabel}) — you have "${item}" on your to-do list.`,
            reminderText:
              `Heading home from ${event.summary}? ${place.name} is on your route — "${item}" is on your to-do list.`,
          });
          logger.info({ business: place.name, dist: dist.toFixed(2), item }, "[RouteAware] To-do business match");
        }
      } catch (err) {
        logger.warn({ err, business }, "[RouteAware] Business name search failed");
      }
    }
  }

  return suggestions;
}

// ── Build the briefing block string ──────────────────────────────────────────

/**
 * Convert a list of route-aware suggestions into a system-prompt block
 * and set the pending reminder state for the first suggestion.
 */
export function buildRouteAwareBlock(
  userName:    string,
  suggestions: RouteAwareSuggestion[],
): string {
  if (!suggestions.length) return "";

  // Prime the pending reminder state with the first (best) suggestion
  const first = suggestions[0]!;
  _pendingRouteReminder = {
    userName,
    eventSummary: first.eventSummary,
    eventEndIso:  first.eventEndIso,
    businessName: first.businessName,
    reminderText: first.reminderText,
  };

  const lines = suggestions.map((s) => `• ${s.briefingLine}`).join("\n");

  return (
    `\n\n[Route-Aware Stops]\n` +
    lines +
    `\n\nAfter mentioning a route-aware stop — ONCE, naturally, toward the end of the briefing — offer: ` +
    `"Want me to set a reminder 30 minutes before your appointment ends so you don't forget to stop on the way home?" ` +
    `Do NOT repeat this offer. Do NOT list all items. Keep it to one natural conversational sentence.`
  );
}
