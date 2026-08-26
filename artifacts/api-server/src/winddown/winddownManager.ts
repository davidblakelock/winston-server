import { query } from "../db.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

export interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

// Every statement below is .catch()-guarded on purpose, including the
// CREATE TABLE IF NOT EXISTS ones that would rarely fail — one statement
// here once had no guard (see the seed-row INSERT's own comment below) and
// silently blocked every migration after it, on every server startup,
// until caught by a direct schema check against production. Nothing in
// this function should ever again be able to take the rest of it down.
export async function ensureWinddownTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_settings (
      id serial PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      scheduled_time varchar(5) NOT NULL DEFAULT '21:00',
      story_day_of_week varchar(10) NOT NULL DEFAULT 'sunday',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  // Migration: add story_day_of_week if missing from existing installations
  await query(`
    ALTER TABLE winddown_settings ADD COLUMN IF NOT EXISTS story_day_of_week varchar(10) NOT NULL DEFAULT 'sunday'
  `).catch(() => {});
  // Pre-multi-user seed row, now permanently broken by the NOT NULL
  // user_name constraint added below (line 32) — this INSERT never supplies
  // user_name, so it throws every single time. It had no .catch(), so that
  // exception was rejecting this ENTIRE function on every server startup,
  // silently skipping every migration statement after it — including, most
  // recently, the scheduled_push_sent column added for claimScheduledPush
  // (never actually got created despite the deploy succeeding). Confirmed
  // live via a direct schema check against the production DB. This seed
  // row is obsolete anyway now that every real row carries a user_name;
  // catching it here just stops it from taking the rest of this function
  // down with it.
  await query(`
    INSERT INTO winddown_settings (enabled, scheduled_time)
    VALUES (true, '21:00')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `).catch(() => {});
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
  `).catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS winddown_state (
      id serial PRIMARY KEY,
      trigger_date date NOT NULL UNIQUE,
      triggered_at timestamptz NOT NULL DEFAULT NOW(),
      active boolean NOT NULL DEFAULT true,
      tonight_message text
    )
  `).catch(() => {});
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
  // Dedicated flag for "has tonight's SCHEDULED 9pm push specifically been
  // sent" — separate from the row's mere existence. See claimScheduledPush's
  // comment for why this had to be split out from markFiredToday/hasFiredToday.
  await query(`ALTER TABLE winddown_state ADD COLUMN IF NOT EXISTS scheduled_push_sent boolean NOT NULL DEFAULT false`).catch(() => {});
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

// Returns whether THIS call actually claimed today's slot (true) or someone
// else already had (false) — the INSERT...WHERE NOT EXISTS was already
// atomic, but the boolean was previously discarded (Promise<void>) and the
// caller swallowed any error and sent the push regardless either way. That
// combination meant two near-simultaneous callers (e.g. old+new server
// instances briefly overlapping during a rolling deploy) could both pass
// hasFiredToday's earlier check-then-act read and both end up sending —
// confirmed as a real, non-atomic check-then-act race, the same class of
// bug claimWinddownReply's own atomic UPDATE further down this file exists
// specifically to avoid. The caller must now check this return value and
// skip sending when it's false.
export async function markFiredToday(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  // RETURNING is required so this routes through exec_dml_ret (not exec_sql which can't handle DML).
  const { rows } = await query<{ id: number }>(
    `INSERT INTO winddown_state (user_name, trigger_date)
     SELECT $1, $2 WHERE NOT EXISTS (
       SELECT 1 FROM winddown_state WHERE user_name = $1 AND trigger_date = $2
     )
     RETURNING id`,
    [userName, today]
  );
  return rows.length > 0;
}

// Atomically claims TONIGHT'S SCHEDULED push specifically — independent of
// whether a winddown_state row for today already exists from some OTHER
// path (chatHandlerCore.ts's isWinddownOpener branch fires on the literal
// text "Evening Check In" arriving via any route, not just tonight's real
// push; /api/winddown/activate is a separate manual-trigger endpoint). Both
// of those used to share hasFiredToday/markFiredToday with the scheduler —
// meaning if EITHER fired earlier in the day for any reason, hasFiredToday
// returned true and the scheduler silently skipped the real 9pm push for
// the rest of the day. Confirmed live: a winddown_state row for a given day
// existed with triggered_at at 5:29am — hours before the 9pm schedule —
// and that night's real check-in never fired at all. Ensures the row
// exists first (idempotent, same as markFiredToday), then claims this
// dedicated flag with its own atomic UPDATE ... WHERE ... = false, so only
// the scheduler's own successful firing can ever set it, regardless of
// what else touched this row earlier in the day.
export async function claimScheduledPush(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  await query(
    `INSERT INTO winddown_state (user_name, trigger_date)
     SELECT $1, $2 WHERE NOT EXISTS (
       SELECT 1 FROM winddown_state WHERE user_name = $1 AND trigger_date = $2
     )`,
    [userName, today]
  );
  const { rows } = await query<{ id: number }>(
    `UPDATE winddown_state SET scheduled_push_sent = true
     WHERE user_name = $1 AND trigger_date = $2 AND scheduled_push_sent = false
     RETURNING id`,
    [userName, today]
  );
  return rows.length > 0;
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
//
// 30-minute expiry added after confirming live in life_captures: this used to
// have no time bound at all, so "active" just meant "waiting for literally the
// next message, whenever it comes" — a message sent hours later, on a totally
// different topic, still got claimed as tonight's reflection and written to My
// Life. Confirmed twice: a wake-word test ("Are you there?") claimed ~5 min
// after activation, and a stray "Evening wind down" utterance claimed 47
// minutes after that night's real 9pm firing, both saved verbatim as if they
// were personal reflections. 30 minutes covers a normal "read the prompt, type
// a reply" gap without leaving the window open for the rest of the evening —
// past that, a message is just a message again, not an assumed reply.
export async function claimWinddownReply(userName: string): Promise<boolean> {
  const { timezone: tz } = await getUserLocationContext(userName);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const { rows } = await query<{ id: number }>(
    `UPDATE winddown_state SET active = false
     WHERE user_name = $1 AND trigger_date = $2 AND active = true
       AND triggered_at >= now() - interval '30 minutes'
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

