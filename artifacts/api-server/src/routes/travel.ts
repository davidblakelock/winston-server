import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getActiveTripPlans,
  getTripPlanById,
  saveTripPlan,
  updateTripPlan,
  deleteTripPlan,
  parseTripIntent,
  generateTripItinerary,
  type TripItinerary,
} from "../travel/tripPlanningManager.js";
import { logger } from "../lib/logger.js";

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
