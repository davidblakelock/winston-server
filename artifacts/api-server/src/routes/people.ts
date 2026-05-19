import { Router, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getPeople,
  createPerson,
  updatePerson,
  deletePerson,
  type CreatePersonInput,
  type UpdatePersonInput,
} from "../people/peopleManager.js";

const router = Router();

// ── GET /api/people ───────────────────────────────────────────────────────────
// Returns all key people for the authenticated user, sorted by name.
router.get("/people", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const people = await getPeople(userName);
    res.json({ people });
  } catch (err) {
    req.log.error({ err }, "[People] GET /people error");
    res.status(500).json({ error: "Failed to load people" });
  }
});

// ── POST /api/people ──────────────────────────────────────────────────────────
// Creates a new key person.
router.post(
  "/people",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const body = req.body as Record<string, unknown>;
    const { name, relationship, phone, email, birthday, anniversary, notes, googleContactId } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const input: CreatePersonInput = {
      name: name.trim(),
      relationship: typeof relationship === "string" ? relationship.trim() || null : null,
      phone: typeof phone === "string" ? phone.trim() || null : null,
      email: typeof email === "string" ? email.trim() || null : null,
      birthday: typeof birthday === "string" ? birthday || null : null,
      anniversary: typeof anniversary === "string" ? anniversary || null : null,
      notes: typeof notes === "string" ? notes.trim() || null : null,
      googleContactId: typeof googleContactId === "string" ? googleContactId || null : null,
    };

    try {
      const person = await createPerson(userName, input);
      res.status(201).json({ person });
    } catch (err) {
      req.log.error({ err }, "[People] POST /people error");
      res.status(500).json({ error: "Failed to create person" });
    }
  }
);

// ── PUT /api/people/:id ───────────────────────────────────────────────────────
// Updates a key person. Only fields present in the body are changed.
router.put(
  "/people/:id",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const id = parseInt(String(req.params["id"] ?? ""), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const updates: UpdatePersonInput = {};

    if (body["name"] !== undefined)            updates.name            = String(body["name"]).trim();
    if (body["relationship"] !== undefined)    updates.relationship    = body["relationship"] ? String(body["relationship"]) : null;
    if (body["phone"] !== undefined)           updates.phone           = body["phone"] ? String(body["phone"]) : null;
    if (body["email"] !== undefined)           updates.email           = body["email"] ? String(body["email"]) : null;
    if (body["birthday"] !== undefined)        updates.birthday        = body["birthday"] ? String(body["birthday"]) : null;
    if (body["anniversary"] !== undefined)     updates.anniversary     = body["anniversary"] ? String(body["anniversary"]) : null;
    if (body["notes"] !== undefined)           updates.notes           = body["notes"] ? String(body["notes"]) : null;
    if (body["googleContactId"] !== undefined) updates.googleContactId = body["googleContactId"] ? String(body["googleContactId"]) : null;

    try {
      const person = await updatePerson(id, userName, updates);
      if (!person) {
        res.status(404).json({ error: "Person not found" });
        return;
      }
      req.log.info({ userName, id }, "[People] Updated");
      res.json({ person });
    } catch (err) {
      req.log.error({ err }, "[People] PUT /people/:id error");
      res.status(500).json({ error: "Failed to update person" });
    }
  }
);

// ── DELETE /api/people/:id ────────────────────────────────────────────────────
// Removes a key person.
router.delete("/people/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }

  try {
    const deleted = await deletePerson(id, userName);
    if (!deleted) {
      res.status(404).json({ error: "Person not found" });
      return;
    }
    req.log.info({ userName, id }, "[People] Deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[People] DELETE /people/:id error");
    res.status(500).json({ error: "Failed to delete person" });
  }
});

export default router;
