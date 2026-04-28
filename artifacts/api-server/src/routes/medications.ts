import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getMedications,
  addMedication,
  removeMedication,
  logMedicationsTaken,
} from "../medications/medicationManager.js";
import { createReminder } from "../reminders/reminderManager.js";

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

// ── POST /api/medications/confirm-taken ──────────────────────────────────────
// Called by the native app when the user taps "Taken ✓" on the medication
// notification action button. Logs all active medications as taken for today.
// This runs as a background request — the app does NOT need to open.
// Response: { ok: true }
router.post("/medications/confirm-taken", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    if (meds.length > 0) {
      await logMedicationsTaken(meds, userName);
    }
    req.log.info({ userName, medCount: meds.length }, "[MEDS] Confirmed taken via notification action");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/confirm-taken error");
    res.status(500).json({ error: "Failed to log medications as taken" });
  }
});

// ── POST /api/medications/snooze-reminder ─────────────────────────────────────
// Called by the native app when the user taps "Remind me in 30 min" on the
// medication notification action button. Creates a one-off reminder 30 minutes
// from now. This runs as a background request — the app does NOT need to open.
// Response: { ok: true, reminderId: number }
router.post("/medications/snooze-reminder", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    const medText = meds.length > 0
      ? meds.map((m) => m.name).join(", ")
      : "your medications";
    const fireAt = new Date(Date.now() + 30 * 60 * 1000);
    const reminder = await createReminder({
      userName,
      reminderText: `Take ${medText}`,
      fireAt,
      timezone: "America/Chicago",
    });
    req.log.info({ userName, fireAt, reminderId: reminder.id }, "[MEDS] Snooze reminder created via notification action");
    res.json({ ok: true, reminderId: reminder.id });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/snooze-reminder error");
    res.status(500).json({ error: "Failed to create snooze reminder" });
  }
});

// ── POST /api/medications/taken — alias called by native notification action ───
// Identical to /api/medications/confirm-taken.
// The native app calls this path when the user taps "Taken ✓" on the
// medication push notification action button (background, app stays closed).
router.post("/medications/taken", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    if (meds.length > 0) {
      await logMedicationsTaken(meds, userName);
    }
    req.log.info({ userName, medCount: meds.length }, "[MEDS] Taken confirmed via /medications/taken");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/taken error");
    res.status(500).json({ error: "Failed to log medications as taken" });
  }
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
