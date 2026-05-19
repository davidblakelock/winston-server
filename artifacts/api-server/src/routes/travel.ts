import { Router, type IRouter } from "express";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../auth/middleware.js";
import {
  getActiveTripPlans,
  getTripPlanById,
  saveTripPlan,
  updateTripPlan,
  deleteTripPlan,
  parseTripIntent,
  generateTripItinerary,
  buildTravelProfileContext,
  type TripItinerary,
} from "../travel/tripPlanningManager.js";
import { getProfile, type CollectedData } from "../onboarding/onboardingManager.js";
import { MODEL_SONNET } from "../lib/models.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const router: IRouter = Router();

// ── GET /api/trips ─────────────────────────────────────────────────────────────
// Returns all trip plans for the user sorted by start_date
router.get("/trips", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const plans = await getActiveTripPlans(userName);
    res.json({ plans });
  } catch (err) {
    req.log.error({ err }, "[Trips] GET /trips error");
    res.status(500).json({ error: "Failed to load trip plans" });
  }
});

// ── GET /api/trips/:id ─────────────────────────────────────────────────────────
// Returns a single trip plan with full itinerary
router.get("/trips/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid trip plan id" }); return; }

  try {
    const plan = await getTripPlanById(id, userName);
    if (!plan) { res.status(404).json({ error: "Trip plan not found" }); return; }
    res.json({ plan });
  } catch (err) {
    req.log.error({ err }, "[Trips] GET /trips/:id error");
    res.status(500).json({ error: "Failed to load trip plan" });
  }
});

// ── POST /api/trips/plan ───────────────────────────────────────────────────────
// Conversational travel advisor overview — no saving, no parsing.
// Body: { description: string }
// Returns: { response: string }
router.post("/trips/plan", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { description } = req.body as { description?: string };
  if (!description || description.trim().length < 3) {
    res.status(400).json({ error: "description is required" });
    return;
  }

  try {
    // Pull profile for personalization
    const profile = await getProfile(userName);
    const rawData = (profile?.rawData ?? {}) as CollectedData;
    const profileCtx = buildTravelProfileContext(rawData, profile);

    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Chicago",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const systemPrompt = `You are a deeply knowledgeable, opinionated travel advisor — the kind of friend who has been everywhere, remembers exactly what made each place worth it, and gives you the real answer instead of a generic guidebook list.

Today is ${today}.${profileCtx}

When someone asks about a trip, you:
1. Open with a vivid, honest take on the destination — what makes it genuinely worth going, what the vibe is, what kind of traveler it suits
2. Walk through the essential stops and neighborhoods — specific places, not categories
3. Recommend where to stay — real properties with a brief reason each fits this traveler, and a direct booking link for each hotel
4. Cover what to do — a mix of the can't-miss and the off-the-beaten-path, matched to who they are; include each attraction's official website link
5. Highlight where to eat — real restaurants with cuisine and a one-line reason they fit; favor places with real character over hotel restaurants; include a reservation link for each restaurant
6. Close naturally with 2–3 specific options for how they might want to go deeper: "Want me to sketch out a day-by-day itinerary?", "Want me to zero in on the food and nightlife?", "Want me to look at what's realistic for that number of nights?" — give actual useful options, not generic ones

BOOKING LINKS — include these for every hotel, restaurant, and major attraction you mention:
- Hotels: link directly to the hotel's own website OR their Booking.com page — use format [Hotel Name](https://...) inline after the hotel name
- Restaurants: link to their OpenTable page (https://www.opentable.com/r/restaurant-name-city) or Resy page (https://resy.com/cities/CITY/restaurant-name) if you know it; otherwise link the restaurant's own website — use format [Reserve on OpenTable](https://...) or [Reserve on Resy](https://...) or [Website](https://...)
- Attractions & activities: link to the official website — use format [Official Site](https://...) inline
- Only include links you are confident are real and correct. If you're not sure of the exact URL, omit the link rather than guess.
- Format all links as Markdown: [Link Text](https://url) — these will be rendered as tappable links in the mobile app

Personalization rules (read the traveler profile above):
- Match restaurant suggestions to stated food preferences and dining style
- Match activities to stated interests — active vs. cultural, intensity level
- If they're traveling with someone, make recommendations feel like they're designed for two, not solo tourism
- Reference interests naturally: "knowing you're into live music, this is the stretch of the city you want"
- Respect any health or dietary notes in food suggestions

Tone: conversational, specific, confident. No bullet walls unless listing restaurants or hotels. Write like you're talking to a friend, not filing a report. No "Great question!" or filler preamble — just start with something real.`;

    req.log.info({ userName, descLen: description.length }, "[TripPlan] /trips/plan conversational overview");

    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: description.trim() }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    req.log.info({ userName, outputLen: text.length }, "[TripPlan] /trips/plan response ready");

    res.json({ response: text });
  } catch (err) {
    req.log.error({ err }, "[TripPlan] POST /trips/plan error");
    res.status(500).json({ error: "Failed to generate travel overview" });
  }
});

// ── POST /api/trips/save ───────────────────────────────────────────────────────
// Converts a conversational /trips/plan response into a structured itinerary
// and saves it to trip_plans.
// Body: { planResponse: string, description?: string, destination?: string, nights?: number, startDate?: string }
// Returns: { id, destination, tripName, nights, startDate, endDate, status }
router.post("/trips/save", express.json({ limit: "2mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const body = req.body as {
    planResponse?: string;
    description?: string;
    destination?: string;
    nights?: number;
    startDate?: string;
  };

  if (!body.planResponse || body.planResponse.trim().length < 20) {
    res.status(400).json({ error: "planResponse is required" });
    return;
  }

  try {
    const profile = await getProfile(userName);
    const rawData = (profile?.rawData ?? {}) as CollectedData;
    const profileCtx = buildTravelProfileContext(rawData, profile);

    // Parse intent from the original user description (or fall back to destination hint)
    const intentSource = body.description ?? body.destination ?? body.planResponse.slice(0, 200);
    const intent = parseTripIntent(intentSource);
    if (body.destination) intent.destination = body.destination;
    if (body.nights) intent.nights = body.nights;
    if (body.startDate) intent.startDate = body.startDate;

    const nights = intent.nights ?? 3;
    const dest = intent.destination || "the destination mentioned in the overview";
    const party = intent.partyDesc ?? "couple";

    req.log.info({ userName, dest, nights }, "[TripPlan] /trips/save — extracting itinerary from plan text");

    const extractionPrompt = `You are converting a conversational travel advisor overview into a structured day-by-day itinerary.

ORIGINAL OVERVIEW:
${body.planResponse}

TRIP CONTEXT:
- Destination: ${dest}
- Duration: ${nights} nights (${nights + 1} days)
- Traveling with: ${party}
${intent.startDate ? `- Start date: ${intent.startDate}` : ""}
${profileCtx}

Extract or infer a complete day-by-day itinerary from the overview above. Where the overview is specific, use exactly those recommendations. Where it is general, infer the most fitting specific options based on the destination, vibe, and traveler profile.

For booking links:
- Restaurants: include real OpenTable (https://www.opentable.com/r/...) or Resy (https://resy.com/cities/.../...) links where you know them; otherwise the restaurant website
- Hotels: include the hotel's direct website or Booking.com page
- Leave null if genuinely unknown — do not guess URLs

Return ONLY valid JSON — no markdown, no explanation:
{
  "tripName": "Short evocative name e.g. 'Savannah for Two' or 'Hill Country Long Weekend'",
  "destination": "${dest}",
  "nights": ${nights},
  "partyDesc": "${party}",
  "summary": "One vivid sentence capturing the spirit of this trip",
  "generalTips": ["Tip 1", "Tip 2", "Tip 3"],
  "days": [
    {
      "day": 1,
      "title": "Short evocative day title",
      "morning": "Morning plan — specific places and activities",
      "afternoon": "Afternoon plan — specific places",
      "evening": "Evening plan — neighborhood or activity",
      "restaurant": {
        "name": "Restaurant name",
        "cuisine": "Cuisine type and style",
        "whyItFits": "One sentence why this fits the traveler",
        "bookingUrl": "OpenTable or Resy URL, or null",
        "websiteUrl": "Restaurant website, or null",
        "phone": null
      },
      "hotel": {
        "name": "Hotel name",
        "whyItFits": "One sentence why this hotel fits",
        "websiteUrl": "Hotel website URL, or null",
        "priceRange": "$$, $$$, or $$$$"
      },
      "practicalNotes": "Timing, reservations needed, transport, or insider tips"
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8000,
      messages: [{ role: "user", content: extractionPrompt }],
    });

    const rawText = message.content[0].type === "text" ? message.content[0].text : "";
    const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      req.log.error({ rawText: rawText.slice(0, 500) }, "[TripPlan] /trips/save — no JSON in Claude response");
      res.status(500).json({ error: "Failed to extract itinerary structure from plan" });
      return;
    }

    const itinerary = JSON.parse(jsonMatch[0]) as TripItinerary;

    const id = await saveTripPlan(userName, intent, itinerary);
    const plan = await getTripPlanById(id, userName);

    req.log.info(
      { id, destination: itinerary.destination, tripName: itinerary.tripName, nights: itinerary.nights },
      "[TripPlan] /trips/save — saved"
    );

    res.status(201).json({
      id,
      destination: plan?.destination ?? itinerary.destination,
      tripName: plan?.trip_name ?? itinerary.tripName,
      nights: plan?.nights ?? itinerary.nights,
      startDate: plan?.start_date ?? null,
      endDate: plan?.end_date ?? null,
      status: plan?.status ?? "planning",
    });
  } catch (err) {
    req.log.error({ err }, "[TripPlan] POST /trips/save error");
    res.status(500).json({ error: "Failed to save trip plan" });
  }
});

// ── POST /api/trips ────────────────────────────────────────────────────────────
// Creates a new trip plan (with or without itinerary)
// Body: { message?: string, destination?: string, nights?: number, itinerary?: TripItinerary, ... }
router.post("/trips", express.json({ limit: "2mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const body = req.body as {
    message?: string;
    destination?: string;
    nights?: number;
    startDate?: string;
    endDate?: string;
    partyDesc?: string;
    vibe?: string;
    mustHaves?: string;
    budget?: string;
    itinerary?: TripItinerary;
    status?: string;
  };

  try {
    // If a complete itinerary is provided, save directly
    if (body.itinerary) {
      const intent = parseTripIntent(body.message ?? body.destination ?? body.itinerary.destination);
      if (body.destination) intent.destination = body.destination;
      if (body.nights) intent.nights = body.nights;
      if (body.startDate) intent.startDate = body.startDate;
      if (body.partyDesc) intent.partyDesc = body.partyDesc;
      if (body.vibe) intent.vibe = body.vibe;

      const id = await saveTripPlan(userName, intent, body.itinerary);
      const plan = await getTripPlanById(id, userName);
      req.log.info({ id, destination: intent.destination }, "[Trips] Trip plan saved with provided itinerary");
      res.status(201).json({ plan });
      return;
    }

    // Otherwise generate a new itinerary from the provided details
    const rawMsg = body.message ?? body.destination ?? "";
    const intent = parseTripIntent(rawMsg);
    if (body.destination) intent.destination = body.destination;
    if (body.nights) intent.nights = body.nights;
    if (body.startDate) intent.startDate = body.startDate;
    if (body.endDate) intent.endDate = body.endDate;
    if (body.partyDesc) intent.partyDesc = body.partyDesc;
    if (body.vibe) intent.vibe = body.vibe;
    if (body.mustHaves) intent.mustHaves = body.mustHaves;
    if (body.budget) intent.budget = body.budget;

    if (!intent.destination) {
      res.status(400).json({ error: "destination is required" });
      return;
    }

    req.log.info({ destination: intent.destination, nights: intent.nights }, "[Trips] Generating itinerary");
    const itinerary = await generateTripItinerary(intent, null);
    const id = await saveTripPlan(userName, intent, itinerary);
    const plan = await getTripPlanById(id, userName);
    res.status(201).json({ plan });
  } catch (err) {
    req.log.error({ err }, "[Trips] POST /trips error");
    res.status(500).json({ error: "Failed to create trip plan" });
  }
});

// ── PUT /api/trips/:id ─────────────────────────────────────────────────────────
// Updates a trip plan (partial update)
router.put("/trips/:id", express.json({ limit: "2mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid trip plan id" }); return; }

  const body = req.body as {
    trip_name?: string;
    destination?: string;
    start_date?: string;
    end_date?: string;
    nights?: number;
    itinerary?: TripItinerary;
    status?: string;
  };

  try {
    const updated = await updateTripPlan(id, userName, body);
    if (!updated) { res.status(404).json({ error: "Trip plan not found" }); return; }
    req.log.info({ id, userName }, "[Trips] Trip plan updated");
    res.json({ plan: updated });
  } catch (err) {
    req.log.error({ err }, "[Trips] PUT /trips/:id error");
    res.status(500).json({ error: "Failed to update trip plan" });
  }
});

// ── DELETE /api/trips/:id ──────────────────────────────────────────────────────
// Removes a trip plan
router.delete("/trips/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid trip plan id" }); return; }

  try {
    const deleted = await deleteTripPlan(id, userName);
    if (!deleted) { res.status(404).json({ error: "Trip plan not found" }); return; }
    req.log.info({ id, userName }, "[Trips] Trip plan deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Trips] DELETE /trips/:id error");
    res.status(500).json({ error: "Failed to delete trip plan" });
  }
});

export default router;
