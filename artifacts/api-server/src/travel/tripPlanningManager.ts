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
import OpenAI from "openai";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { MODEL_SONNET } from "../lib/models.js";

import {
  type UserProfile,
} from "../onboarding/onboardingManager.js";
import {
  parseToISODate,
  addNightsToISO,
  searchBookingAvailability,
  matchHotelToResults,
} from "./hotelAvailability.js";
import {
  isSerpApiReady,
  searchHotelViaSerpApi,
} from "./serpApiHotels.js";

const MODEL_GPT4O = "gpt-4o" as const;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    // enriched by SerpAPI post-generation:
    bookingUrl?: string;
    pricePerNight?: string;
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

// ── Intent parsing ────────────────────────────────────────────────────────────

/**
 * Extract travel intent from the user's raw message using GPT-4o.
 * Returns structured fields — no regex, no fragile pattern matching.
 */
export async function parseTripIntent(message: string): Promise<ParsedTripIntent> {
  const todayISO = new Date().toISOString().slice(0, 10);
  const currentYear = todayISO.slice(0, 4);

  try {
    const resp = await openai.chat.completions.create({
      model:           MODEL_GPT4O,
      max_tokens:      400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Today is ${todayISO}. Extract travel intent from the user message. Return ONLY a JSON object — no prose, no markdown:\n` +
            `{\n` +
            `  "destination": "primary destination — broad region/state for road trips (e.g. 'Arkansas'), specific city for single-stop trips (e.g. 'Nashville'). Never a street or venue.",\n` +
            `  "stops": ["every named city or town in visit order — e.g. ['Hot Springs','Eureka Springs','Bentonville']. Empty array [] if none."],\n` +
            `  "nights": <integer overnight stays — '4 days 3 nights' → 3; '4-day trip' → 3; 'weekend' → 2; null if unknown>,\n` +
            `  "startDate": "YYYY-MM-DD resolved to ${currentYear} unless another year is implied — 'June 26th' → '${currentYear}-06-26'; null only if no date can be inferred",\n` +
            `  "partySize": <total travelers incl. user — 'me and Susan' → 2; 'solo' → 1; 'family of 4' → 4; null if unknown>,\n` +
            `  "partyDesc": "natural description e.g. 'me and my wife Susan', 'solo', 'family of 4'. null if not stated.",\n` +
            `  "vibe": "one of: romantic | adventurous | relaxed | celebratory | family-friendly | road trip | cultural | foodie. Best fit or null.",\n` +
            `  "budget": "one of: budget | mid-range | luxury — infer from 'nice hotels', 'spa', 'luxury', 'cheap', etc. null if unclear.",\n` +
            `  "mustHaves": "comma-separated must-do items explicitly stated by the user. null if none.",\n` +
            `  "preferences": "any other preferences — spa, fine dining, pet-friendly, hiking, etc. null if none."\n` +
            `}`,
        },
        { role: "user", content: message },
      ],
    });

    const raw    = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      destination?: string | null;
      stops?:       string[] | null;
      nights?:      number | null;
      startDate?:   string | null;
      partySize?:   number | null;
      partyDesc?:   string | null;
      vibe?:        string | null;
      budget?:      string | null;
      mustHaves?:   string | null;
      preferences?: string | null;
    };

    // Merge mustHaves + preferences into one field
    const mustParts = [parsed.mustHaves, parsed.preferences].filter(Boolean);

    logger.info(
      { destination: parsed.destination, stops: parsed.stops, nights: parsed.nights, startDate: parsed.startDate, vibe: parsed.vibe },
      "[TripIntent] GPT-4o extraction complete",
    );

    return {
      destination: parsed.destination ?? "",
      stops:       (parsed.stops?.length) ? parsed.stops : undefined,
      nights:      parsed.nights      ?? undefined,
      startDate:   parsed.startDate   ?? undefined,
      partySize:   parsed.partySize   ?? undefined,
      partyDesc:   parsed.partyDesc   ?? undefined,
      vibe:        parsed.vibe        ?? undefined,
      budget:      parsed.budget      ?? undefined,
      mustHaves:   mustParts.length   ? mustParts.join("; ") : undefined,
      beenBefore:  undefined,
      rawMessage:  message,
    };
  } catch (err) {
    logger.warn({ err }, "[TripIntent] GPT-4o extraction failed — returning empty intent");
    return { destination: "", rawMessage: message };
  }
}

// ── Travel profile helper ─────────────────────────────────────────────────────

/**
 * Extracts travel-relevant signals from the user profile for use in both
 * the conversational overview prompt and the formal itinerary generation.
 */
export function buildTravelProfileContext(
  profile: UserProfile | null,
): string {
  if (!profile) return "";
  const lines: string[] = [];

  // Home base — useful for "feels like home" restaurant/neighborhood comparisons
  if (profile.city)         lines.push(`Home city: ${profile.city}`);
  if (profile.neighborhood) lines.push(`Home neighborhood: ${profile.neighborhood}`);

  // Interests — split into activity signals and cultural signals
  const interests = profile.hobbies ?? [];
  const active  = interests.filter((i) => /golf|hik|pickleball|bike|run|outdoor|sport|tennis|ski|climb|kayak|active|adventure/i.test(i));
  const culture = interests.filter((i) => /music|jazz|art|museum|history|theater|concert|food|wine|film|culinary|read|cook/i.test(i));
  if (active.length)  lines.push(`Active interests: ${active.join(", ")}`);
  if (culture.length) lines.push(`Cultural/leisure interests: ${culture.join(", ")}`);
  if (!active.length && !culture.length && interests.length) {
    lines.push(`Interests: ${interests.slice(0, 6).join(", ")}`);
  }

  // Music — important for live-music cities (Nashville, New Orleans, Austin, etc.)
  if (profile.musicGenres?.length) {
    lines.push(`Music taste: ${profile.musicGenres.slice(0, 6).join(", ")}`);
  }

  // Shows / TV — signals style preferences (e.g. Yellowstone fan → ranch/western experiences)
  if (profile.tvGenres?.length) {
    lines.push(`Favorite TV genres: ${profile.tvGenres.slice(0, 4).join(", ")}`);
  }

  // Sports teams — useful for scheduling around games or stadium visits
  if (profile.sportsTeams) {
    lines.push(`Sports teams: ${profile.sportsTeams}`);
  }

  // Favorite restaurants at home — style reference
  if (profile.favoriteRestaurants) {
    lines.push(`Favorite restaurants at home (style reference): ${profile.favoriteRestaurants}`);
  }

  // Health / dietary
  if (profile.healthNotes) {
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
  userProfile: UserProfile | null,
): Promise<NativeTripPlan> {
  const travelCtx = buildTravelProfileContext(userProfile);

  const systemPrompt = `You are a luxury travel concierge — personal, opinionated, and deeply knowledgeable. You plan trips the way a trusted friend who happens to know every great hotel and restaurant in the world would plan them. You don't generate generic itineraries. You think about the specific people traveling, what will make them feel cared for, and what they will remember years later.

Here is a concrete example of the quality, specificity, and tone you must match. This was generated for the same Arkansas road trip request and represents the exact standard:

--- QUALITY EXAMPLE ---
David, for a romantic trip with Susan, I'd make this a spa + historic hotel + great food + scenic Ozark drive experience rather than trying to pack in too many attractions.

Trip Overview: June 26–29, 2026. Night 1: Hot Springs. Night 2: Eureka Springs. Night 3: Bentonville. Return to Dallas on June 29.

Approximate driving: Dallas → Hot Springs: 5 hrs | Hot Springs → Eureka Springs: 4 hrs | Eureka Springs → Bentonville: 1 hr | Bentonville → Dallas: 5.5 hrs

Day 1 — Friday, June 26. Hotel: Hotel Hale. Located directly on Bathhouse Row, this is one of the most romantic boutique properties in Arkansas, with private thermal bath experiences and easy walking access to downtown Hot Springs. Expected June rate: approximately $325–$450/night. Afternoon: Check in, couples thermal bath experience, walk Bathhouse Row, cocktails at a rooftop bar overlooking downtown. Dinner: Luna Bella — excellent date-night atmosphere, handmade pasta, seafood, and cocktails. Reservations recommended. Romantic Evening: Stroll through historic downtown, nightcap at the hotel, early evening soak.

Day 2 — Saturday, June 27. Hotel Choice #1 (Most Romantic): Treehouse Cottages — private luxury treehouses with fireplaces, Jacuzzi tubs, and forest views. This is exactly the sort of place couples remember years later. Typical June pricing: approximately $350–$500/night. Alternative Historic Option: 1886 Crescent Hotel & Spa — historic mountaintop resort with full spa, outdoor pool, and spectacular views, $250–$400/night. Afternoon: Couples massage at the Crescent Spa, explore downtown Eureka Springs, browse galleries and shops. Dinner: Grotto Wood Fired Grill and Wine Cave — probably the most romantic restaurant in Eureka Springs. Intimate cave-like setting, excellent steaks, seafood, and cocktails.

Day 3 — Sunday, June 28. Hotel: 21c Museum Hotel Bentonville — the most stylish hotel in Northwest Arkansas. Contemporary art throughout the property, walkable to downtown and Crystal Bridges. Typical room rates: $250–$400/night. Afternoon: Crystal Bridges Museum of American Art, downtown square, public art installations around town. Dinner: The Preacher's Son — one of the most romantic dining rooms in Arkansas, located inside a restored church.

Day 4 — Monday, June 29. Morning: Breakfast downtown, one final visit to Crystal Bridges grounds, depart around 10:00 AM. Arrive Dallas mid-afternoon.

My preferred version: Hotel Hale (Hot Springs) + Treehouse Cottages (Eureka Springs) + 21c Museum Hotel Bentonville. That combination gives you thermal baths, a private romantic treehouse experience, and a sophisticated art-hotel finale.
--- END QUALITY EXAMPLE ---

Study that example carefully. Notice: it names specific properties and explains exactly why each is right for the travelers. It gives driving times. It offers both a top pick and an alternative. The hotel notes have personality — "exactly the sort of place couples remember years later." The restaurant descriptions are opinionated. It ends with a clear recommendation. That is the standard.

Now generate an itinerary at that quality level, formatted as the JSON structure below. The text in every "notes" and "description" field must match the richness, specificity, and warmth of the example above.

Return ONLY valid JSON — no markdown fences, no explanation, just the JSON object.

Required structure:
{
  "trip_name": "Creative evocative name — not just '[City] Trip'. Example: 'Ozark Slow Burn', 'Delta Blues and Crater Dust'",
  "destination": "Primary destination",
  "nights": <integer — number of overnight stays>,
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "itinerary": {
    "days": [
      {
        "dayNumber": 1,
        "label": "Evocative day title, e.g. 'Thermal Waters and First Bites'",
        "location": "City or neighborhood",
        "hotel": {
          "name": "Specific real hotel name — never generic",
          "websiteUrl": "Hotel's own official website — never booking.com or expedia",
          "bookingUrl": "Direct booking page or booking.com/expedia link — required, never empty",
          "notes": "2–3 sentences with the personality and voice from the example above — what makes this property special, the vibe, why it's right for these exact travelers. Include approximate nightly rate."
        },
        "activities": [
          { "time": "Morning", "title": "Activity name", "description": "Specific real places — name the street, the trail, the gallery, the viewpoint. Say why it's unmissable.", "notes": "Driving time from previous stop if applicable. Reservations, parking, what to wear, insider tip." }
        ],
        "meals": [
          { "time": "Dinner", "title": "Specific restaurant name", "description": "Opinionated recommendation — name the signature dish, describe the atmosphere, explain why this is the right call tonight for these travelers", "websiteUrl": "Restaurant's own website — required", "bookingUrl": "OpenTable/Resy link or same as websiteUrl" }
        ]
      }
    ],
    "practicalNotes": ["Practical tip 1 — specific and actionable", "Book X in advance", "Best time to arrive at Y", "What to pack for Z"]
  }
}

Rules — follow exactly:
- If the user specifies which city each night is in, honor that exactly: one hotel per city, in the stated order, activities and restaurants located in that city.
- The last day (departure day) has no hotel — traveler is checking out that morning. One breakfast or morning activity max, then they drive home.
- hotel.websiteUrl is the hotel's own official site. meals[].websiteUrl is the restaurant's own site. Both are required — never leave empty.
- For road trips, include approximate driving times between stops in the first activity notes of each travel day.
- Where the trip vibe is romantic, every evening should feel designed for two — intimate restaurants, sunset moments, no generic tourist traps.
- 2–3 activities per day, 1–2 meals per day (include breakfast only if it's a genuinely notable spot).
${travelCtx ? `\nTraveler profile — personalize every recommendation to these preferences:\n${travelCtx}` : ""}`;

  const rawMessage = intent.rawMessage ?? `Plan a ${intent.nights ?? 3}-night trip to ${intent.destination}`;

  process.stdout.write(`[STDOUT] TRIP-PLAN generateTripItinerary CALLED rawMsg="${rawMessage.slice(0, 120)}" OPENAI_KEY_SET=${!!process.env.OPENAI_API_KEY} ${new Date().toISOString()}\n`);
  logger.info(
    { model: MODEL_GPT4O, rawMessage: rawMessage.slice(0, 200) },
    "[TripPlan] 🚀 Calling GPT-4o with raw user message"
  );

  const response = await openai.chat.completions.create({
    model:      MODEL_GPT4O,
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: rawMessage },
    ],
  });

  const text = (response.choices[0]?.message?.content ?? "").trim();

  logger.info(
    { rawResponseLen: text.length, rawResponsePreview: text.slice(0, 500) },
    "[TripPlan] 📥 RAW GPT-4o RESPONSE (first 500 chars)"
  );

  // Strip markdown fences if GPT-4o wrapped the JSON
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.error({ rawText: text.slice(0, 1000) }, "[TripPlan] ❌ No JSON found in GPT-4o response");
    throw new Error("[TripPlan] No JSON found in GPT-4o response");
  }

  const plan = JSON.parse(repairJson(jsonMatch[0])) as NativeTripPlan;

  // Sanitize dates so natural-language strings don't crash the DB DATE column
  plan.start_date = toISODateOrNull(plan.start_date);
  plan.end_date   = toISODateOrNull(plan.end_date);

  logger.info(
    { destination: plan.destination, nights: plan.nights, days: plan.itinerary?.days?.length },
    "[TripPlan] Itinerary generated"
  );
  return plan;
}

// ── Hotel availability enrichment (SerpAPI) ───────────────────────────────────

const SERP_MAX_SEARCHES_PER_ITINERARY = 3;

/**
 * Post-processes a generated itinerary by looking up each unique hotel via
 * SerpAPI Google Hotels to get real nightly rates and booking URLs for the
 * exact check-in/check-out dates.
 *
 * Rules:
 *   - Only fires inside generateTripItinerary — never from chat or other routes
 *   - Max 3 SerpAPI searches per itinerary (free tier: 100/month)
 *   - Results cached in apify_cache (6 h) — same hotel+date never searched twice
 *   - Fallback chain: SerpAPI → Google Places (website only) → plain name, no link
 *   - Mutates hotel objects in-place; never throws — core itinerary is never blocked
 */
export async function enrichItineraryWithHotelAvailability(
  plan:   NativeTripPlan,
  intent: ParsedTripIntent,
): Promise<void> {
  const nights   = intent.nights ?? plan.nights ?? 3;
  const adults   = intent.partySize ?? 2;

  // Resolve check-in date. If not provided, fall through to Places-only enrichment
  // (website URLs + alternatives) without SerpAPI pricing — never skip entirely.
  const rawCheckIn = parseToISODate(intent.startDate ?? plan.start_date ?? undefined);

  // If no real date, use a proxy 30 days out so SerpAPI still returns representative
  // pricing (displayed as "approx." to the user). Better than no data at all.
  const checkIn  = rawCheckIn ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  })();
  const checkOut = addNightsToISO(checkIn, nights);
  const hasRealDates = !!rawCheckIn;

  const serpReady = isSerpApiReady();
  logger.info(
    { dest: plan.destination, checkIn, checkOut, adults, serpReady, hasRealDates },
    "[HotelAvail] Starting hotel enrichment",
  );

  // Build a per-day search plan: hotel name + the specific city for that day + per-night dates.
  // For road trips each hotel is in a different city — using plan.destination (the overall
  // destination) for every SerpAPI search causes mismatches and zero results.
  // Key: "HotelName::City" to de-duplicate same hotel across multiple days at same stop.
  type HotelSearchEntry = {
    hotelName: string;
    city: string;       // day.location (e.g. "Eureka Springs") not plan.destination
    dayCheckIn: string; // YYYY-MM-DD for the night this hotel is first used
    dayCheckOut: string;
  };
  const searchPlan: HotelSearchEntry[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < plan.itinerary.days.length; i++) {
    const day = plan.itinerary.days[i]!;
    const hotelName = day.hotel?.name;
    if (!hotelName) continue;

    // Use the day's specific city; fall back to overall destination only if not set
    const city = (day.location && day.location.trim()) ? day.location.trim() : plan.destination;

    // Per-night dates: day i of trip = night i (0-indexed from trip start)
    const dayCheckIn  = addNightsToISO(checkIn, i);
    const dayCheckOut = addNightsToISO(dayCheckIn, 1);

    const key = `${hotelName}::${city}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (searchPlan.length >= SERP_MAX_SEARCHES_PER_ITINERARY) break;
    searchPlan.push({ hotelName, city, dayCheckIn, dayCheckOut });
  }

  logger.info(
    { searchPlan: searchPlan.map(e => `${e.hotelName} in ${e.city} (${e.dayCheckIn}→${e.dayCheckOut})`), limit: SERP_MAX_SEARCHES_PER_ITINERARY },
    "[HotelAvail] Hotel search plan",
  );

  // Pre-fetch destination-wide Google Places results per unique city.
  // Used as a reliable fallback when SerpAPI can't match a specific hotel name.
  const destHotelsByCity = new Map<string, Awaited<ReturnType<typeof searchBookingAvailability>>>();
  const uniqueCities = [...new Set(searchPlan.map(e => e.city))];
  await Promise.all(uniqueCities.map(async (city) => {
    try {
      const results = await searchBookingAvailability(city, checkIn, checkOut, adults);
      destHotelsByCity.set(city, results);
      logger.info({ city, count: results.length }, "[HotelAvail] Destination-wide Places pre-fetch");
    } catch {
      destHotelsByCity.set(city, []);
    }
  }));

  // Run SerpAPI search for each unique hotel+city combo; cache by key
  const resultCache = new Map<string, Awaited<ReturnType<typeof searchHotelViaSerpApi>>>();

  for (const entry of searchPlan) {
    const key = `${entry.hotelName}::${entry.city}`;
    try {
      const result = await searchHotelViaSerpApi(
        entry.hotelName,
        entry.city,          // ← per-day city, not overall plan.destination
        entry.dayCheckIn,    // ← per-night check-in date
        entry.dayCheckOut,   // ← per-night check-out date
        adults,
      );
      resultCache.set(key, result);
    } catch (err) {
      logger.warn({ err, hotel: entry.hotelName, city: entry.city }, "[HotelAvail] SerpAPI search threw — skipping");
    }
  }

  // Apply results to all days
  for (let i = 0; i < plan.itinerary.days.length; i++) {
    const day = plan.itinerary.days[i]!;
    const name = day.hotel?.name;
    if (!name) continue;

    const city = (day.location && day.location.trim()) ? day.location.trim() : plan.destination;
    const key  = `${name}::${city}`;
    const result = resultCache.get(key);
    day.hotel.availabilityChecked = true;

    if (result?.source === "serpapi") {
      day.hotel.available = true;
      if (result.bookingUrl) day.hotel.bookingUrl = result.bookingUrl;
      if (result.websiteUrl && (!day.hotel.websiteUrl || day.hotel.websiteUrl === "")) {
        day.hotel.websiteUrl = result.websiteUrl;
      }
      day.hotel.pricePerNight = result.pricePerNight
        ? (hasRealDates ? result.pricePerNight : `~${result.pricePerNight}`)
        : undefined;
      logger.info(
        { hotel: name, city, price: day.hotel.pricePerNight, bookingUrl: result.bookingUrl.substring(0, 60), hasRealDates },
        "[HotelAvail] ✓ SerpAPI — rate and booking URL populated",
      );
    } else if (result?.source === "places" && result.websiteUrl) {
      day.hotel.available = false;
      if (!day.hotel.bookingUrl) day.hotel.bookingUrl = result.websiteUrl;
      if (!day.hotel.websiteUrl) day.hotel.websiteUrl = result.websiteUrl;
      logger.info({ hotel: name, city, websiteUrl: result.websiteUrl }, "[HotelAvail] ~ Places name-lookup fallback");
    } else {
      // Neither SerpAPI nor name-specific Places matched — try city-wide Places fallback
      day.hotel.available = false;
      const destHotels = destHotelsByCity.get(city) ?? [];

      if (destHotels.length > 0) {
        const match = matchHotelToResults(name, destHotels);
        const bestHit = match.matched ?? match.bestAlternative;

        if (bestHit?.bookingUrl) {
          const url = bestHit.bookingUrl;
          if (!day.hotel.bookingUrl) day.hotel.bookingUrl = url;
          if (!day.hotel.websiteUrl) day.hotel.websiteUrl = url;
          logger.info(
            { hotel: name, city, matchedName: bestHit.name, url: url.substring(0, 60) },
            "[HotelAvail] ~ City-wide Places fallback — URL populated",
          );
        }

        const alts = destHotels.filter((h) => h !== match.matched).slice(0, 2);
        if (alts[0]) {
          day.hotel.alternativeName       = alts[0].name;
          day.hotel.alternativeBookingUrl = alts[0].bookingUrl;
        }
        logger.info({ hotel: name, city, altsCount: alts.length }, "[HotelAvail] ~ City-wide alternatives attached");
      } else {
        logger.info({ hotel: name, city }, "[HotelAvail] ✗ No result from SerpAPI, Places, or city-wide search");
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
