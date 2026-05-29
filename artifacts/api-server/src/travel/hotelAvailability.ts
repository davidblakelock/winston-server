/**
 * Hotel Search — Google Places API
 *
 * Searches for hotels at a destination using Google Places (fast, reliable, <2 s).
 * Returns hotel names, ratings, addresses, and website links.
 * Does not provide date-specific availability or nightly pricing — a Google Hotels
 * search link is injected so the user can check specific dates directly.
 *
 * Falls back silently when GOOGLE_PLACES_API_KEY is absent.
 */

import { logger } from "../lib/logger.js";
import { getCachedApify, setCachedApify } from "../lib/apifyCache.js";

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 h

function getPlacesKey(): string { return (process.env.GOOGLE_PLACES_API_KEY ?? "").trim(); }
export function isBookingAvailabilityReady(): boolean { return !!getPlacesKey(); }

// ── Types (interface kept compatible with existing callers) ───────────────────

export interface BookingHotel {
  name: string;
  bookingUrl: string;       // hotel website or Google Hotels search URL
  pricePerNight?: string;   // not available from Places — always undefined
  rating?: number;          // Google scale: 0–5
  reviewCount?: number;
  address?: string;
  stars?: number;
}

export interface HotelAvailabilityMatch {
  matched: BookingHotel | null;
  bestAlternative: BookingHotel | null;
}

// ── Date helpers (unchanged — still used by tripPlanningManager) ──────────────

function currentYear(): number {
  return parseInt(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago", year: "numeric" }), 10);
}

export function parseToISODate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  const slashM = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashM) {
    const m = slashM[1]!.padStart(2, "0");
    const d = slashM[2]!.padStart(2, "0");
    const y = slashM[3]
      ? (slashM[3].length === 2 ? `20${slashM[3]}` : slashM[3])
      : String(currentYear());
    return `${y}-${m}-${d}`;
  }

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

  return null;
}

export function addNightsToISO(isoDate: string, nights: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

// ── Google Places hotel search ────────────────────────────────────────────────

interface PlacesResult {
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
  websiteUri?: string;
}

async function runPlacesSearch(destination: string, maxResults = 8): Promise<BookingHotel[]> {
  const key = getPlacesKey();
  if (!key) return [];

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.formattedAddress,places.websiteUri,places.userRatingCount",
      },
      body: JSON.stringify({
        textQuery: `hotels in ${destination}`,
        includedType: "lodging",
        maxResultCount: Math.min(maxResults, 10),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, destination, body: body.slice(0, 200) }, "[HotelSearch] Google Places request failed");
      return [];
    }

    const data = await res.json() as { places?: PlacesResult[] };
    const places = data.places ?? [];
    logger.info({ destination, count: places.length }, "[HotelSearch] Google Places results");

    const hotels: BookingHotel[] = [];
    for (const p of places) {
      const name = p.displayName?.text ?? "";
      if (!name) continue;
      const googleHotelsUrl = `https://www.google.com/travel/search?q=${encodeURIComponent(name + " " + destination)}`;
      hotels.push({
        name,
        bookingUrl:  p.websiteUri ?? googleHotelsUrl,
        rating:      p.rating,
        reviewCount: p.userRatingCount,
        address:     p.formattedAddress,
      });
    }
    return hotels;
  } catch (err) {
    logger.warn({ err, destination }, "[HotelSearch] Google Places search threw");
    return [];
  }
}

// ── Name matching (unchanged) ─────────────────────────────────────────────────

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
    const alt = searchResults.find((h) => h !== top.hotel) ?? null;
    return { matched: top.hotel, bestAlternative: alt };
  }

  return { matched: null, bestAlternative: top.hotel };
}

// ── High-level availability check ────────────────────────────────────────────

export interface HotelAvailabilityResult {
  queried: {
    hotelName?: string;
    destination: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    nights: number;
  };
  specific: BookingHotel | null;
  namedHotelNotFound: boolean;
  alternatives: BookingHotel[];
  totalFound: number;
  ready: boolean;
}

export async function checkHotelAvailability(params: {
  hotelName?: string;
  destination: string;
  checkIn: string;
  checkOut: string;
  adults: number;
}): Promise<HotelAvailabilityResult> {
  const { hotelName, destination, checkIn, checkOut, adults } = params;

  const checkInMs  = new Date(`${checkIn}T12:00:00Z`).getTime();
  const checkOutMs = new Date(`${checkOut}T12:00:00Z`).getTime();
  const nights     = Math.max(1, Math.round((checkOutMs - checkInMs) / 86_400_000));

  const base: HotelAvailabilityResult = {
    queried: { hotelName, destination, checkIn, checkOut, adults, nights },
    specific: null,
    namedHotelNotFound: false,
    alternatives: [],
    totalFound: 0,
    ready: isBookingAvailabilityReady(),
  };

  if (!base.ready) return base;

  const results = await searchBookingAvailability(destination, checkIn, checkOut, adults);
  base.totalFound = results.length;

  if (!results.length) return base;

  if (hotelName) {
    const match = matchHotelToResults(hotelName, results);
    if (match.matched) {
      base.specific     = match.matched;
      base.alternatives = results.filter((h) => h !== match.matched).slice(0, 4);
    } else {
      base.namedHotelNotFound = true;
      const alts = match.bestAlternative
        ? [match.bestAlternative, ...results.filter((h) => h !== match.bestAlternative).slice(0, 3)]
        : results.slice(0, 4);
      base.alternatives = alts;
    }
  } else {
    base.alternatives = results.slice(0, 5);
  }

  return base;
}

// ── Context block for Claude ──────────────────────────────────────────────────

export function buildHotelAvailabilityBlock(r: HotelAvailabilityResult): string {
  const { queried, specific, namedHotelNotFound, alternatives, totalFound, ready } = r;
  const nights = queried.nights;
  const datesLabel = `${queried.checkIn} → ${queried.checkOut} (${nights} night${nights !== 1 ? "s" : ""})`;

  if (!ready) {
    return `\n\n[Hotel Search — Not Configured]\nHotel search isn't available right now. Suggest the user check Google Hotels or Booking.com directly.`;
  }

  if (totalFound === 0) {
    return (
      `\n\n[Hotel Search — No Results]\n` +
      `Searched for hotels in: ${queried.destination}.\n` +
      `No results returned. Suggest the user try Google Hotels directly for ${queried.destination} on ${datesLabel}.`
    );
  }

  const googleHotelsSearchUrl =
    `https://www.google.com/travel/hotels/${encodeURIComponent(queried.destination)}` +
    `?checkin=${queried.checkIn}&checkout=${queried.checkOut}&adults=${queried.adults}`;

  const lines: string[] = [
    `\n\n[VERIFIED — Hotel Search via Google Places]`,
    `Destination: ${queried.destination} | Dates: ${datesLabel} | Guests: ${queried.adults}`,
    `Total hotels found: ${totalFound}`,
    `NOTE: These are top-rated hotels at this destination. Pricing and exact availability for the chosen dates must be confirmed on the hotel's website or Google Hotels.`,
    `Google Hotels search for these exact dates: ${googleHotelsSearchUrl}`,
  ];

  if (specific) {
    lines.push(`\n✓ FOUND — ${queried.hotelName} is in the area:`);
    lines.push(`  Name:    ${specific.name}`);
    if (specific.rating)      lines.push(`  Rating:  ${specific.rating}/5${specific.reviewCount ? ` (${specific.reviewCount.toLocaleString()} reviews)` : ""}`);
    if (specific.address)     lines.push(`  Address: ${specific.address}`);
    lines.push(`  Website: ${specific.bookingUrl}`);
  } else if (namedHotelNotFound) {
    lines.push(`\n✗ "${queried.hotelName}" was not found in Google Places for ${queried.destination}.`);
    lines.push(`  It may be under a different name or listed elsewhere.`);
  }

  if (alternatives.length) {
    const label = specific
      ? "\nOther top-rated hotels nearby:"
      : namedHotelNotFound
        ? "\nTop-rated alternatives in the area:"
        : "\nTop-rated hotels in this area:";
    lines.push(label);
    for (const h of alternatives) {
      const rating = h.rating ? ` — ${h.rating}/5` : "";
      const reviews = h.reviewCount ? ` (${h.reviewCount.toLocaleString()} reviews)` : "";
      lines.push(`  • ${h.name}${rating}${reviews}`);
      if (h.address) lines.push(`    ${h.address}`);
      lines.push(`    ${h.bookingUrl}`);
    }
  }

  lines.push(
    `\nINSTRUCTIONS: Report these results conversationally. ` +
    (specific
      ? `Let the user know you found ${queried.hotelName} in the area — share its rating, address, and website. ` +
        `Mention 1–2 alternatives with their ratings. ` +
        `Always give the Google Hotels link for checking pricing on those exact dates.`
      : namedHotelNotFound
        ? `Let the user know ${queried.hotelName ?? "that hotel"} wasn't found in Google's listings for ${queried.destination}. ` +
          `Present the top 2–3 alternatives warmly with ratings and websites. ` +
          `Give the Google Hotels link for those exact dates.`
        : `Present the top 2–3 hotels with their ratings and websites. ` +
          `Give the Google Hotels link for checking pricing on those exact dates.`) +
    ` Do NOT say you can't check hotels — you have results above. Always include the Google Hotels link.`
  );

  return lines.join("\n");
}

// ── Public search with cache (kept for tripPlanningManager compatibility) ─────

export async function searchBookingAvailability(
  destination: string,
  _checkIn: string,
  _checkOut: string,
  _partySize: number,
): Promise<BookingHotel[]> {
  const slug = destination.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const cacheKey = `places:${slug}`;

  const cached = await getCachedApify(cacheKey, CACHE_TTL_MS);
  if (cached) {
    try {
      const hotels = JSON.parse(cached) as BookingHotel[];
      logger.info({ destination, count: hotels.length }, "[HotelSearch] Cache hit");
      return hotels;
    } catch { /* fall through to live fetch */ }
  }

  const hotels = await runPlacesSearch(destination);
  if (hotels.length) {
    await setCachedApify(cacheKey, JSON.stringify(hotels));
  }
  return hotels;
}
