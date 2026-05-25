import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getMedications,
  addMedication,
  addMedicationFull,
  updateMedication,
  removeMedication,
  removeMedicationById,
  logMedicationsTaken,
  acknowledgeMedicationDose,
  getTodayDoseLog,
  getMedicationInteractions,
  exportMedicationsEmail,
  buildMedEmailText,
} from "../medications/medicationManager.js";
import { createReminder } from "../reminders/reminderManager.js";

const router: IRouter = Router();

// ── GET /api/medications ──────────────────────────────────────────────────────
// Returns medications for the user. Pass ?all=true to include inactive.
// Response: { medications: Medication[] }
router.get("/medications", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const includeInactive = req.query.all === "true";
    const medications = await getMedications(userName, includeInactive);
    res.json({ medications });
  } catch (err) {
    req.log.error({ err }, "[MEDS] GET /medications error");
    res.status(500).json({ error: "Failed to fetch medications" });
  }
});

// ── GET /api/medications/export/data ──────────────────────────────────────────
// Returns the medication list as formatted text — no SMTP required.
// The native app can display, copy, or share this text via the OS share sheet.
// Response: { ok, exportText, exportDate, medications }
router.get("/medications/export/data", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName, true);
    const active = meds.filter((m) => m.active);
    const exportDate = new Date().toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    });
    const exportText = buildMedEmailText(active, exportDate);
    req.log.info({ count: active.length }, "[MEDS] GET /medications/export/data");
    res.json({ ok: true, exportText, exportDate, medications: active });
  } catch (err) {
    req.log.error({ err }, "[MEDS] GET /medications/export/data error");
    res.status(500).json({ error: "Failed to build medication export" });
  }
});

// ── GET /api/medications/interactions ─────────────────────────────────────────
// Checks all active medications against the RxNorm interaction database (free, no key).
// Response: { interactions, checkedDrugs, failedLookups }
router.get("/medications/interactions", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const result = await getMedicationInteractions(userName);
    req.log.info(
      { checkedDrugs: result.checkedDrugs.length, interactions: result.interactions.length },
      "[MEDS] Interaction check complete"
    );
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "[MEDS] GET /medications/interactions error");
    res.status(500).json({ error: "Failed to check drug interactions" });
  }
});

// ── GET /api/medications/log ──────────────────────────────────────────────────
// Returns today's per-dose acknowledgment log.
// Response: { log: DoseLogRow[], allAcknowledged: boolean }
router.get("/medications/log", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const log = await getTodayDoseLog(userName);
    const allAcknowledged = log.length > 0 && log.every((r) => r.acknowledged);
    res.json({ log, allAcknowledged, date: new Date().toISOString().split("T")[0] });
  } catch (err) {
    req.log.error({ err }, "[MEDS] GET /medications/log error");
    res.status(500).json({ error: "Failed to fetch medication log" });
  }
});

// ── POST /api/medications/add ─────────────────────────────────────────────────
// Add a medication with all fields.
// Body: { name, dosage?, reminderTime?, frequency?, timeOfDay?, prescribingDoctor?, notes? }
// Response: { ok: true, medication, alreadyExists }
router.post("/medications/add", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const {
    name, dosage, reminderTime, frequency, timeOfDay, prescribingDoctor, notes,
  } = req.body as {
    name?: string;
    dosage?: string;
    reminderTime?: string;
    frequency?: string;
    timeOfDay?: string;
    prescribingDoctor?: string;
    notes?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (reminderTime && !/^\d{2}:\d{2}$/.test(reminderTime)) {
    res.status(400).json({ error: "reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const result = await addMedicationFull(
      {
        name: name.trim(),
        dosage: dosage?.trim(),
        reminderTime: reminderTime ?? "08:00",
        frequency: frequency?.trim(),
        timeOfDay: timeOfDay?.trim(),
        prescribingDoctor: prescribingDoctor?.trim(),
        notes: notes?.trim(),
      },
      userName
    );
    req.log.info({ name: name.trim(), alreadyExists: result.alreadyExists }, "[MEDS] POST /medications/add");

    // Auto-check drug interactions after adding — run against all active meds including the new one.
    // Included in the response so the native app can surface warnings immediately.
    const interactionResult = await getMedicationInteractions(userName).catch(() => ({
      interactions: [] as import("../medications/medicationManager.js").DrugInteraction[],
      avoid: [] as import("../medications/medicationManager.js").MedicationAvoid[],
      sideEffects: [] as import("../medications/medicationManager.js").MedicationSideEffect[],
      checkedDrugs: [] as string[],
      failedLookups: [] as string[],
    }));
    req.log.info(
      { interactions: interactionResult.interactions.length, checked: interactionResult.checkedDrugs.length },
      "[MEDS] Interaction check after add"
    );
    res.json({
      ok: true,
      alreadyExists: result.alreadyExists,
      medication: result.medication ?? null,
      interactions: interactionResult.interactions,
      avoid: interactionResult.avoid,
      sideEffects: interactionResult.sideEffects,
      checkedDrugs: interactionResult.checkedDrugs,
      failedLookups: interactionResult.failedLookups,
    });
  } catch (err) {
    // Unique constraint violation — medication already exists (e.g. inactive record
    // not caught by the pre-check due to a race condition). Treat as alreadyExists.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      req.log.warn({ name: name?.trim() }, "[MEDS] POST /medications/add — duplicate constraint, returning alreadyExists");
      res.json({ ok: true, alreadyExists: true, medication: null });
      return;
    }
    req.log.error({ err }, "[MEDS] POST /medications/add error");
    res.status(500).json({ error: "Failed to add medication" });
  }
});

// ── POST /api/medications ─────────────────────────────────────────────────────
// Legacy add endpoint (name, dosage, reminderTime only). Kept for backwards compat.
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
  if (reminderTime && !/^\d{2}:\d{2}$/.test(reminderTime)) {
    res.status(400).json({ error: "reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const result = await addMedication(name.trim(), dosage?.trim(), reminderTime ?? "08:00", userName);
    res.json({ ok: true, alreadyExists: result.alreadyExists, medication: result.medication ?? null });
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
      if (result.alreadyExists) skipped.push(med.name.trim());
      else added.push(med.name.trim());
    } catch {
      skipped.push(med.name.trim());
    }
  }

  res.json({ ok: true, added, skipped });
});

// ── POST /api/medications/export ──────────────────────────────────────────────
// Emails the medication list to a specified address.
// Requires SMTP_HOST, SMTP_USER, SMTP_PASS env vars.
// Body: { email: string }
// Response: { ok: true } | { ok: false, error: string }
router.post("/medications/export", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { email } = req.body as { email?: string };
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  try {
    const result = await exportMedicationsEmail(email.trim(), userName);
    if (!result.sent) {
      req.log.warn({ error: result.error }, "[MEDS] Export email failed");
      res.status(503).json({ ok: false, error: result.error });
      return;
    }
    req.log.info({ to: email.trim() }, "[MEDS] Medication list exported via email");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/export error");
    res.status(500).json({ error: "Failed to export medications" });
  }
});

// ── POST /api/medications/confirm-taken ──────────────────────────────────────
router.post("/medications/confirm-taken", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    if (meds.length > 0) await logMedicationsTaken(meds, userName);
    req.log.info({ userName, medCount: meds.length }, "[MEDS] Confirmed taken via notification action");
    // dismissTag tells the native app which notification tag to dismiss after confirming.
    res.json({ ok: true, dismissTag: "medication-morning" });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/confirm-taken error");
    res.status(500).json({ error: "Failed to log medications as taken" });
  }
});

// ── POST /api/medications/snooze-reminder ─────────────────────────────────────
router.post("/medications/snooze-reminder", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    const medText = meds.length > 0 ? meds.map((m) => m.name).join(", ") : "your medications";
    const snoozeMinutes = typeof req.body?.snoozeMinutes === "number"
      ? Math.max(1, Math.min(req.body.snoozeMinutes, 480))
      : 30;
    const fireAt = new Date(Date.now() + snoozeMinutes * 60 * 1000);
    // Pass pushCategoryId so the re-fired reminder retains the medication action buttons
    // ("Taken ✓" and "Remind in 30 min") instead of firing as a generic reminder-action.
    const reminder = await createReminder({
      userName,
      reminderText: `Take ${medText}`,
      fireAt,
      timezone: "America/Chicago",
      pushCategoryId: "medication-action",
      pushData: { notificationType: "medication", tag: "medication-morning" },
    });
    req.log.info({ userName, fireAt, snoozeMinutes, reminderId: reminder.id }, "[MEDS] Snooze reminder created");
    // Return dismissTag so the native app can clear the original notification after snoozing.
    res.json({ ok: true, reminderId: reminder.id, dismissTag: "medication-morning" });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/snooze-reminder error");
    res.status(500).json({ error: "Failed to create snooze reminder" });
  }
});

// ── POST /api/medications/taken ───────────────────────────────────────────────
router.post("/medications/taken", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const meds = await getMedications(userName);
    if (meds.length > 0) await logMedicationsTaken(meds, userName);
    req.log.info({ userName, medCount: meds.length }, "[MEDS] Taken confirmed via /medications/taken");
    res.json({ ok: true, dismissTag: "medication-morning" });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/taken error");
    res.status(500).json({ error: "Failed to log medications as taken" });
  }
});

// ── POST /api/medications/acknowledge ────────────────────────────────────────
router.post("/medications/acknowledge", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const { medicationName } = req.body as { medicationName?: string };
    const result = await acknowledgeMedicationDose(userName, medicationName?.trim());
    req.log.info({ userName, acknowledged: result.acknowledged }, "[MEDS] Dose acknowledged");
    res.json({ ok: true, acknowledged: result.acknowledged });
  } catch (err) {
    req.log.error({ err }, "[MEDS] POST /medications/acknowledge error");
    res.status(500).json({ error: "Failed to acknowledge medication dose" });
  }
});

// ── PUT /api/medications/:id ──────────────────────────────────────────────────
// Update any fields on a medication by numeric ID.
// Body: { name?, dosage?, reminderTime?, frequency?, timeOfDay?, prescribingDoctor?, notes?, active? }
// Response: { ok: true, medication }
router.put("/medications/:id", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: "id must be a numeric medication ID" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  const {
    name, dosage, reminderTime, frequency, timeOfDay, prescribingDoctor, notes, active,
  } = req.body as {
    name?: string;
    dosage?: string | null;
    reminderTime?: string;
    frequency?: string | null;
    timeOfDay?: string | null;
    prescribingDoctor?: string | null;
    notes?: string | null;
    active?: boolean;
  };

  if (reminderTime && !/^\d{2}:\d{2}$/.test(reminderTime)) {
    res.status(400).json({ error: "reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const medication = await updateMedication(
      id,
      { name: name?.trim(), dosage, reminderTime, frequency, timeOfDay, prescribingDoctor, notes, active },
      userName
    );
    if (!medication) {
      res.status(404).json({ error: "Medication not found" });
      return;
    }
    req.log.info({ id, userName }, "[MEDS] PUT /medications/:id");
    res.json({ ok: true, medication });
  } catch (err) {
    req.log.error({ err }, "[MEDS] PUT /medications/:id error");
    res.status(500).json({ error: "Failed to update medication" });
  }
});

// ── DELETE /api/medications/:idOrName ────────────────────────────────────────
// Soft-deletes a medication. If the param is numeric, deletes by ID.
// Otherwise does a partial name match (legacy).
// Response: { ok: true, removed: boolean }
router.delete("/medications/:idOrName", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const param = req.params.idOrName;
  try {
    let removed: boolean;
    if (/^\d+$/.test(param)) {
      const id = parseInt(param, 10);
      removed = await removeMedicationById(id, userName);
      req.log.info({ id, removed }, "[MEDS] DELETE /medications/:id");
    } else {
      removed = await removeMedication(param, userName);
      req.log.info({ name: param, removed }, "[MEDS] DELETE /medications/:name");
    }

    // Re-check interactions now that the medication list has changed.
    const interactionResult = await getMedicationInteractions(userName).catch(() => ({
      interactions: [] as import("../medications/medicationManager.js").DrugInteraction[],
      avoid: [] as import("../medications/medicationManager.js").MedicationAvoid[],
      sideEffects: [] as import("../medications/medicationManager.js").MedicationSideEffect[],
      checkedDrugs: [] as string[],
      failedLookups: [] as string[],
    }));

    req.log.info(
      { interactions: interactionResult.interactions.length, checked: interactionResult.checkedDrugs.length },
      "[MEDS] DELETE — interactions refreshed"
    );

    res.json({
      ok: true,
      removed,
      interactions: interactionResult.interactions,
      avoid: interactionResult.avoid,
      sideEffects: interactionResult.sideEffects,
      checkedDrugs: interactionResult.checkedDrugs,
      failedLookups: interactionResult.failedLookups,
    });
  } catch (err) {
    req.log.error({ err }, "[MEDS] DELETE /medications error");
    res.status(500).json({ error: "Failed to remove medication" });
  }
});

export default router;
