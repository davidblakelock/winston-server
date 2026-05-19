import { logger } from "../lib/logger.js";

export interface DriveEstimate {
  durationSeconds: number;
  durationMinutes: number;
  distanceKm: number;
  source: "google-maps" | "osrm" | "estimate";
}

export interface DepartureAlert {
  eventTitle: string;
  eventStart: Date;
  destination: string;
  driveMinutes: number;
  shouldLeaveAt: Date;
  minutesUntilLeave: number;
}

// ── Diagnostic helper — logs full URL (key masked), status, and body snippet ──
function maskKey(url: string): string {
  return url.replace(/([?&]key=)([^&]+)/, (_m, prefix: string, key: string) =>
    `${prefix}***${(key as string).slice(-4)}`
  );
}

async function loggedFetch(
  label: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const safeUrl = maskKey(url);
  logger.info({ label, url: safeUrl, method: init?.method ?? "GET" }, "[GoogleMaps] → request");
  const res = await fetch(url, init);
  // Clone to allow body to be read twice (once for logging, once for caller)
  const clone = res.clone();
  const bodySnippet = (await clone.text()).slice(0, 300);
  logger.info(
    { label, url: safeUrl, status: res.status, statusText: res.statusText, body: bodySnippet },
    "[GoogleMaps] ← response"
  );
  return res;
}

// ── Google Maps Directions API (with real-time traffic) ───────────────────────
async function getGoogleMapsDuration(destination: string, homeAddress: string): Promise<DriveEstimate | null> {
  // Use GOOGLE_MAPS_API_KEY if set; fall back to GOOGLE_PLACES_API_KEY which is
  // on the same GCP project and usually has Directions API enabled too.
  const mapsKey  = process.env.GOOGLE_MAPS_API_KEY;
  const placesKey = process.env.GOOGLE_PLACES_API_KEY;
  const apiKey   = mapsKey ?? placesKey;
  logger.info(
    { hasMapsKey: !!mapsKey, hasPlacesKey: !!placesKey, usingKey: mapsKey ? "GOOGLE_MAPS_API_KEY" : "GOOGLE_PLACES_API_KEY" },
    "[GoogleMaps] Directions — key selection"
  );
  if (!apiKey) {
    logger.warn("[GoogleMaps] Directions — no API key available, skipping");
    return null;
  }

  const params = new URLSearchParams({
    origin: homeAddress,
    destination,
    departure_time: "now",
    traffic_model: "best_guess",
    key: apiKey,
  });

  const fullUrl = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;

  try {
    const res = await loggedFetch("Directions", fullUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.warn({ status: res.status, destination }, "[GoogleMaps] Directions HTTP error — returning null");
      return null;
    }

    const data = await res.json() as {
      status: string;
      error_message?: string;
      routes?: Array<{
        legs?: Array<{
          distance?: { value: number };
          duration?: { value: number };
          duration_in_traffic?: { value: number };
        }>;
      }>;
    };

    if (data.status !== "OK" || !data.routes?.length) {
      logger.warn(
        { status: data.status, error_message: data.error_message, destination },
        "[GoogleMaps] Directions non-OK status"
      );
      return null;
    }

    const leg = data.routes[0]?.legs?.[0];
    if (!leg) return null;

    // Prefer duration_in_traffic (real-time); fall back to duration (no traffic)
    const durationSeconds = leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0;
    const distanceMeters = leg.distance?.value ?? 0;

    if (durationSeconds === 0) return null;

    return {
      durationSeconds,
      durationMinutes: Math.ceil(durationSeconds / 60),
      distanceKm: distanceMeters / 1000,
      source: "google-maps",
    };
  } catch (err) {
    logger.warn({ err, destination }, "[GoogleMaps] Directions fetch threw");
    return null;
  }
}

// ── Google Geocoding API (primary geocoder — uses same key as Directions/Places) ──
async function geocodeWithGoogle(address: string): Promise<{ lat: number; lon: number } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn("[GoogleMaps] Geocoding — no API key available");
    return null;
  }

  const params = new URLSearchParams({ address, key: apiKey });
  const fullUrl = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;

  try {
    const res = await loggedFetch("Geocoding", fullUrl, { signal: AbortSignal.timeout(6000) });
    const data = await res.json() as {
      status: string;
      error_message?: string;
      results?: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };
    if (data.status !== "OK" || !data.results?.length) {
      logger.warn(
        { status: data.status, error_message: data.error_message, address },
        "[GoogleMaps] Geocoding non-OK status"
      );
      return null;
    }
    const loc = data.results[0]!.geometry.location;
    logger.info({ address, lat: loc.lat, lon: loc.lng }, "[GoogleMaps] Geocoding success");
    return { lat: loc.lat, lon: loc.lng };
  } catch (err) {
    logger.warn({ err, address }, "[GoogleMaps] Geocoding fetch threw");
    return null;
  }
}

// ── Nominatim geocoding (fallback only — rate-limited public instance) ────────
async function geocodeWithNominatim(address: string): Promise<{ lat: number; lon: number } | null> {
  // Only append city hint if the address doesn't already include a state or zip
  const hasState = /\b[A-Z]{2}\b|\b\d{5}\b/.test(address);
  const query = hasState ? address : address + " Dallas TX";
  const encoded = encodeURIComponent(query);
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;

  logger.info({ label: "Nominatim", url, address, query }, "[GoogleMaps] Nominatim → request");
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "WinstonCompanion/1.0 david@winstoncompanion.app" },
      signal: AbortSignal.timeout(5000),
    });
    const clone = res.clone();
    const bodySnippet = (await clone.text()).slice(0, 300);
    logger.info(
      { label: "Nominatim", status: res.status, statusText: res.statusText, body: bodySnippet },
      "[GoogleMaps] Nominatim ← response"
    );
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (!data.length) {
      logger.warn({ address, query }, "[GoogleMaps] Nominatim returned no results");
      return null;
    }
    logger.info({ address, result: data[0] }, "[GoogleMaps] Nominatim geocoding success");
    return { lat: parseFloat(data[0]!.lat), lon: parseFloat(data[0]!.lon) };
  } catch (err) {
    logger.warn({ err, address }, "[GoogleMaps] Nominatim fetch threw");
    return null;
  }
}

async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  // Try Google first (better accuracy, handles business names), fall back to Nominatim
  return (await geocodeWithGoogle(address)) ?? (await geocodeWithNominatim(address));
}

// ── OSRM route duration (free, no API key, no traffic) ────────────────────────
async function getOsrmDuration(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): Promise<DriveEstimate | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data = await res.json() as {
      routes?: Array<{ duration: number; distance: number }>;
      code?: string;
    };

    if (data.code !== "Ok" || !data.routes?.length) return null;

    const route = data.routes[0];
    return {
      durationSeconds: route.duration,
      durationMinutes: Math.ceil(route.duration / 60),
      distanceKm: route.distance / 1000,
      source: "osrm",
    };
  } catch {
    return null;
  }
}

// ── Haversine straight-line fallback ─────────────────────────────────────────
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Main drive time calculator ────────────────────────────────────────────────
// Priority: 1. Google Maps (real-time traffic)  2. OSRM  3. Haversine estimate
// Callers must supply home address and coordinates from the user profile.
export async function estimateDriveTime(
  destination: string,
  homeAddress: string,
  homeLat: number,
  homeLon: number
): Promise<DriveEstimate | null> {
  if (!homeAddress) {
    // Fall back to coordinate string so Google Maps can still route
    homeAddress = `${homeLat},${homeLon}`;
    logger.info({ destination, homeAddress }, "estimateDriveTime: using coordinate fallback for home");
  }

  // 1. Google Maps — real-time traffic, most accurate
  const google = await getGoogleMapsDuration(destination, homeAddress);
  if (google) {
    logger.info({ destination, durationMinutes: google.durationMinutes }, "Drive time via Google Maps (traffic)");
    return google;
  }

  // 2. OSRM — free routing, no traffic data
  const coords = await geocode(destination);
  if (coords) {
    const osrm = await getOsrmDuration(homeLat, homeLon, coords.lat, coords.lon);
    if (osrm) {
      logger.info({ destination, durationMinutes: osrm.durationMinutes }, "Drive time via OSRM (no traffic)");
      return osrm;
    }

    // 3. Haversine fallback at 25mph average
    const km = haversineKm(homeLat, homeLon, coords.lat, coords.lon);
    const kmPerHour = 40.2; // ~25mph
    const durationSeconds = (km / kmPerHour) * 3600;
    logger.info({ destination, durationMinutes: Math.ceil(durationSeconds / 60) }, "Drive time via haversine estimate");
    return {
      durationSeconds,
      durationMinutes: Math.ceil(durationSeconds / 60),
      distanceKm: km,
      source: "estimate",
    };
  }

  logger.warn({ destination }, "Geocode failed — cannot estimate drive time");
  return null;
}

// ── Departure alert timing ────────────────────────────────────────────────────
// The alert fires when the user should START preparing to leave:
//   ideal leave time  = event start − drive time − PREP_MINUTES
//   fire window       = [ideal leave time − WINDOW_EARLY, ideal leave time + WINDOW_LATE]
//
// With a 2-min cron cadence and DB dedup, a 12-min window guarantees one fire
// even across a missed tick or brief server hiccup, without firing too early.
//
//  Example: 15-min drive to a 2:00 PM appointment, prep=10 min
//    ideal leave = 1:35 PM
//    fires between 1:31 PM and 1:39 PM  ← tight, timely alert
//    (old code fired at 1:00 PM — one full hour early)

const PREP_MINUTES  = 10;  // get-ready time added on top of drive time
const WINDOW_EARLY  = 4;   // fire up to 4 min before the ideal leave time
const WINDOW_LATE   = 8;   // fire up to 8 min after  (handles cron jitter)

export const DEPARTURE_PREP_MINUTES = PREP_MINUTES;

export function shouldFireAlert(
  eventStart: Date,
  driveMinutes: number,
  now: Date = new Date()
): boolean {
  const minutesUntilEvent = (eventStart.getTime() - now.getTime()) / 60000;
  // minutesUntilLeave < 0 means ideal leave time has passed; still fire up to
  // WINDOW_LATE minutes after so a briefly-missed cron tick is recovered.
  const minutesUntilLeave = minutesUntilEvent - driveMinutes - PREP_MINUTES;
  return minutesUntilLeave >= -WINDOW_LATE && minutesUntilLeave <= WINDOW_EARLY;
}

export function computeLeaveAt(eventStart: Date, driveMinutes: number): Date {
  return new Date(eventStart.getTime() - (driveMinutes + PREP_MINUTES) * 60000);
}

export function buildDepartureAlertMessage(
  eventTitle: string,
  eventStart: Date,
  driveMinutes: number,
  destination: string,
  hasTrafficData: boolean,
  displayName = "there"
): string {
  const eventTimeStr = eventStart.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const leaveAt = computeLeaveAt(eventStart, driveMinutes);
  const leaveTimeStr = leaveAt.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const trafficNote = hasTrafficData ? "with current traffic" : "estimated";
  const round = Math.round(driveMinutes / 5) * 5 || 5;

  return `Hey ${displayName}, heads up — you have ${eventTitle} at ${eventTimeStr}. It's about ${round} min away (${trafficNote}). Leave by ${leaveTimeStr} and you'll be there with time to spare.`;
}

// ── Extract location from calendar event ─────────────────────────────────────
export function extractEventLocation(event: {
  summary?: string;
  location?: string;
  description?: string;
}): string | null {
  if (event.location) return event.location;

  const desc = event.description ?? "";
  const locationMatch = desc.match(/location:\s*([^\n]+)/i) ??
    desc.match(/address:\s*([^\n]+)/i) ??
    desc.match(/at\s+([A-Z][^,\n]{5,40}(?:,\s*[A-Z][^,\n]+)?)/);

  return locationMatch?.[1]?.trim() ?? null;
}
