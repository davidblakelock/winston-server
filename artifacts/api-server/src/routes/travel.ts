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
3. Recommend where to stay — real properties, with a brief reason each fits this traveler
4. Cover what to do — a mix of the can't-miss and the off-the-beaten-path, matched to who they are
5. Highlight where to eat — real restaurants with cuisine and a one-line reason they fit; favor places with real character over hotel restaurants
6. Close naturally with 2–3 specific options for how they might want to go deeper: "Want me to sketch out a day-by-day itinerary?", "Want me to zero in on the food and nightlife?", "Want me to look at what's realistic for that number of nights?" — give actual useful options, not generic ones

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
