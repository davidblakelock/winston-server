import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { geofenceCheck, getSavedPlaces, savePlaceForUser } from "../location/geofenceManager.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── POST /api/location/geofence-check ─────────────────────────────────────────
router.post("/location/geofence-check", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { lat, lng } = req.body as { lat?: unknown; lng?: unknown };

  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat and lng must be numbers" });
    return;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng out of valid range" });
    return;
  }

  try {
    const result = await geofenceCheck(userName, lat, lng);
    res.json(result);
  } catch (err) {
    logger.error({ err, userName }, "[Location] Geofence check failed");
    res.status(500).json({ error: "Geofence check failed" });
  }
});

// ── POST /api/location/save-place ─────────────────────────────────────────────
router.post("/location/save-place", express.json(), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { name, lat, lng, placeType, address } = req.body as {
    name?: unknown;
    lat?: unknown;
    lng?: unknown;
    placeType?: unknown;
    address?: unknown;
  };

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat and lng must be numbers" });
    return;
  }

  try {
    const place = await savePlaceForUser(
      userName,
      name.trim(),
      lat,
      lng,
      typeof placeType === "string" ? placeType : undefined,
      typeof address === "string" ? address : undefined
    );
    res.status(201).json({ place });
  } catch (err) {
    logger.error({ err, userName }, "[Location] Save place failed");
    res.status(500).json({ error: "Failed to save place" });
  }
});

// ── GET /api/location/saved-places ────────────────────────────────────────────
router.get("/location/saved-places", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const places = await getSavedPlaces(userName);
    res.json({ places });
  } catch (err) {
    logger.error({ err, userName }, "[Location] Get saved places failed");
    res.status(500).json({ error: "Failed to get saved places" });
  }
});

export default router;
