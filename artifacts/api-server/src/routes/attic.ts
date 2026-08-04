import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import {
  listAtticItems,
  archiveAtticItems,
  deleteAtticItems,
  type AtticSourceType,
} from "../attic/atticItemsManager.js";
import {
  listObservationsForUser,
  updateObservationStatus,
  type Observation,
} from "../connectionEngine/connectionEngineManager.js";

const ATTIC_SOURCE_TYPES: AtticSourceType[] = [
  "voice", "text", "email_forward", "url",
  "screenshot", "article", "social_snippet", "manual_entry",
];

const OBSERVATION_STATUSES: Observation["status"][] = ["pending", "shown", "dismissed", "accepted", "suppressed"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const router = Router();

// ── GET /api/attic ──────────────────────────────────────────────────────────
// Lists attic items for the browsing screen. Query params (all optional):
//   sourceType  — one of ATTIC_SOURCE_TYPES, exact match
//   startDate   — 'YYYY-MM-DD', inclusive
//   endDate     — 'YYYY-MM-DD', inclusive (day is included in full)
//   goalId      — only items connected to this goal via `connections`
//   limit       — default 200, max 500
// Returns: { items: AtticItem[] }
router.get("/attic", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { sourceType, startDate, endDate, goalId, limit } = req.query as {
    sourceType?: string;
    startDate?:  string;
    endDate?:    string;
    goalId?:     string;
    limit?:      string;
  };

  if (sourceType && !ATTIC_SOURCE_TYPES.includes(sourceType as AtticSourceType)) {
    res.status(400).json({ error: `sourceType must be one of: ${ATTIC_SOURCE_TYPES.join(", ")}` });
    return;
  }
  if (startDate && !DATE_RE.test(startDate)) {
    res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
    return;
  }
  if (endDate && !DATE_RE.test(endDate)) {
    res.status(400).json({ error: "endDate must be YYYY-MM-DD" });
    return;
  }
  let parsedGoalId: number | undefined;
  if (goalId !== undefined) {
    parsedGoalId = parseInt(goalId, 10);
    if (isNaN(parsedGoalId)) {
      res.status(400).json({ error: "goalId must be a number" });
      return;
    }
  }
  let parsedLimit: number | undefined;
  if (limit !== undefined) {
    parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      res.status(400).json({ error: "limit must be a positive number" });
      return;
    }
    parsedLimit = Math.min(parsedLimit, 500);
  }

  try {
    const items = await listAtticItems(userName, {
      sourceType: sourceType as AtticSourceType | undefined,
      startDate,
      endDate,
      goalId: parsedGoalId,
      limit: parsedLimit,
    });
    req.log.info(
      { count: items.length, sourceType, startDate, endDate, goalId: parsedGoalId },
      "[Attic] GET /attic"
    );
    res.json({ items });
  } catch (err) {
    req.log.error({ err }, "[Attic] GET /attic error");
    res.status(500).json({ error: "Failed to fetch attic items" });
  }
});

// ── GET /api/attic/observations ──────────────────────────────────────────────
// "What Winston has noticed" — pending/shown observations, enriched with the
// linked connection (and goal title, if any). Query params (all optional):
//   status — comma-separated subset of pending|shown|dismissed|accepted,
//            default "pending,shown"
//   limit  — default 50
// Must be declared before any /attic/:id-shaped route to avoid param capture
// (there isn't one today, but keep this route first if one is ever added).
// Returns: { observations: ObservationWithConnection[] }
router.get("/attic/observations", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { status, limit } = req.query as { status?: string; limit?: string };

  let statuses: Observation["status"][] = ["pending", "shown"];
  if (status) {
    const requested = status.split(",").map((s) => s.trim());
    const invalid = requested.filter((s) => !OBSERVATION_STATUSES.includes(s as Observation["status"]));
    if (invalid.length > 0) {
      res.status(400).json({ error: `status must be one of: ${OBSERVATION_STATUSES.join(", ")}` });
      return;
    }
    statuses = requested as Observation["status"][];
  }

  let parsedLimit: number | undefined;
  if (limit !== undefined) {
    parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      res.status(400).json({ error: "limit must be a positive number" });
      return;
    }
  }

  try {
    const observations = await listObservationsForUser(userName, statuses, parsedLimit);
    req.log.info({ count: observations.length, statuses }, "[Attic] GET /attic/observations");
    res.json({ observations });
  } catch (err) {
    req.log.error({ err }, "[Attic] GET /attic/observations error");
    res.status(500).json({ error: "Failed to fetch observations" });
  }
});

// ── PATCH /api/attic/observations/:id ────────────────────────────────────────
// Marks an observation reviewed. Body: { status: 'shown'|'dismissed'|'accepted' }
// Cascades to the linked connection (if any) the same way the voice
// correction flow does. Scoped to the authenticated user — an id belonging to
// another user resolves to 404, not a silent no-op leak.
router.patch("/attic/observations/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const observationId = parseInt(req.params.id, 10);
  if (isNaN(observationId)) {
    res.status(400).json({ error: "Invalid observation id" });
    return;
  }
  const { status } = req.body as { status?: string };
  const settableStatuses: Observation["status"][] = ["shown", "dismissed", "accepted"];
  if (!settableStatuses.includes(status as Observation["status"])) {
    res.status(400).json({ error: `status must be one of: ${settableStatuses.join(", ")}` });
    return;
  }
  try {
    const updated = await updateObservationStatus(observationId, userName, status as Observation["status"]);
    if (!updated) {
      res.status(404).json({ error: "Observation not found" });
      return;
    }
    req.log.info({ observationId, status }, "[Attic] Observation status updated");
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "[Attic] PATCH /attic/observations/:id error");
    res.status(500).json({ error: "Failed to update observation" });
  }
});

// ── POST /api/attic/archive ──────────────────────────────────────────────────
// Direct archive-by-ids for the browsing screen's own multi-select — no
// pending-confirmation state involved (that map is exclusively the chat
// flow's concern; this route never reads or writes it).
// Body: { ids: number[] }
// Returns: { ok: true, archived: <count> }
router.post("/attic/archive", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "number")) {
    res.status(400).json({ error: "ids must be a non-empty array of numbers" });
    return;
  }
  try {
    const archived = await archiveAtticItems(userName, ids);
    req.log.info({ requested: ids.length, archived }, "[Attic] POST /attic/archive");
    res.json({ ok: true, archived });
  } catch (err) {
    req.log.error({ err }, "[Attic] POST /attic/archive error");
    res.status(500).json({ error: "Failed to archive items" });
  }
});

// ── DELETE /api/attic ────────────────────────────────────────────────────────
// Direct delete-by-ids for the browsing screen's own multi-select — same
// shape as POST /attic/archive, just the other terminal status.
// Body: { ids: number[] }
// Returns: { ok: true, deleted: <count> }
router.delete("/attic", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "number")) {
    res.status(400).json({ error: "ids must be a non-empty array of numbers" });
    return;
  }
  try {
    const deleted = await deleteAtticItems(userName, ids);
    req.log.info({ requested: ids.length, deleted }, "[Attic] DELETE /attic");
    res.json({ ok: true, deleted });
  } catch (err) {
    req.log.error({ err }, "[Attic] DELETE /attic error");
    res.status(500).json({ error: "Failed to delete items" });
  }
});

export default router;
