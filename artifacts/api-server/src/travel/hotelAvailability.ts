/**
 * Hotel Availability — Booking.com via Apify
 *
 * Runs ONE search per destination+date combo (cached 2 h) then name-matches
 * the hotels Claude recommended against what Booking.com actually shows as
 * available. Falls back silently when APIFY_API_KEY is absent.
 */

import { logger } from "../lib/logger.js";
import { getCachedApify, setCachedApify } from "../lib/apifyCache.js";

const BOOKING_ACTOR_ID = "voyager/booking-scraper";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 h — availability changes, but not minute-to-minute

function getApifyKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }
export function isBookingAvailabilityReady(): boolean { return !!getApifyKey(); }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BookingHotel {
  name: string;
  bookingUrl: string;
  pricePerNight?: string;   // formatted, e.g. "$189/night"
  rating?: number;          // out of 10
  reviewCount?: number;
  address?: string;
  stars?: number;
}

export interface HotelAvailabilityMatch {
  matched: BookingHotel | null;       // exact/near match for the recommended hotel
  bestAlternative: BookingHotel | null; // next-best when recommended is unavailable
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns today's year (CT). */
function currentYear(): number {
  return parseInt(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago", year: "numeric" }), 10);
}

/**
 * Try to parse a user-supplied date string into YYYY-MM-DD.
 * Returns null if the string is too vague (e.g. "in June" with no day).
 */
export function parseToISODate(raw: string | undefined): string | null {
  if (!raw) return null;

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  // MM/DD or MM/DD/YYYY
  const slashM = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashM) {
    const m = slashM[1]!.padStart(2, "0");
    const d = slashM[2]!.padStart(2, "0");
    const y = slashM[3]
      ? (slashM[3].length === 2 ? `20${slashM[3]}` : slashM[3])
      : String(currentYear());
    return `${y}-${m}-${d}`;
  }

  // "June 15" or "June 15, 2026" or "15 June 2026"
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const monthPat = Object.keys(months).join("|");
  const namedM =
    raw.match(new RegExp(`(${monthPat})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "i")) ??
    raw.match(new RegExp(`(\\d{1,2})\\s+(${monthPat})(?:,?\\s+(\\d{4}))?`, "i"));

  if (namedM) {
    const isMonthFirst = /^[a-z]/i.test(namedM[1]!);
    const monthStr   = isMonthFirst ? namedM[1]!.toLowerCase() : namedM[2]!.toLowerCase();
    const dayStr     = isMonthFirst ? namedM[2]! : namedM[1]!;
    const yearStr    = namedM[3] ?? String(currentYear());
    const mo = months[monthStr];
    if (mo) return `${yearStr}-${mo}-${dayStr.padStart(2, "0")}`;
  }

  // "June" only — no day → can't build an exact date
  return null;
}

/** Add `n` nights to a YYYY-MM-DD string. */
export function addNightsToISO(isoDate: string, nights: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

// ── Apify actor call ──────────────────────────────────────────────────────────

async function runBookingSearch(
  destination: string,
  checkIn: string,   // YYYY-MM-DD
  checkOut: string,  // YYYY-MM-DD
  adults: number,
): Promise<BookingHotel[]> {
  const token = getApifyKey();
  if (!token) return [];

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(BOOKING_ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${token}&timeout=90`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search:    destination,
        startDate: checkIn,
        endDate:   checkOut,
        rooms:     1,
        adults:    Math.max(1, adults),
        maxItems:  15,
        sortBy:    "popularity",
      }),
      signal: AbortSignal.timeout(95_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, destination, body: body.slice(0, 200) }, "[HotelAvail] Booking.com search failed");
      return [];
    }

    const data  = await res.json() as unknown;
    const items = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    logger.info({ destination, checkIn, checkOut, count: items.length }, "[HotelAvail] Booking.com results");

    return items
      .map((item) => {
        const rawPrice = item["price"] ?? item["pricePerNight"] ?? item["avgPrice"];
        const price = rawPrice ? `$${Math.round(Number(rawPrice))}/night` : undefined;
        return {
          name:        String(item["name"] ?? item["hotelName"] ?? item["title"] ?? ""),
          bookingUrl:  String(item["url"] ?? item["link"] ?? item["bookingUrl"] ?? ""),
          pricePerNight: price,
          rating:      item["rating"] ? Number(item["rating"]) : undefined,
          reviewCount: item["reviewCount"] ?? item["reviews"]
            ? Number(item["reviewCount"] ?? item["reviews"])
            : undefined,
          address:     item["address"] ? String(item["address"]) : undefined,
          stars:       item["stars"] ? Number(item["stars"]) : undefined,
        } satisfies BookingHotel;
      })
      .filter((h) => h.name && h.bookingUrl);
  } catch (err) {
    logger.warn({ err, destination }, "[HotelAvail] Booking.com search threw");
    return [];
  }
}

// ── Name matching ─────────────────────────────────────────────────────────────

function normalizeHotelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(hotel|the|a|an|inn|suites?|resort|motel|lodge|boutique|grand|royal)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreNameMatch(recommended: string, candidate: string): number {
  const normRec = normalizeHotelName(recommended);
  const normCan = normalizeHotelName(candidate);
  if (!normRec || !normCan) return 0;
  if (normRec === normCan) return 100;
  if (normCan.includes(normRec) || normRec.includes(normCan)) return 85;

  const recWords = normRec.split(" ").filter((w) => w.length > 2);
  const canWords = new Set(normCan.split(" ").filter((w) => w.length > 2));
  const overlap  = recWords.filter((w) => canWords.has(w)).length;
  return recWords.length > 0 ? Math.round((overlap / recWords.length) * 65) : 0;
}

export function matchHotelToResults(
  recommendedName: string,
  searchResults: BookingHotel[],
): HotelAvailabilityMatch {
  if (!searchResults.length) return { matched: null, bestAlternative: null };

  const scored = searchResults
    .map((h) => ({ hotel: h, score: scoreNameMatch(recommendedName, h.name) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  if (top.score >= 50) {
    // Good match — return it and offer the next result as a fallback option
    const alt = searchResults.find((h) => h !== top.hotel) ?? null;
    return { matched: top.hotel, bestAlternative: alt };
  }

  // No match — hotel not found on Booking.com for these dates
  return { matched: null, bestAlternative: top.hotel };
}

// ── Public search (with cache) ────────────────────────────────────────────────

export async function searchBookingAvailability(
  destination: string,
  checkIn: string,
  checkOut: string,
  partySize: number,
): Promise<BookingHotel[]> {
  const slug = destination.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const cacheKey = `booking:${slug}:${checkIn}:${checkOut}`;

  const cached = await getCachedApify(cacheKey, CACHE_TTL_MS);
  if (cached) {
    try {
      const hotels = JSON.parse(cached) as BookingHotel[];
      logger.info({ destination, checkIn, checkOut, count: hotels.length }, "[HotelAvail] Cache hit");
      return hotels;
    } catch { /* fall through to live fetch */ }
  }

  const hotels = await runBookingSearch(destination, checkIn, checkOut, partySize);
  if (hotels.length) {
    await setCachedApify(cacheKey, JSON.stringify(hotels));
  }
  return hotels;
}
