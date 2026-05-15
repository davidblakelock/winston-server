import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getUpcomingTravel,
  upsertTravelSegment,
  deleteTravelSegment,
} from "../travel/travelManager.js";
import { getActiveTripPlans } from "../travel/tripPlanningManager.js";
import { scanTravelEmails } from "../travel/travelScanner.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── Sync state (in-memory — resets on restart, good enough for single user) ───
const _lastSyncAt = new Map<string, Date>();

// ── GET /api/travel ───────────────────────────────────────────────────────────
// Returns all upcoming travel segments sorted by departure date.
router.get("/travel", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const segments = await getUpcomingTravel(userName);
    res.json({ segments, lastSyncAt: _lastSyncAt.get(userName)?.toISOString() ?? null });
  } catch (err) {
    req.log.error({ err }, "[Travel] GET /travel error");
    res.status(500).json({ error: "Failed to load travel" });
  }
});

// ── POST /api/travel/sync ─────────────────────────────────────────────────────
// Scans Gmail for travel confirmations (last 180 days on first run).
// Body: { force?: boolean } — set true to ignore the 30-min throttle
router.post("/travel/sync", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const force = Boolean((req.body as { force?: boolean })?.force);
  const lastSync = _lastSyncAt.get(userName);
  const THROTTLE_MS = 30 * 60 * 1000;

  if (!force && lastSync && Date.now() - lastSync.getTime() < THROTTLE_MS) {
    const segments = await getUpcomingTravel(userName);
    res.json({ ok: true, newSegments: 0, segments, throttled: true });
    return;
  }

  req.log.info({ userName }, "[Travel] Sync started");

  try {
    const scanned = await scanTravelEmails(userName, lastSync ?? undefined);
    let newCount = 0;

    for (const seg of scanned) {
      const inserted = await upsertTravelSegment(userName, seg);
      if (inserted) newCount++;
    }

    _lastSyncAt.set(userName, new Date());
    req.log.info({ userName, scanned: scanned.length, newCount }, "[Travel] Sync complete");

    const segments = await getUpcomingTravel(userName);
    res.json({ ok: true, newSegments: newCount, segments, throttled: false });
  } catch (err) {
    req.log.error({ err }, "[Travel] POST /travel/sync error");
    res.status(500).json({ error: "Travel sync failed" });
  }
});

// ── DELETE /api/travel/:id ────────────────────────────────────────────────────
router.delete("/travel/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid travel segment id" });
    return;
  }

  try {
    const deleted = await deleteTravelSegment(id, userName);
    if (!deleted) {
      res.status(404).json({ error: "Travel segment not found" });
      return;
    }
    req.log.info({ userName, id }, "[Travel] Segment deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[Travel] DELETE error");
    res.status(500).json({ error: "Failed to delete segment" });
  }
});

// ── GET /api/trips ────────────────────────────────────────────────────────────
// Returns all saved trip plans for the authenticated user.
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

export default router;
