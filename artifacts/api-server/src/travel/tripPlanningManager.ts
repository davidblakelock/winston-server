/**
 * Trip Planning Manager
 *
 * Winston's trip planning companion — full conversational flow, day-by-day
 * itinerary generation, and CRUD for saved trip plans.
 *
 * Conversation flow:
 *   - User describes a trip → parse what they gave, ask ONE follow-up only
 *     if something critical is genuinely missing (dates, duration, party).
 *   - Generate complete day-by-day itinerary with Claude Sonnet.
 *   - Store in trip_plans table.
 */

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { MODEL_SONNET } from "../lib/models.js";
import {
  isPartnerRelationship,
  type CollectedData,
  type UserProfile,
} from "../onboarding/onboardingManager.js";
import {
  searchBookingAvailability,
  matchHotelToResults,
  parseToISODate,
  addNightsToISO,
  isBookingAvailabilityReady,
  type BookingHotel,
} from "./hotelAvailability.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Pending conversation state ────────────────────────────────────────────────

export type TripPlanPhase = "clarify" | "generating";

export interface ParsedTripIntent {
  destination: string;
  nights?: number;
  startDate?: string;      // YYYY-MM-DD
  endDate?: string;        // YYYY-MM-DD
  partySize?: number;
  partyDesc?: string;      // "my wife Susan", "solo", etc.
  vibe?: string;           // "romantic", "adventurous", "relaxed", etc.
  mustHaves?: string;
  beenBefore?: boolean;
  budget?: string;         // "budget", "mid-range", "luxury"
  stops?: string[];        // road-trip stops mentioned
  rawMessage: string;      // original user message
}

export interface PendingTripPlan {
  intent: ParsedTripIntent;
  phase: TripPlanPhase;
  missingField?: "nights" | "destination" | "dates";
}

let _pendingTripPlan: PendingTripPlan | null = null;

export function getPendingTripPlan(): PendingTripPlan | null { return _pendingTripPlan; }
export function setPendingTripPlan(p: PendingTripPlan | null): void { _pendingTripPlan = p; }

// ── Itinerary types (native app schema) ──────────────────────────────────────

export interface NativeActivity {
  time: string;        // "Morning" | "Afternoon" | "Evening" or a specific time string
  title: string;
  description: string;
  notes: string;
}

export interface NativeMeal {
  time: string;        // "Breakfast" | "Lunch" | "Dinner"
  title: string;       // Restaurant name
  description: string; // Cuisine, vibe, why it fits
  websiteUrl: string;  // Restaurant's own website, or ""
  bookingUrl: string;  // OpenTable / Resy link, or same as websiteUrl, or ""
}

export interface NativeItineraryDay {
  dayNumber: number;
  label: string;      // Evocative day title
  location: string;   // City or neighborhood for this day
  hotel: {
    name: string;
    websiteUrl: string;
    notes: string;
    // enriched by Booking.com post-generation:
    bookingUrl?: string;
    available?: boolean;
    availabilityChecked?: boolean;
    alternativeName?: string;
    alternativeBookingUrl?: string;
    alternativePricePerNight?: string;
  };
  activities: NativeActivity[];
  meals: NativeMeal[];
}

export interface NativeItinerary {
  days: NativeItineraryDay[];
  practicalNotes: string[];
}

export interface NativeTripPlan {
  trip_name: string;
  destination: string;
  nights: number;
  start_date?: string | null;  // YYYY-MM-DD or null
  end_date?: string | null;    // YYYY-MM-DD or null
  status: "planning";
  itinerary: NativeItinerary;
}

// ── DB setup ──────────────────────────────────────────────────────────────────

export async function ensureTripPlansTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS trip_plans (
        id           SERIAL PRIMARY KEY,
        user_name    TEXT NOT NULL DEFAULT '${NATIVE_USER}',
        destination  TEXT NOT NULL,
        trip_name    TEXT,
        start_date   DATE,
        end_date     DATE,
        nights       INTEGER,
        itinerary    JSONB,
        status       TEXT NOT NULL DEFAULT 'planning',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add columns to existing tables (idempotent)
    await query(`ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS trip_name TEXT`).catch(() => {});
    await query(`ALTER TABLE trip_plans ADD COLUMN IF NOT EXISTS end_date DATE`).catch(() => {});
    // Migrate itinerary column from TEXT to JSONB if needed
    await query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='trip_plans' AND column_name='itinerary' AND data_type='text'
        ) THEN
          ALTER TABLE trip_plans ALTER COLUMN itinerary TYPE JSONB USING
            CASE WHEN itinerary IS NULL THEN NULL
                 ELSE itinerary::jsonb END;
        END IF;
      END $$
    `).catch(() => {});
    logger.info("[TripPlan] trip_plans table ready");
  } catch (err) {
    logger.warn({ err }, "[TripPlan] Table creation warning");
  }
}

// ── Intent parsing helpers ────────────────────────────────────────────────────

/**
 * Parse a user message for trip intent details.
 * Returns whatever could be extracted — caller decides what's missing.
 */
export function parseTripIntent(message: string): ParsedTripIntent {
  const msg = message.trim();

  // Destination extraction — most specific patterns first to avoid greedy "to plan" captures
  const destPatterns = [
    // "trip/road trip/vacation/travel to X" or "trip through X"
    /(?:road\s+trip|trip|vacation|holiday|getaway|travel|visit)\s+(?:through|to\s+)?([A-Z][A-Za-z\s,'-]{2,45}?)(?:\s+for|\s+with|\s+stopping|[.!?]|$)/i,
    // "romantic/anniversary/birthday/solo/family trip to X"
    /(?:romantic|anniversary|birthday|solo|family)\s+(?:trip|getaway|vacation)\s+(?:to\s+)?([A-Z][A-Za-z\s,'-]{2,40}?)(?:\s+for|\s+with|[.!?]|$)/i,
    // "to/through/in/around X" — fallback; skip common verbs that follow "to" (plan, go, see, etc.)
    /(?:to|through|in|around|visit(?:ing)?)\s+(?!(?:plan|go|see|do|get|book|check|make|take|have|find|look|help|try|start|stop|visit)\b)([A-Z][A-Za-z\s,'-]{2,50}?)(?:\s+for|\s+with|\s+stopping|[.!?]|$)/i,
  ];
  let destination = "";
  for (const pat of destPatterns) {
    const m = msg.match(pat);
    if (m?.[1]) {
      destination = m[1].trim().replace(/[.,!?]+$/, "").trim();
      break;
    }
  }

  // Duration — nights or days
  const nightsM =
    msg.match(/\b(\d+)\s*(?:-\s*)?night/i) ??
    msg.match(/\b(\d+)\s*(?:-\s*)?day/i);
  let nights: number | undefined;
  if (nightsM) {
    nights = parseInt(nightsM[1]!, 10);
    if (/\bday/i.test(nightsM[0]!)) nights = Math.max(1, nights - 1);
  } else if (/\bweekend\b/i.test(msg)) {
    nights = 2;
  }

  // Party description
  let partyDesc: string | undefined;
  let partySize: number | undefined;
  const partyM = msg.match(/(?:with|take|bring|for)\s+(my\s+(?:wife|husband|partner|girlfriend|boyfriend|family|kids?|son|daughter|friend|buddy|dad|mom|parents?|sister|brother)\s*(?:\w+)?(?:\s+and\s+\w+)?|(?:just\s+)?(?:solo|by\s+myself)|(\d+)\s+(?:of\s+us|people|adults?|friends?))/i);
  if (partyM) {
    partyDesc = partyM[1]?.trim().replace(/[.,!?]+$/, "");
    const numM = partyDesc?.match(/\b(\d+)\b/);
    if (numM) partySize = parseInt(numM[1]!, 10);
    else if (/solo|myself/i.test(partyDesc ?? "")) partySize = 1;
    else if (/wife|husband|partner|girlfriend|boyfriend/i.test(partyDesc ?? "")) partySize = 2;
  }

  // Vibe / occasion
  let vibe: string | undefined;
  if (/romantic|anniversary|honeymoon/i.test(msg)) vibe = "romantic";
  else if (/adventure|adventur|hik(?:e|ing)|outdoor|active/i.test(msg)) vibe = "adventurous";
  else if (/relax|chill|lazy|slow|restful|peaceful/i.test(msg)) vibe = "relaxed";
  else if (/birthday/i.test(msg)) vibe = "celebratory";
  else if (/family|kids?/i.test(msg)) vibe = "family-friendly";
  else if (/road\s+trip/i.test(msg)) vibe = "road trip";

  // Budget
  let budget: string | undefined;
  if (/\b(luxury|high[\s-]?end|splurge|five[\s-]?star)\b/i.test(msg)) budget = "luxury";
  else if (/\b(budget|cheap|affordable|inexpensive|backpack)\b/i.test(msg)) budget = "budget";

  // Start date
  let startDate: string | undefined;
  const dateM = msg.match(/\b(?:in\s+)?(?:late\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i);
  if (dateM) startDate = dateM[0];

  // Must-haves (after "want to", "need", "must", "have to")
  const mustM = msg.match(/(?:must|need(?:\s+to)?|have\s+to|want\s+to\s+(?:make\s+sure|definitely)|definitely)\s+(?:see|visit|try|do|experience)\s+([^,.!?]+)/i);
  const mustHaves = mustM?.[1]?.trim();

  return { destination, nights, startDate, partySize, partyDesc, vibe, mustHaves, budget, beenBefore: undefined, rawMessage: msg };
}

// ── Travel profile helper ─────────────────────────────────────────────────────

/**
 * Extracts travel-relevant signals from the user profile for use in both
 * the conversational overview prompt and the formal itinerary generation.
 */
export function buildTravelProfileContext(
  rawData: CollectedData,
  profile?: Pick<UserProfile, "healthNotes" | "name"> | null,
): string {
  const lines: string[] = [];

  // Home base — useful for "feels like home" restaurant/neighborhood comparisons
  if (rawData.city) lines.push(`Home city: ${rawData.city}`);
  if (rawData.neighborhood) lines.push(`Home neighborhood: ${rawData.neighborhood}`);

  // Travel companion — derive from people list
  const partner = rawData.people?.find((p) => isPartnerRelationship(p.relationship ?? ""));
  if (partner) {
    const relation = partner.relationship ?? "partner";
    lines.push(`Traveling with: ${partner.name} (${profile?.name?.split(" ")[0] ?? "David"}'s ${relation})`);
  }

  // Interests — split into activity signals and cultural signals
  const interests = rawData.interests ?? [];
  const active  = interests.filter((i) => /golf|hik|pickleball|bike|run|outdoor|sport|tennis|ski|climb|kayak|active|adventure/i.test(i));
  const culture = interests.filter((i) => /music|jazz|art|museum|history|theater|concert|food|wine|film|culinary|read|cook/i.test(i));
  if (active.length)  lines.push(`Active interests: ${active.join(", ")}`);
  if (culture.length) lines.push(`Cultural/leisure interests: ${culture.join(", ")}`);
  if (!active.length && !culture.length && interests.length) {
    lines.push(`Interests: ${interests.slice(0, 6).join(", ")}`);
  }

  // Music — important for live-music cities (Nashville, New Orleans, Austin, etc.)
  if (rawData.music?.length) {
    lines.push(`Music taste: ${rawData.music.slice(0, 6).join(", ")}`);
  }

  // Shows / TV — signals style preferences (e.g. Yellowstone fan → ranch/western experiences)
  if (rawData.shows?.length) {
    lines.push(`Favorite shows: ${rawData.shows.slice(0, 4).join(", ")}`);
  }

  // Sports teams — useful for scheduling around games or stadium visits
  if (rawData.sportsTeams?.length) {
    lines.push(`Sports teams: ${rawData.sportsTeams.slice(0, 4).join(", ")}`);
  }

  // Food
  if (rawData.foodPreferences?.length) {
    lines.push(`Food preferences: ${rawData.foodPreferences.join(", ")}`);
  }
  if (rawData.restaurants?.length) {
    lines.push(`Favorite restaurants at home (style reference): ${rawData.restaurants.slice(0, 5).join(", ")}`);
  }

  // Saved places — hints at venue style/taste
  if (rawData.places?.length) {
    const placeNames = rawData.places.slice(0, 5).map((p) => p.name);
    lines.push(`Saved places they love: ${placeNames.join(", ")}`);
  }

  // Health / dietary
  if (profile?.healthNotes) {
    lines.push(`Health/dietary notes: ${profile.healthNotes}`);
  }

  return lines.length
    ? `\nTraveler profile:\n${lines.map((l) => `  • ${l}`).join("\n")}`
    : "";
}

// ── Date sanitizer ────────────────────────────────────────────────────────────

/**
 * Returns the string unchanged if it is already YYYY-MM-DD, otherwise null.
 * Prevents natural-language strings like "mid-October" from crashing the
 * PostgreSQL DATE column.
 */
function toISODateOrNull(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
}

// ── Itinerary generation ──────────────────────────────────────────────────────

export async function generateTripItinerary(
  intent: ParsedTripIntent,
  userProfile: Record<string, unknown> | null,
): Promise<NativeTripPlan> {
  const rawData   = (userProfile?.rawData ?? {}) as CollectedData;
  const profile   = userProfile as Pick<UserProfile, "healthNotes" | "name"> | null;
  const travelCtx = buildTravelProfileContext(rawData, profile);

  const nights    = intent.nights ?? 3;
  const totalDays = nights + 1;
  const dest      = intent.destination;
  const party     = intent.partyDesc ?? (intent.partySize === 1 ? "solo" : "couple");
  const vibe      = intent.vibe ?? "mix of relaxed and adventurous";
  const mustHaves = intent.mustHaves || "None specified";
  const budget    = intent.budget ?? "mid-range";

  const startDateNote = intent.startDate
    ? `Start date / approximate timing: ${intent.startDate} — if this resolves to a specific calendar date, output it as start_date (YYYY-MM-DD); otherwise output null`
    : "Start date not specified — output null for start_date and end_date";

  const dayTemplate = `{
      "dayNumber": 1,
      "label": "Evocative day title, e.g. 'Delta Blues and First Bites'",
      "location": "City or neighborhood name",
      "hotel": {
        "name": "Specific real hotel name — never generic",
        "websiteUrl": "https://... (hotel's own official website — NOT booking.com or expedia)",
        "bookingUrl": "https://... (hotel's direct booking page, e.g. https://[hotel].com/reservations, or a Booking.com/Expedia direct link — REQUIRED, never empty)",
        "notes": "2–3 sentences: what makes this hotel special, its personality and vibe, why it's the right fit for this traveler's style, budget, and trip — not just 'great location'"
      },
      "activities": [
        { "time": "Morning",   "title": "Specific activity name", "description": "What to do, where exactly, why it's unmissable here — name specific streets, trails, galleries, viewpoints, or experiences", "notes": "Timing, parking, reservations needed, insider tip, what to order or wear" },
        { "time": "Afternoon", "title": "Specific activity name", "description": "Specific afternoon plan with real place names", "notes": "Practical tip" },
        { "time": "Evening",   "title": "Specific activity name", "description": "Evening wind-down, live music, sunset spot, or neighborhood stroll — specific and real", "notes": "Practical tip" }
      ],
      "meals": [
        { "time": "Lunch",  "title": "Specific restaurant name", "description": "What they're known for, the dish to order, why this place fits this traveler's palate and style — be specific and opinionated", "websiteUrl": "https://... (restaurant's own website — required, never empty)", "bookingUrl": "https://www.opentable.com/... or https://resy.com/... or same as websiteUrl if no reservation platform" },
        { "time": "Dinner", "title": "Specific restaurant name", "description": "Why this dinner spot, what makes it the right call tonight, signature dish or experience", "websiteUrl": "https://... (restaurant website — required)", "bookingUrl": "https://www.opentable.com/... or https://resy.com/... or same as websiteUrl" }
      ]
    }`;

  const prompt = `You are building a personalized travel itinerary for a real person. Be specific, opinionated, and genuinely helpful — this is not a generic travel guide.

TRIP DETAILS:
• Destination: ${dest}
• Duration: ${nights} nights / ${totalDays} days
• Traveling with: ${party}
• Vibe: ${vibe}
• Must-haves: ${mustHaves}
• Budget: ${budget}
• ${startDateNote}
${travelCtx}

HOTELS — read carefully:
• Pick a specific, named, real hotel that genuinely fits this traveler's vibe and budget
• hotel.websiteUrl: the hotel's own official website (e.g. https://[hotelname].com) — NEVER booking.com or expedia
• hotel.bookingUrl: the hotel's direct booking/reservations page (e.g. https://[hotelname].com/book or https://www.booking.com/hotel/...) — REQUIRED on every day, never leave empty
• hotel.notes: write with personality — describe what makes this property special (the rooftop bar, the neighborhood feel, the historic building, the breakfast included), explain specifically why it's right for this traveler
• If the same hotel covers multiple days, repeat it on each day with the same URLs

RESTAURANTS — read carefully:
• Pick specific, named, real restaurants — never "a local café" or "a steakhouse downtown"
• meals[].description: be opinionated — name the dish to order, describe the atmosphere, explain why this place fits this traveler's taste (reference their food preferences and home restaurants if known)
• meals[].websiteUrl: the restaurant's own website — REQUIRED on every meal, use your best knowledge of the real URL
• meals[].bookingUrl: OpenTable or Resy link if the restaurant uses one; otherwise same as websiteUrl
• 1–2 meals per day is fine; include breakfast only if it's a notable spot worth visiting

ACTIVITIES:
• 2–3 per day (Morning / Afternoon / Evening)
• Use real place names: specific trails, galleries, streets, markets, venues, parks, stadiums, music halls
• activities[].description: say exactly what to do there and why it's worth it — not just "visit the museum"
• activities[].notes: include timing, reservations, parking, what to order/wear, or a local tip that makes the difference

STRUCTURE:
• Day 1: arrival day — lighter pace, settle in, one iconic first meal
• Day ${totalDays}: departure morning — one activity max, then checkout
• For road trips: move the location each day as the route progresses; add driving times in notes
• practicalNotes: 4–6 genuinely useful tips (best season, what to book in advance, local transport, what to pack)
• trip_name: creative and evocative — capture the spirit of this specific trip, NOT just "${dest} Trip" (e.g. "Ozark Slow Burn", "Delta Blues and Crater Dust", "Neon and Honky-Tonk")
• start_date / end_date: YYYY-MM-DD only — output null if the date is vague or unknown

PERSONALIZATION — this is the most important section:
• Music: if the destination has a live music scene (Nashville, New Orleans, Austin, Memphis) AND the traveler has music interests, build at least one evening around a specific venue or music experience
• Food: cross-reference every restaurant pick with the traveler's known food preferences and home restaurant style — if they love BBQ at home, find the local equivalent; if they prefer lighter fare, skip the heavy spots
• Activity intensity: match to their interests — a golfer gets a tee time suggestion, a hiker gets a specific trail with distance and views, a pickleball player might find a local court
• Partner travel: if traveling with a partner, every day should feel intentionally romantic or designed for two — shared experiences, dinner-for-two spots, sunset moments
• Shows/sports: if the traveler follows sports teams or live music and there's a game or show during the trip timing, mention it in practicalNotes
• Reference their interests naturally in descriptions — don't just list facts, write as if you know what they'd love

Return ONLY valid JSON — no markdown fences, no explanation, no commentary:
{
  "trip_name": "Creative evocative name",
  "destination": "${dest}",
  "nights": ${nights},
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "itinerary": {
    "days": [
      ${dayTemplate}
    ],
    "practicalNotes": ["Tip 1", "Tip 2", "Tip 3", "Tip 4", "Tip 5"]
  }
}`;

  const response = await anthropic.messages.create({
    model:      MODEL_SONNET,
    max_tokens: 8000,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("").trim();

  // Strip markdown fences if Claude wrapped the JSON
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("[TripPlan] No JSON found in Claude response");

  const plan = JSON.parse(repairJson(jsonMatch[0])) as NativeTripPlan;

  // Sanitize dates so natural-language strings don't crash the DB DATE column
  plan.start_date = toISODateOrNull(plan.start_date);
  plan.end_date   = toISODateOrNull(plan.end_date);

  logger.info(
    { destination: dest, nights, days: plan.itinerary?.days?.length },
    "[TripPlan] Itinerary generated"
  );
  return plan;
}

// ── Hotel availability enrichment ─────────────────────────────────────────────

/**
 * Post-processes a generated itinerary by checking Booking.com availability
 * for each unique hotel recommended by Claude. Mutates hotel objects in-place.
 *
 * Only runs when:
 *   1. APIFY_API_KEY is configured
 *   2. A specific (parseable) start date is known from the intent
 *
 * Falls back silently on any error so the core itinerary is never blocked.
 */
export async function enrichItineraryWithHotelAvailability(
  plan:   NativeTripPlan,
  intent: ParsedTripIntent,
): Promise<void> {
  if (!isBookingAvailabilityReady()) {
    logger.info("[HotelAvail] Skipping hotel enrichment — APIFY_API_KEY not set");
    return;
  }

  const checkIn = parseToISODate(intent.startDate ?? plan.start_date ?? null);
  if (!checkIn) {
    logger.info({ startDate: intent.startDate }, "[HotelAvail] Skipping — no parseable start date");
    return;
  }

  const nights   = intent.nights ?? plan.nights ?? 3;
  const checkOut = addNightsToISO(checkIn, nights);
  const adults   = intent.partySize ?? 2;

  logger.info(
    { dest: plan.destination, checkIn, checkOut, adults },
    "[HotelAvail] Running Booking.com availability check"
  );

  let searchResults: BookingHotel[];
  try {
    searchResults = await searchBookingAvailability(plan.destination, checkIn, checkOut, adults);
  } catch (err) {
    logger.warn({ err }, "[HotelAvail] Search threw — skipping enrichment");
    return;
  }

  if (!searchResults.length) {
    logger.info({ dest: plan.destination }, "[HotelAvail] No results from Booking.com");
    return;
  }

  // Match each unique hotel name once, then apply to all days using that hotel
  const cache = new Map<string, ReturnType<typeof matchHotelToResults>>();

  for (const day of plan.itinerary.days) {
    if (!day.hotel?.name) continue;
    const name = day.hotel.name;

    if (!cache.has(name)) {
      cache.set(name, matchHotelToResults(name, searchResults));
    }
    const match = cache.get(name)!;

    day.hotel.availabilityChecked = true;
    if (match.matched) {
      day.hotel.available  = true;
      day.hotel.bookingUrl = match.matched.bookingUrl;
      logger.info({ hotel: name, url: match.matched.bookingUrl }, "[HotelAvail] ✓ Available");
    } else {
      day.hotel.available = false;
      if (match.bestAlternative) {
        day.hotel.alternativeName          = match.bestAlternative.name;
        day.hotel.alternativeBookingUrl    = match.bestAlternative.bookingUrl;
        day.hotel.alternativePricePerNight = match.bestAlternative.pricePerNight;
        logger.info({ hotel: name, alt: match.bestAlternative.name }, "[HotelAvail] ✗ Not found — alt suggested");
      } else {
        logger.info({ hotel: name }, "[HotelAvail] ✗ Not found — no alternative available");
      }
    }
  }
}

/**
 * Best-effort JSON repair for common Claude output quirks:
 * - trailing commas before } or ]
 * - single-quoted strings (replace with double quotes, careful with apostrophes)
 * - unquoted property names
 * - truncated JSON (trim to last valid closing brace)
 */
function repairJson(raw: string): string {
  // 1. Remove trailing commas before } or ]
  let s = raw.replace(/,\s*([}\]])/g, "$1");

  // 2. Try parse; if it works we're done
  try { JSON.parse(s); return s; } catch (_) { /* continue */ }

  // 3. Attempt to trim to the last complete top-level object if JSON is truncated
  // Find the last balanced closing brace
  let depth = 0;
  let lastGoodClose = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") depth++;
    else if (s[i] === "}" || s[i] === "]") {
      depth--;
      if (depth === 0) lastGoodClose = i;
    }
  }
  if (lastGoodClose > 0 && lastGoodClose < s.length - 1) {
    const trimmed = s.slice(0, lastGoodClose + 1);
    // Try once more after trimming + trailing comma removal
    const cleaned = trimmed.replace(/,\s*([}\]])/g, "$1");
    try { JSON.parse(cleaned); return cleaned; } catch (_) { /* fall through */ }
  }

  // 4. Last resort: return as-is and let the outer catch handle it
  return s;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface TripPlanRow {
  id: number;
  user_name: string;
  destination: string;
  trip_name: string | null;
  start_date: string | null;
  end_date: string | null;
  nights: number | null;
  itinerary: NativeItinerary | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Save a NativeTripPlan to the DB.
 * Top-level fields (destination, trip_name, start_date, end_date, nights, status)
 * become individual columns; the nested itinerary object goes into the JSONB column.
 * Dates are validated to YYYY-MM-DD before insert to prevent PostgreSQL DATE errors.
 */
export async function saveTripPlan(
  userName: string,
  plan: NativeTripPlan,
): Promise<number> {
  const startDate = toISODateOrNull(plan.start_date);
  const endDate   = toISODateOrNull(plan.end_date);

  const { rows } = await query<{ id: number }>(
    `INSERT INTO trip_plans
       (user_name, destination, trip_name, start_date, end_date, nights, itinerary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'planning')
     RETURNING id`,
    [
      userName,
      plan.destination,
      plan.trip_name ?? null,
      startDate,
      endDate,
      plan.nights ?? null,
      JSON.stringify(plan.itinerary),
    ]
  );
  const id = rows[0]?.id ?? 0;
  logger.info({ id, destination: plan.destination, userName }, "[TripPlan] Saved to DB");
  return id;
}

export async function getActiveTripPlans(userName = NATIVE_USER): Promise<TripPlanRow[]> {
  const { rows } = await query<TripPlanRow>(
    `SELECT id, user_name, destination, trip_name, start_date, end_date, nights, itinerary, status, created_at, updated_at
     FROM trip_plans
     WHERE user_name = $1
     ORDER BY COALESCE(start_date::text, created_at::text) DESC`,
    [userName]
  );
  return rows;
}

export async function getTripPlanById(id: number, userName: string): Promise<TripPlanRow | null> {
  const { rows } = await query<TripPlanRow>(
    `SELECT id, user_name, destination, trip_name, start_date, end_date, nights, itinerary, status, created_at, updated_at
     FROM trip_plans
     WHERE id = $1 AND user_name = $2`,
    [id, userName]
  );
  return rows[0] ?? null;
}

export async function updateTripPlan(
  id: number,
  userName: string,
  updates: {
    trip_name?: string | null;
    destination?: string;
    start_date?: string | null;
    end_date?: string | null;
    nights?: number | null;
    itinerary?: TripItinerary | null;
    status?: string;
  },
): Promise<TripPlanRow | null> {
  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let idx = 1;

  if ("trip_name" in updates) { setClauses.push(`trip_name = $${idx++}`); values.push(updates.trip_name ?? null); }
  if ("destination" in updates) { setClauses.push(`destination = $${idx++}`); values.push(updates.destination); }
  if ("start_date" in updates) { setClauses.push(`start_date = $${idx++}`); values.push(updates.start_date ?? null); }
  if ("end_date" in updates) { setClauses.push(`end_date = $${idx++}`); values.push(updates.end_date ?? null); }
  if ("nights" in updates) { setClauses.push(`nights = $${idx++}`); values.push(updates.nights ?? null); }
  if ("itinerary" in updates) { setClauses.push(`itinerary = $${idx++}::jsonb`); values.push(updates.itinerary ? JSON.stringify(updates.itinerary) : null); }
  if ("status" in updates) { setClauses.push(`status = $${idx++}`); values.push(updates.status); }

  if (setClauses.length === 1) return getTripPlanById(id, userName); // nothing to update

  values.push(id);
  values.push(userName);

  const { rows } = await query<TripPlanRow>(
    `UPDATE trip_plans SET ${setClauses.join(", ")}
     WHERE id = $${idx++} AND user_name = $${idx}
     RETURNING id, user_name, destination, trip_name, start_date, end_date, nights, itinerary, status, created_at, updated_at`,
    values
  );
  return rows[0] ?? null;
}

export async function deleteTripPlan(id: number, userName: string): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `DELETE FROM trip_plans WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

// ── Today's travel day detection ──────────────────────────────────────────────

export interface TodayTripDay {
  planId:      number;
  destination: string;
  dayNumber:   number;
  day:         ItineraryDay;
  itinerary:   TripItinerary;
}

export async function getTodayTripDay(userName = NATIVE_USER): Promise<TodayTripDay | null> {
  const plans = await getActiveTripPlans(userName).catch(() => []);
  if (!plans.length) return null;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  for (const plan of plans) {
    if (!plan.itinerary || !plan.start_date) continue;
    const itinerary = plan.itinerary;
    const nights = plan.nights ?? itinerary.nights ?? 3;

    const startDate = new Date(plan.start_date + "T00:00:00");
    for (let i = 0; i <= nights; i++) {
      const dayDate = new Date(startDate);
      dayDate.setDate(dayDate.getDate() + i);
      const dayStr = dayDate.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      if (dayStr === todayStr && itinerary.days[i]) {
        return {
          planId:      plan.id,
          destination: plan.destination,
          dayNumber:   i + 1,
          day:         itinerary.days[i]!,
          itinerary,
        };
      }
    }
  }
  return null;
}

// ── Briefing block formatter ──────────────────────────────────────────────────

export function buildTripDayBlock(todayTrip: TodayTripDay): string {
  const { destination, dayNumber, day, itinerary } = todayTrip;
  const totalDays = itinerary.days.length;
  const hotelNote = day.hotel?.name ? `\nTonight's hotel: ${day.hotel.name}` : "";
  const restaurantNote = day.restaurant?.name
    ? `\nTonight's dinner: ${day.restaurant.name} — ${day.restaurant.cuisine}`
    : "";

  return (
    `\n\n[Trip Day — ${destination}: Day ${dayNumber} of ${totalDays}]\n` +
    `Today's theme: ${day.title}\n` +
    `Morning: ${day.morning}\n` +
    `Afternoon: ${day.afternoon}\n` +
    `Evening: ${day.evening}\n` +
    `${restaurantNote}${hotelNote}\n` +
    `Practical notes: ${day.practicalNotes}\n\n` +
    `Surface this warmly near the start of the briefing — they are on a trip today. ` +
    `Give the day a sense of excitement. Reference specific places by name.`
  );
}
