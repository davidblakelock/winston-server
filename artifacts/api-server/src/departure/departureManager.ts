import { logger } from "../lib/logger.js";

// David's home: 6345 Diamond Head Circle, Dallas TX 75225
const HOME_LAT = 32.8703;
const HOME_LON = -96.7977;

export interface DriveEstimate {
  durationSeconds: number;
  durationMinutes: number;
  distanceKm: number;
  source: "osrm" | "estimate";
}

export interface DepartureAlert {
  eventTitle: string;
  eventStart: Date;
  destination: string;
  driveMinutes: number;
  shouldLeaveAt: Date;
  minutesUntilLeave: number;
}

// ── Geocode destination using Nominatim ───────────────────────────────────────
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

// ── Route duration via OSRM (free, no API key) ────────────────────────────────
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

// ── Haversine fallback estimate ────────────────────────────────────────────────
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Main drive time calculator ────────────────────────────────────────────────
export async function estimateDriveTime(destination: string): Promise<DriveEstimate | null> {
  const coords = await geocode(destination);
  if (!coords) {
    // Try with just the raw destination (in case it's already well-formed)
    logger.warn({ destination }, "Geocode failed");
    return null;
  }

  const osrm = await getOsrmDuration(HOME_LAT, HOME_LON, coords.lat, coords.lon);
  if (osrm) return osrm;

  // Fallback: haversine + 25mph average Dallas speed
  const km = haversineKm(HOME_LAT, HOME_LON, coords.lat, coords.lon);
  const mph25 = 40.2; // km/h
  const durationSeconds = (km / mph25) * 3600;

  return {
    durationSeconds,
    durationMinutes: Math.ceil(durationSeconds / 60),
    distanceKm: km,
    source: "estimate",
  };
}

// ── Check whether we should fire a departure alert ───────────────────────────
const BUFFER_MINUTES = 10; // leave buffer before drive time

export function shouldFireAlert(
  eventStart: Date,
  driveMinutes: number,
  now: Date = new Date()
): boolean {
  const leaveAt = new Date(eventStart.getTime() - (driveMinutes + BUFFER_MINUTES) * 60000);
  const minutesUntilLeave = (leaveAt.getTime() - now.getTime()) / 60000;

  // Fire when 0-5 minutes until leave time
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
  const round = Math.round(driveMinutes / 5) * 5; // round to nearest 5 mins

  return `David, you should think about heading out for your ${timeStr} ${eventTitle} — it's about ${round} minutes from home (${trafficNote}), so you'll want to leave in the next few minutes.`;
}

// ── Extract location from calendar event description/location ─────────────────
export function extractEventLocation(event: {
  summary?: string;
  location?: string;
  description?: string;
}): string | null {
  if (event.location) return event.location;

  // Try to extract from description
  const desc = event.description ?? "";
  const locationMatch = desc.match(/location:\s*([^\n]+)/i) ??
    desc.match(/address:\s*([^\n]+)/i) ??
    desc.match(/at\s+([A-Z][^,\n]{5,40}(?:,\s*[A-Z][^,\n]+)?)/);

  return locationMatch?.[1]?.trim() ?? null;
}
