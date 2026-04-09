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

// ── Google Maps Directions API (with real-time traffic) ───────────────────────
async function getGoogleMapsDuration(destination: string, homeAddress: string): Promise<DriveEstimate | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    origin: homeAddress,
    destination,
    departure_time: "now",
    traffic_model: "best_guess",
    key: apiKey,
  });

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;

    const data = await res.json() as {
      status: string;
      routes?: Array<{
        legs?: Array<{
          distance?: { value: number };
          duration?: { value: number };
          duration_in_traffic?: { value: number };
        }>;
      }>;
    };

    if (data.status !== "OK" || !data.routes?.length) {
      logger.warn({ status: data.status, destination }, "Google Maps Directions API non-OK status");
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
    logger.warn({ err, destination }, "Google Maps Directions API call failed");
    return null;
  }
}

// ── Geocode destination using Nominatim (fallback only) ───────────────────────
async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const encoded = encodeURIComponent(address + " Dallas TX");
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "EmmaCompanion/1.0 (personal assistant)" },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch {
    return null;
  }
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
    logger.warn({ destination }, "estimateDriveTime: home address missing — cannot calculate");
    return null;
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
// Leave time = event start − drive time − 10 min buffer
const BUFFER_MINUTES = 10;

export function shouldFireAlert(
  eventStart: Date,
  driveMinutes: number,
  now: Date = new Date()
): boolean {
  const leaveAt = new Date(eventStart.getTime() - (driveMinutes + BUFFER_MINUTES) * 60000);
  const minutesUntilLeave = (leaveAt.getTime() - now.getTime()) / 60000;

  // Fire when 0–5 minutes until leave time
  return minutesUntilLeave >= 0 && minutesUntilLeave <= 5;
}

export function buildDepartureAlertMessage(
  eventTitle: string,
  eventStart: Date,
  driveMinutes: number,
  destination: string,
  hasTrafficData: boolean
): string {
  const timeStr = eventStart.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const trafficNote = hasTrafficData ? "based on current traffic" : "estimated";
  const round = Math.round(driveMinutes / 5) * 5;

  return `David, you should think about heading out for your ${timeStr} ${eventTitle} — it's about ${round} minutes from home (${trafficNote}), so you'll want to leave in the next few minutes.`;
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
