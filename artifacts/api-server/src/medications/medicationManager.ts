import { query } from "../db.js";

export interface Medication {
  id: number;
  name: string;
  dosage: string | null;
  reminderTime: string;
  active: boolean;
}

export async function getMedications(userName = "David"): Promise<Medication[]> {
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
  userName = "David"
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

export async function removeMedication(name: string, userName = "David"): Promise<boolean> {
  const { rows } = await query(
    `UPDATE medications SET active = false
     WHERE user_name = $1 AND lower(name) LIKE lower($2) AND active = true
     RETURNING id`,
    [userName, `%${name}%`]
  );
  return rows.length > 0;
}

export async function hasTakenMedicationsToday(userName = "David"): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM medication_logs
     WHERE user_name = $1 AND log_date = CURRENT_DATE`,
    [userName]
  );
  return rows.length > 0;
}

export async function logMedicationsTaken(meds: Medication[], userName = "David"): Promise<void> {
  const names = meds.map((m) => m.name).join(", ");
  await query(
    `INSERT INTO medication_logs (user_name, log_date, medication_names)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_name, log_date) DO UPDATE SET
       confirmed_at = NOW(),
       medication_names = EXCLUDED.medication_names`,
    [userName, names]
  );
}

export async function seedDefaultMedications(): Promise<void> {
  const defaults = [
    { name: "statin", dosage: null, reminderTime: "08:00" },
    { name: "Meloxicam", dosage: null, reminderTime: "08:00" },
  ];
  for (const med of defaults) {
    await query(
      `INSERT INTO medications (user_name, name, dosage, reminder_time)
       VALUES ('David2', $1, $2, $3)
       ON CONFLICT (user_name, name) DO NOTHING`,
      [med.name, med.dosage, med.reminderTime]
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

function parseTimeToHHMM(raw: string): string {
  const match = raw.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!match) return "08:00";
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2] ?? "0", 10);
  const ampm = match[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
