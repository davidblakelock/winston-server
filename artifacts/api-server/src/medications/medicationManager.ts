import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface Medication {
  id: number;
  name: string;
  dosage: string | null;
  reminderTime: string;
  active: boolean;
}

export async function getMedications(userName = NATIVE_STORED_NAME): Promise<Medication[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    dosage: string | null;
    reminder_time: string;
    active: boolean;
  }>(
    `SELECT id, name, dosage, reminder_time, active
     FROM medications
     WHERE user_name = $1 AND active = true
     ORDER BY reminder_time ASC, name ASC`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    dosage: r.dosage,
    reminderTime: r.reminder_time,
    active: r.active,
  }));
}

export async function addMedication(
  name: string,
  dosage?: string,
  reminderTime = "08:00",
  userName = NATIVE_STORED_NAME
): Promise<{ success: boolean; alreadyExists: boolean; medication?: Medication }> {
  const existing = await query(
    `SELECT id FROM medications WHERE user_name = $1 AND lower(name) = lower($2) AND active = true`,
    [userName, name]
  );
  if (existing.rows.length > 0) {
    return { success: false, alreadyExists: true };
  }

  const { rows } = await query<{ id: number; name: string; dosage: string | null; reminder_time: string; active: boolean }>(
    `INSERT INTO medications (user_name, name, dosage, reminder_time)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, dosage, reminder_time, active`,
    [userName, name, dosage ?? null, reminderTime]
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
    },
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

export async function hasTakenMedicationsToday(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_logs
     WHERE user_name = $1 AND log_date = CURRENT_DATE`,
    [userName]
  );
  return rows.length > 0;
}

export async function logMedicationsTaken(meds: Medication[], userName = NATIVE_STORED_NAME): Promise<void> {
  const names = meds.map((m) => m.name).join(", ");
  // RETURNING id is required so exec_dml_ret (not exec_sql) handles this on Supabase.
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

// ── medication_reminder_log — DB-backed tracking of when reminders were sent ──
// This replaces in-memory Maps which reset on every server restart.

export async function initMedicationReminderLogTable(): Promise<void> {
  // medication_reminder_log — tracks when the daily reminder was sent (survives restarts)
  await query(`
    CREATE TABLE IF NOT EXISTS medication_reminder_log (
      id            serial PRIMARY KEY,
      user_name     text NOT NULL,
      reminder_date date NOT NULL DEFAULT CURRENT_DATE,
      reminder_type text NOT NULL,
      sent_at       timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, reminder_date, reminder_type)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_med_reminder_log_lookup
     ON medication_reminder_log (user_name, reminder_date)`
  );

  // medication_logs — tracks when the user confirmed they took their meds
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
}

export async function hasMedicationReminderSentToday(
  userName: string,
  type: "initial" | "followup"
): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_reminder_log
     WHERE user_name = $1
       AND reminder_date = CURRENT_DATE
       AND reminder_type = $2`,
    [userName, type]
  );
  return rows.length > 0;
}

export async function logMedicationReminderSent(
  userName: string,
  type: "initial" | "followup"
): Promise<void> {
  // RETURNING id routes through exec_dml_ret on Supabase (required for DML).
  await query(
    `INSERT INTO medication_reminder_log (user_name, reminder_date, reminder_type)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_name, reminder_date, reminder_type) DO NOTHING
     RETURNING id`,
    [userName, type]
  );
}

// ── Medication reminder mute preference ──────────────────────────────────────
// Stored in profile_items as category='preferences', name='medication_reminders_enabled'.
// When detail = 'false', all medication push notifications are silenced.

// Medication reminders are ENABLED by default.
// When the user mutes them, we insert a row with detail='muted'.
// To re-enable, we delete that row.
// This avoids needing a unique constraint on profile_items.

export async function getMedicationRemindersEnabled(
  userName = NATIVE_STORED_NAME
): Promise<boolean> {
  const { rows } = await query<{ detail: string | null }>(
    `SELECT detail FROM profile_items
     WHERE user_name = $1 AND category = 'preferences' AND name = 'medication_reminders_muted'
     LIMIT 1`,
    [userName]
  );
  // If a 'muted' row exists → reminders are disabled
  return rows.length === 0;
}

export async function setMedicationRemindersEnabled(
  enabled: boolean,
  userName = NATIVE_STORED_NAME
): Promise<void> {
  if (enabled) {
    // Re-enabling: remove the muted row. RETURNING id routes through exec_dml_ret on Supabase.
    await query(
      `DELETE FROM profile_items
       WHERE user_name = $1 AND category = 'preferences' AND name = 'medication_reminders_muted'
       RETURNING id`,
      [userName]
    );
  } else {
    // Muting: first remove any existing muted row, then insert fresh.
    // Two-step to avoid needing a unique constraint on profile_items.
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
  // "add a new medication called Metformin 500mg at 9am"
  // "add medication Lisinopril taken at 8pm"
  // "start taking Vitamin D"
  const nameMatch =
    message.match(/(?:add\s+(?:a\s+)?(?:new\s+)?medication\s+(?:called\s+)?|new\s+medication\s+(?:called\s+)?|start\s+taking\s+(?:a\s+)?(?:new\s+)?medication\s+called\s+|start\s+taking\s+)([\w\s\-]+?)(?:\s+(\d+\s*(?:mg|mcg|g|ml|iu)))?(?:\s+(?:taken\s+)?at\s+(\d{1,2}(?::\d{2})?\s*[ap]m|\d{1,2}:\d{2}))?(?:[.,!]|$)/i);

  if (!nameMatch) return null;

  const name = nameMatch[1].trim().replace(/\s+taken$/, "").replace(/\s+at$/, "");
  if (!name || name.length < 2) return null;

  const dosage = nameMatch[2]?.trim();
  const rawTime = nameMatch[3]?.trim();

  let reminderTime: string | undefined;
  if (rawTime) {
    reminderTime = parseTimeToHHMM(rawTime);
  }

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
