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
  enrichItineraryWithHotelAvailability,
  buildTravelProfileContext,
  type NativeTripPlan,
  type ParsedTripIntent,
} from "../travel/tripPlanningManager.js";
import {
  checkHotelAvailability,
  isBookingAvailabilityReady,
} from "../travel/hotelAvailability.js";
import { getProfile } from "../onboarding/onboardingManager.js";
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
    const profileCtx = buildTravelProfileContext(profile);

    // Parse intent from the original user description (or fall back to destination hint)
    const intentSource = body.description ?? body.destination ?? body.planResponse.slice(0, 200);
    const intent = await parseTripIntent(intentSource);
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

Extract or infer a complete day-by-day itinerary. Where the overview is specific, use those recommendations exactly. Where general, infer the best specific options for the destination, vibe, and traveler.

Return ONLY valid JSON — no markdown, no explanation:
{
  "trip_name": "Creative evocative name (not just '${dest} Trip')",
  "destination": "${dest}",
  "nights": ${nights},
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "itinerary": {
    "days": [
      {
        "dayNumber": 1,
        "label": "Evocative day title",
        "location": "City or neighborhood",
        "hotel": {
          "name": "Real hotel name",
          "websiteUrl": "Hotel direct website URL",
          "notes": "Why this hotel fits this traveler and vibe"
        },
        "activities": [
          { "time": "Morning",   "title": "Activity", "description": "Specific plan", "notes": "Practical tip" },
          { "time": "Afternoon", "title": "Activity", "description": "Specific plan", "notes": "Practical tip" },
          { "time": "Evening",   "title": "Activity", "description": "Specific plan", "notes": "Practical tip" }
        ],
        "meals": [
          { "time": "Lunch",  "title": "Restaurant name", "description": "Cuisine and why it fits", "bookingUrl": "OpenTable/Resy/website URL or empty string" },
          { "time": "Dinner", "title": "Restaurant name", "description": "Cuisine and why it fits", "bookingUrl": "URL or empty string" }
        ]
      }
    ],
    "practicalNotes": ["Tip 1", "Tip 2", "Tip 3", "Tip 4"]
  }
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

    const nativePlan = JSON.parse(jsonMatch[0]) as NativeTripPlan;

    // Enrich with hotel pricing before saving
    const saveIntent: ParsedTripIntent = {
      destination: nativePlan.destination,
      nights: nativePlan.nights ?? body.nights,
      startDate: nativePlan.start_date ?? body.startDate,
      partySize: 2,
      rawMessage: body.description ?? body.destination ?? "",
    };
    await enrichItineraryWithHotelAvailability(nativePlan, saveIntent).catch((err: unknown) =>
      req.log.warn({ err }, "[TripPlan] /trips/save — hotel enrichment failed, saving without pricing")
    );

    const id = await saveTripPlan(userName, nativePlan);
    const plan = await getTripPlanById(id, userName);

    req.log.info(
      { id, destination: nativePlan.destination, tripName: nativePlan.trip_name, nights: nativePlan.nights },
      "[TripPlan] /trips/save — saved"
    );

    res.status(201).json({
      id,
      destination: plan?.destination ?? nativePlan.destination,
      tripName: plan?.trip_name ?? nativePlan.trip_name,
      nights: plan?.nights ?? nativePlan.nights,
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
    itinerary?: NativeTripPlan;
    status?: string;
  };

  try {
    // If a complete NativeTripPlan is provided, save directly
    if (body.itinerary) {
      const id = await saveTripPlan(userName, body.itinerary);
      const plan = await getTripPlanById(id, userName);
      req.log.info({ id, destination: body.itinerary.destination }, "[Trips] Trip plan saved with provided itinerary");
      res.status(201).json({ plan });
      return;
    }

    // Otherwise generate a new itinerary from the provided details
    const rawMsg = body.message ?? body.destination ?? "";
    const intent = await parseTripIntent(rawMsg);
    if (body.destination) intent.destination = body.destination;
    if (body.nights) intent.nights = body.nights;
    if (body.startDate) intent.startDate = body.startDate;
    if (body.partyDesc) intent.partyDesc = body.partyDesc;
    if (body.vibe) intent.vibe = body.vibe;
    if (body.mustHaves) intent.mustHaves = body.mustHaves;
    if (body.budget) intent.budget = body.budget;

    if (!intent.destination) {
      res.status(400).json({ error: "destination is required" });
      return;
    }

    req.log.info({ destination: intent.destination, nights: intent.nights }, "[Trips] Generating itinerary");
    const generatedPlan = await generateTripItinerary(intent, null);

    // Enrich with hotel pricing before saving — mutates hotel objects in-place
    await enrichItineraryWithHotelAvailability(generatedPlan, intent).catch((err: unknown) =>
      req.log.warn({ err }, "[Trips] Hotel enrichment failed — saving without pricing")
    );

    const id = await saveTripPlan(userName, generatedPlan);
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
    itinerary?: NativeTripPlan["itinerary"];
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

// ── POST /api/hotels/check-availability ───────────────────────────────────────
// Direct hotel availability check via Booking.com (Apify).
// Body: { destination, checkIn, checkOut, hotelName?, adults? }
// Returns: { queried, specific, namedHotelNotFound, alternatives, totalFound, ready }
router.post("/hotels/check-availability", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const body = req.body as {
    destination?: string;
    checkIn?: string;
    checkOut?: string;
    hotelName?: string;
    adults?: number;
  };

  if (!body.destination || !body.checkIn || !body.checkOut) {
    res.status(400).json({ error: "destination, checkIn, and checkOut are required" });
    return;
  }

  // Validate date format
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(body.checkIn) || !dateRe.test(body.checkOut)) {
    res.status(400).json({ error: "checkIn and checkOut must be YYYY-MM-DD" });
    return;
  }

  if (!isBookingAvailabilityReady()) {
    res.status(503).json({
      error: "Hotel availability checker is not configured (APIFY_API_KEY missing)",
      ready: false,
    });
    return;
  }

  try {
    req.log.info(
      { destination: body.destination, checkIn: body.checkIn, checkOut: body.checkOut, hotelName: body.hotelName },
      "[HotelAvail] POST /hotels/check-availability"
    );

    const result = await checkHotelAvailability({
      destination: body.destination,
      checkIn:     body.checkIn,
      checkOut:    body.checkOut,
      hotelName:   body.hotelName,
      adults:      body.adults ?? 2,
    });

    req.log.info(
      { totalFound: result.totalFound, foundSpecific: !!result.specific, namedNotFound: result.namedHotelNotFound },
      "[HotelAvail] Check complete"
    );

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "[HotelAvail] POST /hotels/check-availability error");
    res.status(500).json({ error: "Hotel availability check failed" });
  }
});

// ── POST /api/trips/:id/enrich ─────────────────────────────────────────────────
// Re-runs hotel enrichment (SerpAPI pricing + Places URLs) on an existing trip.
// Call this for trips saved before enrichment was wired up, or to refresh pricing.
router.post("/trips/:id/enrich", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid trip plan id" }); return; }

  try {
    const row = await getTripPlanById(id, userName);
    if (!row) { res.status(404).json({ error: "Trip plan not found" }); return; }
    if (!row.itinerary) { res.status(400).json({ error: "Trip has no itinerary to enrich" }); return; }

    // Reconstruct a NativeTripPlan shape that enrichment expects
    const nativePlan: NativeTripPlan = {
      trip_name:  row.trip_name ?? row.destination,
      destination: row.destination,
      nights:      row.nights ?? 3,
      start_date:  row.start_date ?? null,
      end_date:    row.end_date ?? null,
      status:      "planning",
      itinerary:   row.itinerary as NativeTripPlan["itinerary"],
    };

    const intent: ParsedTripIntent = {
      destination: row.destination,
      nights:      row.nights ?? 3,
      startDate:   row.start_date ?? undefined,
      partySize:   2,
      rawMessage:  row.destination,
    };

    req.log.info({ id, destination: row.destination }, "[Trips] Re-enriching hotel data");
    await enrichItineraryWithHotelAvailability(nativePlan, intent);

    // Persist the enriched itinerary back to the DB
    const updated = await updateTripPlan(id, userName, { itinerary: nativePlan.itinerary as never });
    req.log.info({ id }, "[Trips] Enrichment complete — itinerary saved");
    res.json({ ok: true, plan: updated });
  } catch (err) {
    req.log.error({ err }, "[Trips] POST /trips/:id/enrich error");
    res.status(500).json({ error: "Hotel enrichment failed" });
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
