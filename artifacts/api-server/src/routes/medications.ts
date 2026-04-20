import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getMedications,
  addMedication,
  removeMedication,
} from "../medications/medicationManager.js";

const router: IRouter = Router();

// ── GET /api/medications ──────────────────────────────────────────────────────
// Returns all active medications for the user.
// Response: { medications: [{ id, name, dosage, reminderTime, active }] }
router.get("/medications", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const medications = await getMedications(userName);
    res.json({ medications });
  } catch (err) {
    req.log.error({ err }, "[MEDS] GET /medications error");
    res.status(500).json({ error: "Failed to fetch medications" });
  }
});

// ── POST /api/medications ─────────────────────────────────────────────────────
// Add a medication. Silently skips duplicates (same name already active).
// Body: { name: string, dosage?: string, reminderTime?: "HH:MM" }
// Response: { ok: true, medication, alreadyExists }
router.post("/medications", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { name, dosage, reminderTime } = req.body as {
    name?: string;
    dosage?: string;
    reminderTime?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // Validate reminderTime format if provided
  if (reminderTime && !/^\d{2}:\d{2}$/.test(reminderTime)) {
    res.status(400).json({ error: "reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const result = await addMedication(name.trim(), dosage?.trim(), reminderTime ?? "08:00", userName);
    res.json({
      ok: true,
      alreadyExists: result.alreadyExists,
      medication: result.medication ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications error");
    res.status(500).json({ error: "Failed to add medication" });
  }
});

// ── POST /api/medications/bulk ────────────────────────────────────────────────
// Add multiple medications in one call (for onboarding import).
// Body: { medications: [{ name, dosage?, reminderTime? }] }
// Response: { added: [...], skipped: [...] }
router.post("/medications/bulk", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { medications } = req.body as {
    medications?: Array<{ name: string; dosage?: string; reminderTime?: string }>;
  };

  if (!Array.isArray(medications) || medications.length === 0) {
    res.status(400).json({ error: "medications array is required" });
    return;
  }

  const added: string[] = [];
  const skipped: string[] = [];

  for (const med of medications) {
    if (!med.name?.trim()) continue;
    try {
      const result = await addMedication(med.name.trim(), med.dosage?.trim(), med.reminderTime ?? "08:00", userName);
      if (result.alreadyExists) {
        skipped.push(med.name.trim());
      } else {
        added.push(med.name.trim());
      }
    } catch {
      skipped.push(med.name.trim());
    }
  }

  res.json({ ok: true, added, skipped });
});

// ── DELETE /api/medications/:name ─────────────────────────────────────────────
// Soft-deletes (deactivates) a medication by name (partial match).
// Response: { ok: true, removed: boolean }
router.delete("/medications/:name", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { name } = req.params;
  try {
    const removed = await removeMedication(name, userName);
    res.json({ ok: true, removed });
  } catch (err) {
    req.log.error({ err }, "[MEDS] DELETE /medications error");
    res.status(500).json({ error: "Failed to remove medication" });
  }
});

export default router;
