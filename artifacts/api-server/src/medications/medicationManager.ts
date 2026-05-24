import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { MODEL_SONNET } from "../lib/models.js";
import nodemailer from "nodemailer";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface Medication {
  id: number;
  name: string;
  dosage: string | null;
  reminderTime: string;
  active: boolean;
  frequency: string | null;
  timeOfDay: string | null;
  prescribingDoctor: string | null;
  notes: string | null;
}

// ── Schema migrations ─────────────────────────────────────────────────────────

export async function runMedicationSchemaMigrations(): Promise<void> {
  await query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS frequency TEXT`);
  await query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS time_of_day TEXT`);
  await query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS prescribing_doctor TEXT`);
  await query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS notes TEXT`);
}

// ── Core CRUD ─────────────────────────────────────────────────────────────────

export async function getMedications(
  userName = NATIVE_STORED_NAME,
  includeInactive = false
): Promise<Medication[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    dosage: string | null;
    reminder_time: string;
    active: boolean;
    frequency: string | null;
    time_of_day: string | null;
    prescribing_doctor: string | null;
    notes: string | null;
  }>(
    `SELECT id, name, dosage, reminder_time, active, frequency, time_of_day, prescribing_doctor, notes
     FROM medications
     WHERE user_name = $1 ${includeInactive ? "" : "AND active = true"}
     ORDER BY reminder_time ASC, name ASC`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    dosage: r.dosage,
    reminderTime: r.reminder_time,
    active: r.active,
    frequency: r.frequency,
    timeOfDay: r.time_of_day,
    prescribingDoctor: r.prescribing_doctor,
    notes: r.notes,
  }));
}

export async function addMedication(
  name: string,
  dosage?: string,
  reminderTime = "08:00",
  userName = NATIVE_STORED_NAME
): Promise<{ success: boolean; alreadyExists: boolean; medication?: Medication }> {
  return addMedicationFull({ name, dosage, reminderTime }, userName);
}

export async function addMedicationFull(
  fields: {
    name: string;
    dosage?: string;
    reminderTime?: string;
    frequency?: string;
    timeOfDay?: string;
    prescribingDoctor?: string;
    notes?: string;
  },
  userName = NATIVE_STORED_NAME
): Promise<{ success: boolean; alreadyExists: boolean; medication?: Medication }> {
  // Check for any existing record (active OR inactive) — the unique constraint
  // is on (user_name, name) regardless of active status, so we must check both.
  const existing = await query<{ id: number; active: boolean }>(
    `SELECT id, active FROM medications WHERE user_name = $1 AND lower(name) = lower($2)`,
    [userName, fields.name]
  );
  if (existing.rows.length > 0) {
    const rec = existing.rows[0];
    // If the record is inactive, reactivate it and update all provided fields.
    if (!rec.active) {
      const reminderTime = fields.reminderTime ?? "08:00";
      const { rows: updated } = await query<{
        id: number; name: string; dosage: string | null; reminder_time: string;
        active: boolean; frequency: string | null; time_of_day: string | null;
        prescribing_doctor: string | null; notes: string | null;
      }>(
        `UPDATE medications
         SET active = true,
             dosage = COALESCE($3, dosage),
             reminder_time = $4,
             frequency = COALESCE($5, frequency),
             time_of_day = COALESCE($6, time_of_day),
             prescribing_doctor = COALESCE($7, prescribing_doctor),
             notes = COALESCE($8, notes)
         WHERE id = $1 AND user_name = $2
         RETURNING id, name, dosage, reminder_time, active, frequency, time_of_day, prescribing_doctor, notes`,
        [rec.id, userName, fields.dosage ?? null, reminderTime,
         fields.frequency ?? null, fields.timeOfDay ?? null,
         fields.prescribingDoctor ?? null, fields.notes ?? null]
      );
      const r = updated[0];
      return {
        success: true,
        alreadyExists: false,
        medication: r ? {
          id: r.id, name: r.name, dosage: r.dosage, reminderTime: r.reminder_time,
          active: r.active, frequency: r.frequency, timeOfDay: r.time_of_day,
          prescribingDoctor: r.prescribing_doctor, notes: r.notes,
        } : undefined,
      };
    }
    return { success: false, alreadyExists: true };
  }

  const reminderTime = fields.reminderTime ?? "08:00";
  const { rows } = await query<{
    id: number;
    name: string;
    dosage: string | null;
    reminder_time: string;
    active: boolean;
    frequency: string | null;
    time_of_day: string | null;
    prescribing_doctor: string | null;
    notes: string | null;
  }>(
    `INSERT INTO medications
       (user_name, name, dosage, reminder_time, frequency, time_of_day, prescribing_doctor, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, dosage, reminder_time, active, frequency, time_of_day, prescribing_doctor, notes`,
    [
      userName,
      fields.name,
      fields.dosage ?? null,
      reminderTime,
      fields.frequency ?? null,
      fields.timeOfDay ?? null,
      fields.prescribingDoctor ?? null,
      fields.notes ?? null,
    ]
  );

  return {
    success: true,
    alreadyExists: false,
    medication: {
      id: rows[0].id,
      name: rows[0].name,
      dosage: rows[0].dosage,
      reminderTime: rows[0].reminder_time,
      active: rows[0].active,
      frequency: rows[0].frequency,
      timeOfDay: rows[0].time_of_day,
      prescribingDoctor: rows[0].prescribing_doctor,
      notes: rows[0].notes,
    },
  };
}

export async function updateMedication(
  id: number,
  fields: {
    name?: string;
    dosage?: string | null;
    reminderTime?: string;
    frequency?: string | null;
    timeOfDay?: string | null;
    prescribingDoctor?: string | null;
    notes?: string | null;
    active?: boolean;
  },
  userName = NATIVE_STORED_NAME
): Promise<Medication | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (fields.name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(fields.name); }
  if (fields.dosage !== undefined) { setClauses.push(`dosage = $${idx++}`); values.push(fields.dosage); }
  if (fields.reminderTime !== undefined) { setClauses.push(`reminder_time = $${idx++}`); values.push(fields.reminderTime); }
  if (fields.frequency !== undefined) { setClauses.push(`frequency = $${idx++}`); values.push(fields.frequency); }
  if (fields.timeOfDay !== undefined) { setClauses.push(`time_of_day = $${idx++}`); values.push(fields.timeOfDay); }
  if (fields.prescribingDoctor !== undefined) { setClauses.push(`prescribing_doctor = $${idx++}`); values.push(fields.prescribingDoctor); }
  if (fields.notes !== undefined) { setClauses.push(`notes = $${idx++}`); values.push(fields.notes); }
  if (fields.active !== undefined) { setClauses.push(`active = $${idx++}`); values.push(fields.active); }

  if (setClauses.length === 0) return null;

  values.push(id, userName);
  const { rows } = await query<{
    id: number; name: string; dosage: string | null; reminder_time: string; active: boolean;
    frequency: string | null; time_of_day: string | null; prescribing_doctor: string | null; notes: string | null;
  }>(
    `UPDATE medications SET ${setClauses.join(", ")}
     WHERE id = $${idx} AND user_name = $${idx + 1}
     RETURNING id, name, dosage, reminder_time, active, frequency, time_of_day, prescribing_doctor, notes`,
    values
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id, name: rows[0].name, dosage: rows[0].dosage,
    reminderTime: rows[0].reminder_time, active: rows[0].active,
    frequency: rows[0].frequency, timeOfDay: rows[0].time_of_day,
    prescribingDoctor: rows[0].prescribing_doctor, notes: rows[0].notes,
  };
}

export async function removeMedication(name: string, userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query(
    `UPDATE medications SET active = false
     WHERE user_name = $1 AND lower(name) LIKE lower($2) AND active = true
     RETURNING id`,
    [userName, `%${name}%`]
  );
  return rows.length > 0;
}

export async function removeMedicationById(id: number, userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query(
    `UPDATE medications SET active = false
     WHERE id = $1 AND user_name = $2 AND active = true
     RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

// ── Drug interaction + side effect check via Claude Sonnet ────────────────────

export interface DrugInteraction {
  drugs: string[];
  severity: "low" | "moderate" | "high" | "critical";
  description: string;
  watchFor: string;
}

export interface MedicationSideEffect {
  drug: string;
  sideEffects: string[];
}

interface ClaudeInteractionResponse {
  interactions: Array<{
    drugs: string[];
    severity: "low" | "moderate" | "high" | "critical";
    description: string;
    watchFor: string;
  }>;
  sideEffects: Array<{
    drug: string;
    sideEffects: string[];
  }>;
}

export async function getMedicationInteractions(
  userName = NATIVE_STORED_NAME
): Promise<{
  interactions: DrugInteraction[];
  sideEffects: MedicationSideEffect[];
  checkedDrugs: string[];
  failedLookups: string[];
}> {
  const meds = await getMedications(userName);
  const checkedDrugs = meds.map((m) => m.name);

  if (meds.length === 0) {
    return { interactions: [], sideEffects: [], checkedDrugs, failedLookups: [] };
  }

  const medList = meds
    .map((m) => `- ${m.name}${m.dosage ? ` (${m.dosage})` : ""}${m.frequency ? `, ${m.frequency}` : ""}`)
    .join("\n");

  const prompt = `You are a clinical pharmacist reviewing a patient's medication list for drug interactions and notable side effects.

MEDICATION LIST:
${medList}

Your task has two parts. Write everything in plain, everyday English — as if you're explaining to a friend, not writing a medical document. No jargon, no Latin, no clinical terminology. The goal is awareness, not medical advice.

PART 1 — DRUG INTERACTIONS
Identify ALL meaningful interactions between any two or more drugs in this list. Be thorough — do not omit real ones, but do not fabricate ones that don't exist.

For each interaction provide:
- drugs: the exact drug names from the list that interact
- severity: one of "low", "moderate", "high", or "critical"
  - critical = these drugs should not be taken together without a doctor's supervision
  - high = real risk that needs a doctor's awareness
  - moderate = worth knowing about and monitoring
  - low = minor, just good to be aware of
- description: ONE plain English sentence that tells the user what to avoid and why in simple terms. Use everyday words. Name common brand names in parentheses where helpful (e.g. "ibuprofen (Advil)"). End the sentence with: "Talk to your doctor or pharmacist if you have questions."
  Good example: "Avoid taking ibuprofen (Advil) or aspirin while on Meloxicam — it raises the risk of stomach bleeding. Talk to your doctor or pharmacist if you have questions."
  Bad example: "Concurrent use of NSAIDs may potentiate gastrointestinal hemorrhagic risk via COX-1 inhibition."
- watchFor: one plain English sentence describing a simple, concrete symptom the person should watch for — something they'd actually notice at home (e.g. "Watch for unusual stomach pain, dark stools, or feeling dizzy.")

PART 2 — NOTABLE SIDE EFFECTS
For each individual medication, list 3–6 side effects in plain everyday language. Write each one as a short phrase a non-medical person would immediately understand (e.g. "stomach upset or nausea", "muscle aches", "dizziness when standing up"). No clinical terms.

Respond ONLY with valid JSON matching this exact schema (no markdown, no extra text):
{
  "interactions": [
    {
      "drugs": ["Drug A", "Drug B"],
      "severity": "moderate",
      "description": "...",
      "watchFor": "..."
    }
  ],
  "sideEffects": [
    {
      "drug": "Drug Name",
      "sideEffects": ["Side effect 1", "Side effect 2"]
    }
  ]
}

If there are genuinely no interactions between the drugs, return an empty interactions array.`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { interactions: [], sideEffects: [], checkedDrugs, failedLookups: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as ClaudeInteractionResponse;

    return {
      interactions: parsed.interactions ?? [],
      sideEffects: parsed.sideEffects ?? [],
      checkedDrugs,
      failedLookups: [],
    };
  } catch {
    return { interactions: [], sideEffects: [], checkedDrugs, failedLookups: [] };
  }
}

// ── Medication export via email ───────────────────────────────────────────────

function buildMedEmailHtml(meds: Medication[], exportDate: string): string {
  const rows = meds.map((m) => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;font-weight:600;">${m.name}</td>
      <td style="padding:10px 12px;">${m.dosage ?? "—"}</td>
      <td style="padding:10px 12px;">${m.frequency ?? "—"}</td>
      <td style="padding:10px 12px;">${m.timeOfDay ?? m.reminderTime}</td>
      <td style="padding:10px 12px;">${m.prescribingDoctor ?? "—"}</td>
      <td style="padding:10px 12px;">${m.notes ?? "—"}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111;max-width:800px;margin:0 auto;padding:24px;">
  <h2 style="margin-bottom:4px;">Medication List</h2>
  <p style="color:#6b7280;margin-top:0;">Exported ${exportDate} — David Blake Lock</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;">
    <thead>
      <tr style="background:#f3f4f6;text-align:left;">
        <th style="padding:10px 12px;">Medication</th>
        <th style="padding:10px 12px;">Dose</th>
        <th style="padding:10px 12px;">Frequency</th>
        <th style="padding:10px 12px;">Time</th>
        <th style="padding:10px 12px;">Prescribing Doctor</th>
        <th style="padding:10px 12px;">Notes</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Sent by Winston AI Companion</p>
</body>
</html>`;
}

export function buildMedEmailText(meds: Medication[], exportDate: string): string {
  const lines = meds.map((m) => [
    `Medication:  ${m.name}`,
    `Dose:        ${m.dosage ?? "—"}`,
    `Frequency:   ${m.frequency ?? "—"}`,
    `Time:        ${m.timeOfDay ?? m.reminderTime}`,
    `Doctor:      ${m.prescribingDoctor ?? "—"}`,
    `Notes:       ${m.notes ?? "—"}`,
  ].join("\n")).join("\n\n---\n\n");

  return `MEDICATION LIST — David Blake Lock\nExported: ${exportDate}\n\n${"=".repeat(40)}\n\n${lines}`;
}

export async function exportMedicationsEmail(
  toEmail: string,
  userName = NATIVE_STORED_NAME
): Promise<{ sent: boolean; error?: string }> {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM ?? smtpUser;
  const smtpPort = parseInt(process.env.SMTP_PORT ?? "587", 10);

  if (!smtpHost || !smtpUser || !smtpPass) {
    return { sent: false, error: "SMTP not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS." };
  }

  const meds = await getMedications(userName, true);
  const active = meds.filter((m) => m.active);
  const exportDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  try {
    await transport.sendMail({
      from: `"Winston" <${smtpFrom}>`,
      to: toEmail,
      subject: `Medication List — ${exportDate}`,
      text: buildMedEmailText(active, exportDate),
      html: buildMedEmailHtml(active, exportDate),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Medication reminder log / scheduling helpers ──────────────────────────────

export async function initMedicationReminderLogTable(): Promise<void> {
  await runMedicationSchemaMigrations();

  await query(`
    CREATE TABLE IF NOT EXISTS medication_reminder_log (
      id            serial PRIMARY KEY,
      user_name     text NOT NULL,
      reminder_date date NOT NULL DEFAULT CURRENT_DATE,
      reminder_type text NOT NULL,
      sent_at       timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS medication_reminder_log_uniq
     ON medication_reminder_log (user_name, reminder_date, reminder_type)`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_med_reminder_log_lookup
     ON medication_reminder_log (user_name, reminder_date)`
  );

  await query(`
    CREATE TABLE IF NOT EXISTS medication_logs (
      id                serial PRIMARY KEY,
      user_name         text NOT NULL,
      log_date          date NOT NULL DEFAULT CURRENT_DATE,
      medication_names  text,
      confirmed_at      timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, log_date)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS medication_dose_logs (
      id               serial PRIMARY KEY,
      user_name        text NOT NULL,
      medication_name  text NOT NULL,
      scheduled_time   text NOT NULL,
      acknowledged     boolean NOT NULL DEFAULT FALSE,
      acknowledged_at  timestamptz,
      log_date         date NOT NULL DEFAULT CURRENT_DATE,
      created_at       timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_medication_dose_logs_user_date
     ON medication_dose_logs (user_name, log_date)`
  );
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS medication_dose_logs_uniq
     ON medication_dose_logs (user_name, medication_name, log_date)`
  );
}

// ── Per-dose acknowledgment ───────────────────────────────────────────────────

export interface DoseLogRow {
  id: number;
  user_name: string;
  medication_name: string;
  scheduled_time: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  log_date: string;
  created_at: string;
}

export async function seedTodayDoseLog(userName = NATIVE_STORED_NAME): Promise<void> {
  const meds = await getMedications(userName);
  for (const med of meds) {
    await query(
      `INSERT INTO medication_dose_logs (user_name, medication_name, scheduled_time, log_date)
       VALUES ($1, $2, $3, CURRENT_DATE)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userName, med.name, med.reminderTime]
    ).catch(() => {});
  }
}

export async function acknowledgeMedicationDose(
  userName = NATIVE_STORED_NAME,
  medicationName?: string
): Promise<{ acknowledged: string[] }> {
  const meds = await getMedications(userName);
  const targets = medicationName
    ? meds.filter((m) => m.name.toLowerCase().includes(medicationName.toLowerCase()))
    : meds;

  if (targets.length === 0) return { acknowledged: [] };

  await seedTodayDoseLog(userName);

  const acknowledged: string[] = [];
  for (const med of targets) {
    await query(
      `UPDATE medication_dose_logs
       SET acknowledged = TRUE, acknowledged_at = NOW()
       WHERE user_name = $1 AND medication_name = $2 AND log_date = CURRENT_DATE
       RETURNING id`,
      [userName, med.name]
    );
    acknowledged.push(med.name);
  }

  await logMedicationsTaken(targets, userName);
  return { acknowledged };
}

export async function getTodayDoseLog(userName = NATIVE_STORED_NAME): Promise<DoseLogRow[]> {
  await seedTodayDoseLog(userName);
  const { rows } = await query<DoseLogRow>(
    `SELECT * FROM medication_dose_logs
     WHERE user_name = $1 AND log_date = CURRENT_DATE
     ORDER BY scheduled_time ASC, medication_name ASC`,
    [userName]
  );
  return rows;
}

export async function allDosesAcknowledgedToday(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const rows = await getTodayDoseLog(userName);
  if (rows.length === 0) return false;
  return rows.every((r) => r.acknowledged);
}

export async function hasTakenMedicationsToday(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_logs WHERE user_name = $1 AND log_date = CURRENT_DATE`,
    [userName]
  );
  return rows.length > 0;
}

export async function logMedicationsTaken(meds: Medication[], userName = NATIVE_STORED_NAME): Promise<void> {
  const names = meds.map((m) => m.name).join(", ");
  await query(
    `INSERT INTO medication_logs (user_name, log_date, medication_names)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_name, log_date) DO UPDATE SET
       confirmed_at = NOW(),
       medication_names = EXCLUDED.medication_names
     RETURNING id`,
    [userName, names]
  );
}

export async function hasMedicationReminderSentToday(
  userName: string,
  type: "initial" | "followup"
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_reminder_log
     WHERE user_name = $1 AND reminder_date = CURRENT_DATE AND reminder_type = $2`,
    [userName, type]
  );
  return rows.length > 0;
}

export async function logMedicationReminderSent(
  userName: string,
  type: "initial" | "followup"
): Promise<void> {
  await query(
    `INSERT INTO medication_reminder_log (user_name, reminder_date, reminder_type)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_name, reminder_date, reminder_type) DO NOTHING
     RETURNING id`,
    [userName, type]
  );
}

// ── Reminder mute preference ──────────────────────────────────────────────────

export async function getMedicationRemindersEnabled(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query<{ detail: string | null }>(
    `SELECT detail FROM profile_items
     WHERE user_name = $1 AND category = 'preferences' AND name = 'medication_reminders_muted'
     LIMIT 1`,
    [userName]
  );
  return rows.length === 0;
}

export async function setMedicationRemindersEnabled(
  enabled: boolean,
  userName = NATIVE_STORED_NAME
): Promise<void> {
  if (enabled) {
    await query(
      `DELETE FROM profile_items
       WHERE user_name = $1 AND category = 'preferences' AND name = 'medication_reminders_muted'
       RETURNING id`,
      [userName]
    );
  } else {
    await query(
      `DELETE FROM profile_items
       WHERE user_name = $1 AND category = 'preferences' AND name = 'medication_reminders_muted'
       RETURNING id`,
      [userName]
    ).catch(() => {});
    await query(
      `INSERT INTO profile_items (user_name, category, name, detail)
       VALUES ($1, 'preferences', 'medication_reminders_muted', 'true')
       RETURNING id`,
      [userName]
    );
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

export function buildMedReminderText(meds: Medication[]): string {
  if (!meds.length) return "";
  if (meds.length === 1) return `your ${meds[0].name}${meds[0].dosage ? ` (${meds[0].dosage})` : ""}`;
  const last = meds[meds.length - 1];
  const rest = meds.slice(0, -1);
  return (
    rest.map((m) => `${m.name}${m.dosage ? ` (${m.dosage})` : ""}`).join(", ") +
    ` and ${last.name}${last.dosage ? ` (${last.dosage})` : ""}`
  );
}

export function extractMedicationFromMessage(message: string): {
  name: string;
  dosage?: string;
  reminderTime?: string;
} | null {
  const nameMatch =
    message.match(/(?:add\s+(?:a\s+)?(?:new\s+)?medication\s+(?:called\s+)?|new\s+medication\s+(?:called\s+)?|start\s+taking\s+(?:a\s+)?(?:new\s+)?medication\s+called\s+|start\s+taking\s+)([\w\s\-]+?)(?:\s+(\d+\s*(?:mg|mcg|g|ml|iu)))?(?:\s+(?:taken\s+)?at\s+(\d{1,2}(?::\d{2})?\s*[ap]m|\d{1,2}:\d{2}))?(?:[.,!]|$)/i);

  if (!nameMatch) return null;

  const name = nameMatch[1].trim().replace(/\s+taken$/, "").replace(/\s+at$/, "");
  if (!name || name.length < 2) return null;

  const dosage = nameMatch[2]?.trim();
  const rawTime = nameMatch[3]?.trim();
  const reminderTime = rawTime ? parseTimeToHHMM(rawTime) : undefined;

  return { name, dosage, reminderTime };
}

export async function updateMedicationReminderTime(
  newTime: string,
  userName = NATIVE_STORED_NAME
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `UPDATE medications SET reminder_time = $1
     WHERE user_name = $2 AND active = true
     RETURNING id`,
    [newTime, userName]
  );
  return rows.length;
}

export function parseTimeToHHMM(raw: string): string {
  const match = raw.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!match) return "08:00";
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2] ?? "0", 10);
  const ampm = match[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
