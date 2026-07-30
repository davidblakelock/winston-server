import { query } from "../db.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

export interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

export async function ensureWinddownTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      scheduled_time varchar(5) NOT NULL DEFAULT '21:00',
      story_day_of_week varchar(10) NOT NULL DEFAULT 'sunday',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // Migration: add story_day_of_week if missing from existing installations
  await query(`
    ALTER TABLE winddown_settings ADD COLUMN IF NOT EXISTS story_day_of_week varchar(10) NOT NULL DEFAULT 'sunday'
  `).catch(() => {});
  await query(`
    INSERT INTO winddown_settings (enabled, scheduled_time)
    VALUES (true, '21:00')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  // Migration: add per-user support to winddown_settings
  await query(`ALTER TABLE winddown_settings ADD COLUMN IF NOT EXISTS user_name TEXT`).catch(() => {});
  await query(`UPDATE winddown_settings SET user_name = 'davidblakelock' WHERE user_name IS NULL`).catch(() => {});
  await query(`ALTER TABLE winddown_settings ALTER COLUMN user_name SET NOT NULL`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS winddown_settings_user_name_idx ON winddown_settings (user_name)`).catch(() => {});
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
  // Migration: add per-user support to winddown_state
  await query(`ALTER TABLE winddown_state ADD COLUMN IF NOT EXISTS user_name TEXT`).catch(() => {});
  await query(`UPDATE winddown_state SET user_name = 'davidblakelock' WHERE user_name IS NULL`).catch(() => {});
  await query(`ALTER TABLE winddown_state ALTER COLUMN user_name SET NOT NULL`).catch(() => {});
  // Drop old single-column unique constraints so multiple users can share the same trigger_date
  await query(`DROP INDEX IF EXISTS winddown_state_trigger_date_idx`).catch(() => {});
  await query(`ALTER TABLE winddown_state DROP CONSTRAINT IF EXISTS winddown_state_trigger_date_key`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS winddown_state_user_trigger_date_idx ON winddown_state (user_name, trigger_date)`).catch(() => {});
  // Add journal columns if missing from existing installs (referenced in queries but not in original schema)
  await query(`ALTER TABLE winddown_state ADD COLUMN IF NOT EXISTS journal_offer_pending boolean NOT NULL DEFAULT false`).catch(() => {});
  await query(`ALTER TABLE winddown_state ADD COLUMN IF NOT EXISTS journal_captured boolean NOT NULL DEFAULT false`).catch(() => {});
}

export async function getSettings(userName: string): Promise<WinddownSettings> {
  const { rows } = await query<{ enabled: boolean; scheduled_time: string }>(
    `SELECT enabled, scheduled_time FROM winddown_settings WHERE user_name = $1`,
    [userName]
  );
  if (rows.length === 0) return { enabled: true, scheduledTime: "21:00" };
  return {
    enabled: rows[0]!.enabled,
    scheduledTime: rows[0]!.scheduled_time,
  };
}

export async function updateSettings(
  userName: string,
  settings: Partial<WinddownSettings>
): Promise<WinddownSettings> {
  const current = await getSettings(userName);
  const merged: WinddownSettings = {
    enabled: settings.enabled ?? current.enabled,
    scheduledTime: settings.scheduledTime ?? current.scheduledTime,
  };
  await query(
    `INSERT INTO winddown_settings (user_name, enabled, scheduled_time, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_name) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       scheduled_time = EXCLUDED.scheduled_time,
       updated_at = NOW()
     RETURNING user_name`,
    [userName, merged.enabled, merged.scheduledTime]
  );
  return merged;
}

export async function hasFiredToday(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query(
    `SELECT 1 FROM winddown_state WHERE user_name = $1 AND trigger_date = $2`,
    [userName, today]
  );
  return rows.length > 0;
}

export async function markFiredToday(userName: string): Promise<void> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  // RETURNING is required so this routes through exec_dml_ret (not exec_sql which can't handle DML).
  await query(
    `INSERT INTO winddown_state (user_name, trigger_date)
     SELECT $1, $2 WHERE NOT EXISTS (
       SELECT 1 FROM winddown_state WHERE user_name = $1 AND trigger_date = $2
     )
     RETURNING id`,
    [userName, today]
  );
}

export async function isWinddownActive(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ active: boolean }>(
    `SELECT active FROM winddown_state WHERE user_name = $1 AND trigger_date = $2`,
    [userName, today]
  );
  return rows.length > 0 && rows[0].active;
}

export async function setWinddownActive(userName: string, active: boolean): Promise<void> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET active = $1 WHERE user_name = $2 AND trigger_date = $3 RETURNING id`,
    [active, userName, today]
  );
}

// Atomically claims tonight's winddown reply: flips active -> false only if it
// was still true, in one statement. Prevents the check-then-act race where two
// near-simultaneous messages (voice segments, retries, quick back-to-back turns)
// each read active=true before either one's UPDATE commits, causing both to be
// treated as "the" reply. Only the caller that gets a row back won the claim.
export async function claimWinddownReply(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ id: number }>(
    `UPDATE winddown_state SET active = false
     WHERE user_name = $1 AND trigger_date = $2 AND active = true
     RETURNING id`,
    [userName, today]
  );
  return rows.length > 0;
}

export async function saveTonightMessage(userName: string, message: string): Promise<void> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `UPDATE winddown_state SET tonight_message = $1 WHERE user_name = $2 AND trigger_date = $3 RETURNING id`,
    [message, userName, today]
  );
}

export async function getTonightMessage(userName: string): Promise<string | null> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ tonight_message: string | null }>(
    `SELECT tonight_message FROM winddown_state WHERE user_name = $1 AND trigger_date = $2`,
    [userName, today]
  );
  return rows.length > 0 ? (rows[0].tonight_message ?? null) : null;
}

