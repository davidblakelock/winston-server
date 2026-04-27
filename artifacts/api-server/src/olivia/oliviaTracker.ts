import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export type OliviaContactType = "mention" | "call" | "story_captured";

// ── Startup migration: rename olivia_contacts → contact_mentions ───────────────
export async function ensureContactMentionsTable(): Promise<void> {
  // Rename legacy table if it exists
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'olivia_contacts'
      ) AND NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'contact_mentions'
      ) THEN
        ALTER TABLE olivia_contacts RENAME TO contact_mentions;
      END IF;
    END $$;
  `).catch(() => {});

  // Ensure table exists (in case neither name exists yet)
  await query(`
    CREATE TABLE IF NOT EXISTS contact_mentions (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
      contact_type TEXT NOT NULL,
      notes TEXT,
      contact_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `).catch(() => {});
}

export async function recordOliviaContact(type: OliviaContactType, notes?: string, userName = NATIVE_STORED_NAME): Promise<void> {
  await query(
    `INSERT INTO contact_mentions (user_name, contact_type, notes, contact_date)
     VALUES ($1, $2, $3, CURRENT_DATE)
     RETURNING id`,
    [userName, type, notes || null]
  );
}

export async function getDaysSinceLastOliviaContact(userName = NATIVE_STORED_NAME): Promise<number | null> {
  const { rows } = await query<{ days: string }>(
    `SELECT EXTRACT(DAY FROM (CURRENT_DATE - MAX(contact_date)))::int AS days
     FROM contact_mentions
     WHERE user_name = $1`,
    [userName]
  );
  if (!rows[0] || rows[0].days === null) return null;
  return parseInt(rows[0].days);
}

export async function getDaysSinceLastCall(userName = NATIVE_STORED_NAME): Promise<number | null> {
  const { rows } = await query<{ days: string }>(
    `SELECT EXTRACT(DAY FROM (CURRENT_DATE - MAX(contact_date)))::int AS days
     FROM contact_mentions
     WHERE user_name = $1 AND contact_type = 'call'`,
    [userName]
  );
  if (!rows[0] || rows[0].days === null) return null;
  return parseInt(rows[0].days);
}

export async function getOliviaContactsThisWeek(userName = NATIVE_STORED_NAME): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM contact_mentions
     WHERE user_name = $1
       AND contact_date >= DATE_TRUNC('week', CURRENT_DATE)`,
    [userName]
  );
  return parseInt(rows[0].count);
}

export async function mentionedCallToday(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM contact_mentions
     WHERE user_name = $1 AND contact_type = 'call' AND contact_date = CURRENT_DATE`,
    [userName]
  );
  return parseInt(rows[0].count) > 0;
}
