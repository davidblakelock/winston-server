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

// ── Itinerary types ───────────────────────────────────────────────────────────

export interface ItineraryRestaurant {
  name: string;
  cuisine: string;
  whyItFits: string;
  bookingUrl?: string;   // OpenTable or Resy link if known
  websiteUrl?: string;
  phone?: string;
}

export interface ItineraryHotel {
  name: string;
  whyItFits: string;
  websiteUrl?: string;
  priceRange?: string;   // "$", "$$", "$$$", "$$$$"
}

export interface ItineraryDay {
  day: number;
  date?: string;           // YYYY-MM-DD if start date known
  title: string;           // evocative day title
  morning: string;
  afternoon: string;
  evening: string;
  restaurant: ItineraryRestaurant;
  hotel: ItineraryHotel;   // where they sleep this night
  practicalNotes: string;
}

export interface TripItinerary {
  tripName: string;
  destination: string;
  startDate?: string;    // YYYY-MM-DD
  endDate?: string;      // YYYY-MM-DD
  nights: number;
  partyDesc?: string;
  summary: string;
  generalTips: string[];
  days: ItineraryDay[];
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

// ── Itinerary generation ──────────────────────────────────────────────────────

export async function generateTripItinerary(
  intent: ParsedTripIntent,
  userProfile: Record<string, unknown> | null,
): Promise<TripItinerary> {
  const rawData   = (userProfile?.rawData as Record<string, unknown>) ?? {};
  const interests = (rawData.interests as string[] | undefined)?.join(", ") ?? "good food, culture, exploration";
  const dietaryRestrictions = (rawData.dietaryRestrictions as string[] | undefined)?.join(", ") ?? "";
  const foodPrefs = (rawData.foodPreferences as string[] | undefined)?.join(", ") ?? "";

  const nights    = intent.nights ?? 3;
  const totalDays = nights + 1;
  const dest      = intent.destination;
  const party     = intent.partyDesc ?? (intent.partySize === 1 ? "solo" : "couple");
  const vibe      = intent.vibe ?? "mix of relaxed and adventurous";
  const mustHaves = intent.mustHaves || "None specified";
  const budget    = intent.budget ?? "mid-range";

  const startDateNote = intent.startDate
    ? `Start date / approximate timing: ${intent.startDate}`
    : "Start date not specified — omit dates from the itinerary, just use Day 1, Day 2 labels";

  const prompt = `You are creating a personalized travel itinerary for a trip to ${dest}.

TRIP DETAILS:
• Destination: ${dest}
• Duration: ${nights} nights (${totalDays} days)
• Traveling with: ${party}
• Vibe: ${vibe}
• Must-haves: ${mustHaves}
• Budget level: ${budget}
• ${startDateNote}
• Traveler interests: ${interests}
${foodPrefs ? `• Food preferences: ${foodPrefs}` : ""}
${dietaryRestrictions ? `• Dietary restrictions: ${dietaryRestrictions}` : ""}

Generate a complete, specific, day-by-day itinerary using REAL place names.

RULES:
• Use real named establishments, neighborhoods, parks, museums, trails — no generic descriptions
• Hotels: recommend real properties that fit the budget level and vibe
• Restaurants: real establishments with specific cuisine and why they fit this traveler
• Include OpenTable or Resy booking URLs where you know them (e.g. https://www.opentable.com/r/restaurant-slug); if unsure, include the restaurant website URL instead
• Day 1 accounts for travel/arrival — lighter schedule
• Last day accounts for departure — morning activities only before checkout
• Practical notes should be genuinely useful: timing, reservations needed, transport, insider tips
• If vibe is "romantic" — intimate venues, sunset spots, private experiences
• If vibe is "road trip" — stopping points, driving times, scenic routes
• If traveling with kids — family-friendly activities and restaurants
• One hotel per night (can repeat same hotel for multi-night stays in one city)

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "tripName": "Short evocative name for this trip e.g. 'Arkansas River Road' or 'Napa for Two'",
  "destination": "${dest}",
  "nights": ${nights},
  "partyDesc": "${party}",
  "summary": "One vivid sentence capturing the spirit of this trip",
  "generalTips": ["Practical tip 1", "Practical tip 2", "Practical tip 3", "Practical tip 4"],
  "days": [
    {
      "day": 1,
      "title": "Short evocative title for the day",
      "morning": "What to do in the morning — specific places, activities",
      "afternoon": "What to do in the afternoon — specific places",
      "evening": "Evening plan — neighborhood, activity, or wind-down",
      "restaurant": {
        "name": "Restaurant name",
        "cuisine": "Cuisine type and style",
        "whyItFits": "One sentence on why this fits the vibe and traveler",
        "bookingUrl": "https://www.opentable.com/... or https://resy.com/... if known, else null",
        "websiteUrl": "Restaurant website URL if known, else null",
        "phone": null
      },
      "hotel": {
        "name": "Hotel name",
        "whyItFits": "One sentence on why this hotel fits",
        "websiteUrl": "Hotel website URL",
        "priceRange": "$$ or $$$ or $$$$ matching the budget"
      },
      "practicalNotes": "Timing, reservations needed, transport, or insider tips"
    }
  ]
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

  const itinerary = JSON.parse(repairJson(jsonMatch[0])) as TripItinerary;
  logger.info({ destination: dest, nights, days: itinerary.days?.length }, "[TripPlan] Itinerary generated");
  return itinerary;
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
  itinerary: TripItinerary | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function saveTripPlan(
  userName:  string,
  intent:    ParsedTripIntent,
  itinerary: TripItinerary,
): Promise<number> {
  const startDate = intent.startDate ?? itinerary.startDate ?? null;
  const endDate   = itinerary.endDate ?? null;
  const nights    = intent.nights ?? itinerary.nights ?? null;

  const { rows } = await query<{ id: number }>(
    `INSERT INTO trip_plans
       (user_name, destination, trip_name, start_date, end_date, nights, itinerary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'planning')
     RETURNING id`,
    [
      userName,
      intent.destination,
      itinerary.tripName ?? null,
      startDate,
      endDate,
      nights,
      JSON.stringify(itinerary),
    ]
  );
  const id = rows[0]?.id ?? 0;
  logger.info({ id, destination: intent.destination, userName }, "[TripPlan] Saved to DB");
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
