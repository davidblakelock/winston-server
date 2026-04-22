import { query } from "../db.js";

export interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

export interface WinddownNote {
  id: number;
  noteDate: string;
  note: string;
  createdAt: Date;
}

export async function ensureWinddownTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      scheduled_time varchar(5) NOT NULL DEFAULT '21:00',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO winddown_settings (id, enabled, scheduled_time)
    VALUES (1, true, '21:00')
    ON CONFLICT (id) DO NOTHING
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_notes (
      id serial PRIMARY KEY,
      note_date date NOT NULL DEFAULT CURRENT_DATE,
      note text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_state (
      id serial PRIMARY KEY,
      trigger_date date NOT NULL UNIQUE,
      triggered_at timestamptz NOT NULL DEFAULT NOW(),
      active boolean NOT NULL DEFAULT true,
      tonight_message text
    )
  `);
  // Add tonight_message column if it doesn't exist (migration for existing installs)
  await query(`
    ALTER TABLE winddown_state ADD COLUMN IF NOT EXISTS tonight_message text
  `).catch(() => {});
  // Ensure the UNIQUE constraint exists on trigger_date — tables created before this
  // constraint was added to the schema will be missing it, causing ON CONFLICT to fail.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS winddown_state_trigger_date_idx
    ON winddown_state (trigger_date)
  `).catch(() => {});
}

export async function getSettings(): Promise<WinddownSettings> {
  const { rows } = await query<{ enabled: boolean; scheduled_time: string }>(
    `SELECT enabled, scheduled_time FROM winddown_settings WHERE id = 1`
  );
  if (rows.length === 0) return { enabled: true, scheduledTime: "21:00" };
  return { enabled: rows[0].enabled, scheduledTime: rows[0].scheduled_time };
}

export async function updateSettings(
  settings: Partial<WinddownSettings>
): Promise<WinddownSettings> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (settings.enabled !== undefined) {
    fields.push(`enabled = $${i++}`);
    values.push(settings.enabled);
  }
  if (settings.scheduledTime !== undefined) {
    fields.push(`scheduled_time = $${i++}`);
    values.push(settings.scheduledTime);
  }
  fields.push(`updated_at = NOW()`);
  await query(
    `UPDATE winddown_settings SET ${fields.join(", ")} WHERE id = 1`,
    values
  );
  return getSettings();
}

export async function hasFiredToday(): Promise<boolean> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query(
    `SELECT 1 FROM winddown_state WHERE trigger_date = $1`,
    [today]
  );
  return rows.length > 0;
}

export async function markFiredToday(): Promise<void> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  // Use WHERE NOT EXISTS instead of ON CONFLICT to avoid depending on a UNIQUE constraint
  // that may be missing from older installations.
  await query(
    `INSERT INTO winddown_state (trigger_date)
     SELECT $1 WHERE NOT EXISTS (
       SELECT 1 FROM winddown_state WHERE trigger_date = $1
     )`,
    [today]
  );
}

export async function isWinddownActive(): Promise<boolean> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ active: boolean }>(
    `SELECT active FROM winddown_state WHERE trigger_date = $1`,
    [today]
  );
  return rows.length > 0 && rows[0].active;
}

export async function setWinddownActive(active: boolean): Promise<void> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET active = $1 WHERE trigger_date = $2`,
    [active, today]
  );
}

export async function saveWinddownNote(note: string): Promise<void> {
  await query(`INSERT INTO winddown_notes (note) VALUES ($1)`, [note]);
}

export async function getLastNightNotes(): Promise<WinddownNote[]> {
  const { rows } = await query<{
    id: number;
    note_date: string;
    note: string;
    created_at: Date;
  }>(
    `SELECT id, note_date::text, note, created_at
     FROM winddown_notes
     WHERE note_date >= CURRENT_DATE - INTERVAL '1 day'
       AND note_date < CURRENT_DATE
     ORDER BY created_at ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    noteDate: r.note_date,
    note: r.note,
    createdAt: r.created_at,
  }));
}

export function formatNotesForMorningBriefing(notes: WinddownNote[]): string {
  if (notes.length === 0) return "";
  const items = notes.map((n) => `• ${n.note}`).join("\n");
  return (
    `\n\n[Notes David asked you to mention this morning — from last night's check-in]\n` +
    items +
    `\nMention these naturally early in your morning briefing.`
  );
}

export async function saveTonightMessage(message: string): Promise<void> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET tonight_message = $1 WHERE trigger_date = $2`,
    [message, today]
  );
}

export async function getTonightMessage(): Promise<string | null> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ tonight_message: string | null }>(
    `SELECT tonight_message FROM winddown_state WHERE trigger_date = $1`,
    [today]
  );
  return rows.length > 0 ? (rows[0].tonight_message ?? null) : null;
}

export async function setJournalOfferPending(pending: boolean): Promise<void> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET journal_offer_pending = $1 WHERE trigger_date = $2`,
    [pending, today]
  );
}

export async function isJournalOfferPending(): Promise<boolean> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ journal_offer_pending: boolean }>(
    `SELECT journal_offer_pending FROM winddown_state WHERE trigger_date = $1`,
    [today]
  );
  return rows.length > 0 && rows[0].journal_offer_pending === true;
}

export async function setJournalCaptured(captured: boolean): Promise<void> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET journal_captured = $1 WHERE trigger_date = $2`,
    [captured, today]
  );
}

export async function hasJournalCapturedTonight(): Promise<boolean> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ journal_captured: boolean }>(
    `SELECT journal_captured FROM winddown_state WHERE trigger_date = $1`,
    [today]
  );
  return rows.length > 0 && rows[0].journal_captured === true;
}
