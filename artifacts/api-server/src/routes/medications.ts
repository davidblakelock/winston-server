import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { query } from "../db.js";
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
import { broadcastToUser } from "../reminders/sseStore.js";

// Helper: run interaction check and broadcast "medications-changed" SSE event to the user.
// Called after every mutation (add, update, delete) so the native app's SSE listener
// always gets a fresh panel update regardless of whether it reads the mutation response body.
type InteractionResult = {
  interactions: import("../medications/medicationManager.js").DrugInteraction[];
  avoid: import("../medications/medicationManager.js").MedicationAvoid[];
  sideEffects: import("../medications/medicationManager.js").MedicationSideEffect[];
  checkedDrugs: string[];
};

const EMPTY_INTERACTIONS: InteractionResult = {
  interactions: [],
  avoid: [],
  sideEffects: [],
  checkedDrugs: [],
};

// Helper: run interaction check and broadcast "medications-changed" SSE event to the user.
// Called after every mutation (add, update, delete) so the native app's SSE listener
// always gets a fresh panel update regardless of whether it reads the mutation response body.
// The `source` field is included in the SSE payload so the native app can distinguish
// between add/update (where showing the interaction panel is appropriate) and delete
// (where showing the panel is not appropriate even if avoid/sideEffects remain for
// the still-active drugs — Meloxicam and Pravastatin always have these entries).
async function broadcastMedicationInteractions(
  userName: string,
  source: "add" | "update" | "delete"
): Promise<InteractionResult> {
  const result = await getMedicationInteractions(userName).catch(() => EMPTY_INTERACTIONS);
  broadcastToUser(userName, "medications-changed", {
    type: "medications-changed",
    source,
    interactions: result.interactions,
    avoid: result.avoid,
    sideEffects: result.sideEffects,
    checkedDrugs: result.checkedDrugs,
  });
  return result;
}

const router: IRouter = Router();

// Replace all reminder times for a medication — delete existing rows then re-insert.
// Called after any add/update that includes a reminderTimes array.
async function replaceReminderTimes(medicationId: number, times: string[]): Promise<void> {
  await query(`DELETE FROM medication_reminder_times WHERE medication_id = $1`, [medicationId]);
  for (const t of times) {
    await query(
      `INSERT INTO medication_reminder_times (medication_id, reminder_time) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [medicationId, t]
    );
  }
}

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
// Checks all active medications for interactions, things to avoid, and side
// effects via a single Claude Sonnet prompt (see getMedicationInteractions()).
// Response: { interactions, avoid, sideEffects, checkedDrugs }
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
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "[MEDS] GET /medications/interactions error");
    res.status(500).json({ error: "Failed to check drug interactions", detail: msg });
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
    name, dosage, reminderTime, reminderTimes, frequency, timeOfDay, prescribingDoctor, notes, remindersEnabled,
  } = req.body as {
    name?: string;
    dosage?: string;
    reminderTime?: string;
    reminderTimes?: string[];
    frequency?: string;
    timeOfDay?: string;
    prescribingDoctor?: string;
    notes?: string;
    remindersEnabled?: boolean;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // Resolve reminder times: prefer reminderTimes[], fall back to single reminderTime, then default.
  const resolvedTimes: string[] =
    Array.isArray(reminderTimes) && reminderTimes.length > 0
      ? reminderTimes
      : reminderTime !== undefined
      ? [reminderTime]
      : ["08:00"];

  if (resolvedTimes.some((t) => !/^\d{2}:\d{2}$/.test(t))) {
    res.status(400).json({ error: "Each reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const result = await addMedicationFull(
      {
        name: name.trim(),
        dosage: dosage?.trim(),
        reminderTime: resolvedTimes[0],
        frequency: frequency?.trim(),
        timeOfDay: timeOfDay?.trim(),
        prescribingDoctor: prescribingDoctor?.trim(),
        notes: notes?.trim(),
        // Defaults to true (via addMedicationFull's fields.remindersEnabled ?? true)
        // when omitted, for backward compatibility with old client requests.
        remindersEnabled,
      },
      userName
    );
    req.log.info({ name: name.trim(), alreadyExists: result.alreadyExists }, "[MEDS] POST /medications/add");

    if (result.medication) {
      await replaceReminderTimes(result.medication.id, resolvedTimes);
    }

    // Auto-check drug interactions after adding — run against all active meds including the new one.
    // Included in the response AND broadcast via SSE so the native app panel always refreshes.
    const interactionResult = await broadcastMedicationInteractions(userName, "add");
    req.log.info(
      { interactions: interactionResult.interactions.length, checked: interactionResult.checkedDrugs.length },
      "[MEDS] Interaction check after add"
    );
    res.json({
      ok: true,
      source: "add" as const,
      alreadyExists: result.alreadyExists,
      medication: result.medication ? { ...result.medication, reminderTimes: resolvedTimes } : null,
      interactions: interactionResult.interactions,
      avoid: interactionResult.avoid,
      sideEffects: interactionResult.sideEffects,
      checkedDrugs: interactionResult.checkedDrugs,
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
    const reminderTime = req.body?.reminderTime ?? req.body?.notificationData?.reminderTime;
    if (reminderTime) {
      await query(
        `UPDATE medication_reminder_log
            SET acknowledged = TRUE, acknowledged_at = NOW()
          WHERE user_name = $1 AND reminder_type = $2 AND reminder_date = CURRENT_DATE`,
        [userName, `${userName}:${reminderTime}`]
      );
    }
    const meds = await getMedications(userName);
    if (meds.length > 0) await logMedicationsTaken(meds, userName);
    req.log.info({ userName, medCount: meds.length, reminderTime }, "[MEDS] Confirmed taken via notification action");
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
    // Native app sends { notificationData: data } — snoozeMinutes is nested inside.
    const rawSnooze =
      req.body?.snoozeMinutes ??
      req.body?.notificationData?.snoozeMinutes;
    const snoozeMinutes = typeof rawSnooze === "number"
      ? Math.max(1, Math.min(rawSnooze, 480))
      : 60;
    const fireAt = new Date(Date.now() + snoozeMinutes * 60 * 1000);
    const profile = await getProfile(userName).catch(() => null);
    // Pass pushCategoryId so the re-fired reminder retains the medication action buttons
    // ("Taken ✓" and "Remind in 30 min") instead of firing as a generic reminder-action.
    // actionTaken / actionSnooze must be in pushData so the scheduler spreads them into
    // the Expo message — without them the buttons appear but the endpoints are missing.
    // LOCKED: do not change actionTaken or actionSnooze without explicit user request.
    const reminder = await createReminder({
      userName,
      reminderText: "Have you taken your medications?",
      fireAt,
      timezone: profile?.timezone ?? "UTC",
      pushCategoryId: "medication-action",
      pushData: {
        notificationType: "medication",
        tag: "medication-morning",
        actionTaken: "/api/medications/confirm-taken",
        actionSnooze: "/api/medications/snooze-reminder",
        snoozeMinutes: 60,
      },
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
    name, dosage, reminderTime, reminderTimes, frequency, timeOfDay, prescribingDoctor, notes, active, remindersEnabled,
  } = req.body as {
    name?: string;
    dosage?: string | null;
    reminderTime?: string;
    reminderTimes?: string[];
    frequency?: string | null;
    timeOfDay?: string | null;
    prescribingDoctor?: string | null;
    notes?: string | null;
    active?: boolean;
    remindersEnabled?: boolean;
  };

  // Resolve reminder times only if the caller sent something time-related.
  const resolvedTimes: string[] | null =
    Array.isArray(reminderTimes) && reminderTimes.length > 0
      ? reminderTimes
      : reminderTime !== undefined
      ? [reminderTime]
      : null;

  if (resolvedTimes?.some((t) => !/^\d{2}:\d{2}$/.test(t))) {
    res.status(400).json({ error: "Each reminderTime must be HH:MM format, e.g. '08:00'" });
    return;
  }

  try {
    const medication = await updateMedication(
      id,
      { name: name?.trim(), dosage, reminderTime: resolvedTimes?.[0], frequency, timeOfDay, prescribingDoctor, notes, active, remindersEnabled },
      userName
    );
    if (!medication) {
      res.status(404).json({ error: "Medication not found" });
      return;
    }
    req.log.info({ id, userName }, "[MEDS] PUT /medications/:id");

    if (resolvedTimes) {
      await replaceReminderTimes(id, resolvedTimes);
    }

    // Re-check interactions and broadcast SSE after any update (name change, deactivation, etc.)
    // so the native app panel stays in sync without a manual refresh.
    const interactionResult = await broadcastMedicationInteractions(userName, "update");
    req.log.info(
      { interactions: interactionResult.interactions.length, checked: interactionResult.checkedDrugs.length },
      "[MEDS] PUT — interactions refreshed + SSE broadcast"
    );

    res.json({
      ok: true,
      source: "update" as const,
      medication: resolvedTimes ? { ...medication, reminderTimes: resolvedTimes } : medication,
      interactions: interactionResult.interactions,
      avoid: interactionResult.avoid,
      sideEffects: interactionResult.sideEffects,
      checkedDrugs: interactionResult.checkedDrugs,
    });
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
    // broadcastMedicationInteractions also fires an SSE "medications-changed" event so
    // the native app panel updates even if it doesn't read the DELETE response body.
    // source="delete" lets the native app suppress the interaction panel on delete —
    // avoid/sideEffects are always present for drugs like Meloxicam/Pravastatin even
    // when there are no drug-drug interactions between the remaining medications.
    const interactionResult = await broadcastMedicationInteractions(userName, "delete");

    req.log.info(
      { interactions: interactionResult.interactions.length, checked: interactionResult.checkedDrugs.length },
      "[MEDS] DELETE — interactions refreshed + SSE broadcast"
    );

    res.json({
      ok: true,
      source: "delete" as const,
      removed,
      interactions: interactionResult.interactions,
      avoid: interactionResult.avoid,
      sideEffects: interactionResult.sideEffects,
      checkedDrugs: interactionResult.checkedDrugs,
    });
  } catch (err) {
    req.log.error({ err }, "[MEDS] DELETE /medications error");
    res.status(500).json({ error: "Failed to remove medication" });
  }
});

export default router;
