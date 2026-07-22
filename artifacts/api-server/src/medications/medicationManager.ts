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
  reminderTimes?: string[];
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
    reminder_times: string[] | null;
    active: boolean;
    frequency: string | null;
    time_of_day: string | null;
    prescribing_doctor: string | null;
    notes: string | null;
  }>(
    `SELECT m.id, m.name, m.dosage, m.reminder_time, m.active, m.frequency, m.time_of_day, m.prescribing_doctor, m.notes,
            COALESCE(
              (SELECT json_agg(mrt.reminder_time ORDER BY mrt.reminder_time)
               FROM medication_reminder_times mrt
               WHERE mrt.medication_id = m.id),
              json_build_array(m.reminder_time)
            ) AS reminder_times
     FROM medications m
     WHERE m.user_name = $1 ${includeInactive ? "" : "AND m.active = true"}
     ORDER BY m.reminder_time ASC, m.name ASC`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    dosage: r.dosage,
    reminderTime: r.reminder_time,
    reminderTimes: Array.isArray(r.reminder_times) ? r.reminder_times : [r.reminder_time],
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

export interface MedicationAvoid {
  drug: string;
  items: string[];
}

interface ClaudeInteractionResponse {
  interactions: Array<{
    drugs: string[];
    severity: "low" | "moderate" | "high" | "critical";
    description: string;
    watchFor: string;
  }>;
  avoid: Array<{
    drug: string;
    items: string[];
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
  avoid: MedicationAvoid[];
  sideEffects: MedicationSideEffect[];
  checkedDrugs: string[];
}> {
  const meds = await getMedications(userName);
  const checkedDrugs = meds.map((m) => m.name);

  if (meds.length === 0) {
    return { interactions: [], avoid: [], sideEffects: [], checkedDrugs };
  }

  const medList = meds
    .map((m) => `- ${m.name}${m.dosage ? ` (${m.dosage})` : ""}${m.frequency ? `, ${m.frequency}` : ""}`)
    .join("\n");

  const prompt = `You're reviewing this person's medications for anything worth knowing about — the way a knowledgeable friend would explain it, not a pharmacist reading off a label. Use plain, everyday language throughout; assume no medical background.

MEDICATIONS:
${medList}

For each REAL, meaningful interaction between these specific drugs — things actually worth knowing about, not minor or theoretical ones — describe:
- Which drugs are involved
- How serious it is (moderate / high / critical)
- What the actual risk is, in one plain sentence (e.g. "Taking Aleve with Meloxicam raises your risk of stomach bleeding.")
- What to watch for, in a short phrase (e.g. "Stomach pain or dark stools")

Also note, for each drug: a few common things to avoid (foods, OTC products, supplements) and a few common side effects — briefly, in plain language.

Skip anything minor or not worth mentioning. If there's nothing meaningful to flag for a given drug or combination, leave it out entirely.

Respond only with valid JSON in this shape:
{
  "interactions": [{ "drugs": [...], "severity": "...", "description": "...", "watchFor": "..." }],
  "avoid": [{ "drug": "...", "items": [...] }],
  "sideEffects": [{ "drug": "...", "sideEffects": [...] }]
}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      process.stdout.write(`[STDOUT] MEDS-INTERACTIONS no JSON in Claude response. raw=${raw.slice(0, 300)}\n`);
      return { interactions: [], avoid: [], sideEffects: [], checkedDrugs };
    }

    let parsed: ClaudeInteractionResponse;
    try {
      parsed = JSON.parse(jsonMatch[0]) as ClaudeInteractionResponse;
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      process.stdout.write(`[STDOUT] MEDS-INTERACTIONS JSON parse failed: ${msg}\nraw snippet: ${jsonMatch[0].slice(0, 400)}\n`);
      return { interactions: [], avoid: [], sideEffects: [], checkedDrugs };
    }

    return {
      interactions: Array.isArray(parsed.interactions) ? parsed.interactions : [],
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid : [],
      sideEffects: Array.isArray(parsed.sideEffects) ? parsed.sideEffects : [],
      checkedDrugs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[STDOUT] MEDS-INTERACTIONS CATCH ERROR: ${msg}\n`);
    throw err;
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
  await query(`ALTER TABLE medication_reminder_log ADD COLUMN IF NOT EXISTS acknowledged boolean NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE medication_reminder_log ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz`);
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

export async function hasAcknowledgedSlot(userName: string, time: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_reminder_log
     WHERE user_name = $1 AND reminder_type = $2 AND reminder_date = CURRENT_DATE AND acknowledged = TRUE`,
    [userName, `${userName}:${time}`]
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
  type: string
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
  type: string
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
  const { rows } = await query<{ medication_reminders_muted: boolean }>(
    `SELECT medication_reminders_muted FROM user_profiles WHERE user_name = $1 LIMIT 1`,
    [userName]
  );
  return !(rows[0]?.medication_reminders_muted ?? false);
}

export async function setMedicationRemindersMuted(muted: boolean, userName = NATIVE_STORED_NAME): Promise<void> {
  await query(
    `UPDATE user_profiles SET medication_reminders_muted = $1 WHERE user_name = $2`,
    [muted, userName]
  );
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

export async function extractMedicationFromMessage(message: string): Promise<{
  name: string;
  dosage?: string;
  reminderTime?: string;
} | null> {
  const { extractMedicationWithAI } = await import("../lib/intentClassifier.js");
  return extractMedicationWithAI(message);
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
