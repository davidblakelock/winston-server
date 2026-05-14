/**
 * Trip Planning Manager
 *
 * Handles the conversational trip planning flow:
 *   1. User expresses intent → server asks up to 4 questions
 *   2. Generates full day-by-day itinerary with Claude Sonnet
 *   3. Stores in trip_plans table
 *   4. Surfaces today's itinerary day in the morning briefing
 *
 * Pending state is in-memory (same pattern as other conversational flows).
 */

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Pending conversation state ────────────────────────────────────────────────

export type TripPlanPhase = "nights" | "vibe" | "must_haves" | "been_before" | "generating";

export interface PendingTripPlan {
  destination: string;
  phase:       TripPlanPhase;
  nights?:     number;
  vibe?:       string;
  mustHaves?:  string;
  beenBefore?: boolean;
}

let _pendingTripPlan: PendingTripPlan | null = null;

export function getPendingTripPlan(): PendingTripPlan | null { return _pendingTripPlan; }
export function setPendingTripPlan(p: PendingTripPlan | null): void { _pendingTripPlan = p; }

// ── Itinerary types ───────────────────────────────────────────────────────────

export interface ItineraryDay {
  day:               number;
  title:             string;
  morning:           string;
  afternoon:         string;
  evening:           string;
  restaurant:        string;
  restaurantUrl?:    string;
  specialExperience: string;
  practicalNotes:    string;
}

export interface TripItinerary {
  destination: string;
  nights:      number;
  summary:     string;
  generalTips: string[];
  days:        ItineraryDay[];
}

// ── DB setup ──────────────────────────────────────────────────────────────────

export async function ensureTripPlansTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS trip_plans (
        id           SERIAL PRIMARY KEY,
        user_name    TEXT NOT NULL DEFAULT '${NATIVE_USER}',
        destination  TEXT NOT NULL,
        start_date   DATE,
        nights       INTEGER,
        vibe         TEXT,
        must_haves   TEXT,
        been_before  BOOLEAN,
        itinerary    TEXT,
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info("[TripPlan] trip_plans table ready");
  } catch (err) {
    logger.warn({ err }, "[TripPlan] Table creation warning");
  }
}

// ── Itinerary generation ──────────────────────────────────────────────────────

export async function generateTripItinerary(
  plan:        PendingTripPlan,
  userProfile: Record<string, unknown> | null,
): Promise<TripItinerary> {
  const rawData   = (userProfile?.rawData as Record<string, unknown>) ?? {};
  const interests = (rawData.interests as string[] | undefined)?.join(", ")   ?? "good food, culture, exploration";
  const favRestaurants = (rawData.restaurants as string[] | undefined)?.slice(0, 5).join(", ") ?? "";
  const dietaryRestrictions = (rawData.dietaryRestrictions as string[] | undefined)?.join(", ") ?? "";

  const nights      = plan.nights ?? 3;
  const vibe        = plan.vibe ?? "mix of relaxed and adventurous";
  const mustHaves   = plan.mustHaves || "None specified";
  const beenBefore  = plan.beenBefore ? "Yes — focus on beyond-the-tourist experiences" : "No — include iconic highlights alongside hidden gems";
  const destination = plan.destination;

  const prompt =
    `You are creating a personal travel itinerary for a trip to ${destination}.\n\n` +
    `TRIP DETAILS:\n` +
    `• Destination: ${destination}\n` +
    `• Duration: ${nights} nights (${nights + 1} days)\n` +
    `• Vibe: ${vibe}\n` +
    `• Must-haves: ${mustHaves}\n` +
    `• Been there before: ${beenBefore}\n` +
    `• Traveler interests: ${interests}\n` +
    (favRestaurants ? `• Favorite restaurant style at home: ${favRestaurants}\n` : "") +
    (dietaryRestrictions ? `• Dietary restrictions: ${dietaryRestrictions}\n` : "") +
    `\nGenerate a complete, specific, day-by-day itinerary using REAL place names.\n\n` +
    `RULES:\n` +
    `• Restaurants must be real, named establishments with brief notes on what they're known for\n` +
    `• Activities must be specific — actual neighborhoods, markets, museums, trails (not generic "explore the city")\n` +
    `• One special/memorable experience per day — something that makes this day stand out\n` +
    `• Practical notes should be genuinely useful: timing, reservations, transport between places\n` +
    `• If vibe is "relaxed" — avoid back-to-back obligations; leave breathing room\n` +
    `• If vibe is "adventurous" — pack the days with interesting experiences\n` +
    `• Day 1 accounts for travel/arrival; don't over-schedule it\n` +
    `• Last day accounts for checkout/departure\n\n` +
    `Return ONLY valid JSON (no markdown, no explanation) with this exact structure:\n` +
    `{\n` +
    `  "destination": "${destination}",\n` +
    `  "nights": ${nights},\n` +
    `  "summary": "One sentence capturing the spirit of this trip",\n` +
    `  "generalTips": ["tip1", "tip2", "tip3", "tip4"],\n` +
    `  "days": [\n` +
    `    {\n` +
    `      "day": 1,\n` +
    `      "title": "Short evocative title for the day",\n` +
    `      "morning": "What to do in the morning (specific places/activities)",\n` +
    `      "afternoon": "What to do in the afternoon",\n` +
    `      "evening": "Evening plan / area to be in",\n` +
    `      "restaurant": "Restaurant name — what it's known for, price range ($ $$ $$$ $$$$)",\n` +
    `      "specialExperience": "The one unforgettable thing about this day",\n` +
    `      "practicalNotes": "Timing, reservations, transport, or insider tips"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 4000,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("").trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("[TripPlan] No JSON found in Claude response");

  const itinerary = JSON.parse(jsonMatch[0]) as TripItinerary;
  logger.info({ destination, nights, days: itinerary.days?.length }, "[TripPlan] Itinerary generated");
  return itinerary;
}

// ── DB persistence ────────────────────────────────────────────────────────────

export async function saveTripPlan(
  userName:  string,
  plan:      PendingTripPlan,
  itinerary: TripItinerary,
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO trip_plans
       (user_name, destination, nights, vibe, must_haves, been_before, itinerary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     RETURNING id`,
    [
      userName,
      plan.destination,
      plan.nights ?? null,
      plan.vibe ?? null,
      plan.mustHaves ?? null,
      plan.beenBefore ?? null,
      JSON.stringify(itinerary),
    ]
  );
  const id = rows[0]?.id ?? 0;
  logger.info({ id, destination: plan.destination, userName }, "[TripPlan] Saved to DB");
  return id;
}

export async function getActiveTripPlans(userName = NATIVE_USER): Promise<Array<{
  id: number; destination: string; nights: number | null; start_date: string | null; itinerary: string | null;
}>> {
  const { rows } = await query(
    `SELECT id, destination, nights, start_date, itinerary
     FROM trip_plans
     WHERE user_name = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [userName]
  );
  return rows as Array<{ id: number; destination: string; nights: number | null; start_date: string | null; itinerary: string | null }>;
}

// ── Today's travel day detection ──────────────────────────────────────────────

export interface TodayTripDay {
  planId:      number;
  destination: string;
  dayNumber:   number;
  day:         ItineraryDay;
  itinerary:   TripItinerary;
}

/**
 * Returns today's itinerary day if the user has an active trip plan
 * whose start_date falls such that today is one of the travel days.
 * Falls back to using created_at as the start date if start_date is null.
 */
export async function getTodayTripDay(userName = NATIVE_USER): Promise<TodayTripDay | null> {
  const plans = await getActiveTripPlans(userName).catch(() => []);
  if (!plans.length) return null;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  for (const plan of plans) {
    if (!plan.itinerary) continue;
    let itinerary: TripItinerary;
    try { itinerary = JSON.parse(plan.itinerary) as TripItinerary; }
    catch { continue; }

    const nights = plan.nights ?? itinerary.nights ?? 3;
    const startStr = plan.start_date ?? null;
    if (!startStr) continue;

    const startDate = new Date(startStr + "T00:00:00");
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

  return (
    `\n\n[Trip Day — ${destination}: Day ${dayNumber} of ${totalDays}]\n` +
    `Today's title: ${day.title}\n` +
    `Morning: ${day.morning}\n` +
    `Afternoon: ${day.afternoon}\n` +
    `Evening: ${day.evening}\n` +
    `Tonight's restaurant: ${day.restaurant}\n` +
    `Special experience: ${day.specialExperience}\n` +
    `Practical notes: ${day.practicalNotes}\n\n` +
    `Surface this warmly near the start of the briefing — they are traveling today. ` +
    `Give the day a sense of excitement and anticipation. Lead with the special experience.`
  );
}
