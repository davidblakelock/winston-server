import { query } from "../db.js";

export type OliviaContactType = "mention" | "call" | "story_captured";

export async function recordOliviaContact(type: OliviaContactType, notes?: string): Promise<void> {
  await query(
    `INSERT INTO olivia_contacts (user_name, contact_type, notes, contact_date)
     VALUES ('David', $1, $2, CURRENT_DATE)`,
    [type, notes || null]
  );
}

export async function getDaysSinceLastOliviaContact(): Promise<number | null> {
  const { rows } = await query<{ days: string }>(
    `SELECT EXTRACT(DAY FROM (CURRENT_DATE - MAX(contact_date)))::int AS days
     FROM olivia_contacts
     WHERE user_name = 'David'`
  );
  if (!rows[0] || rows[0].days === null) return null;
  return parseInt(rows[0].days);
}

export async function getDaysSinceLastCall(): Promise<number | null> {
  const { rows } = await query<{ days: string }>(
    `SELECT EXTRACT(DAY FROM (CURRENT_DATE - MAX(contact_date)))::int AS days
     FROM olivia_contacts
     WHERE user_name = 'David' AND contact_type = 'call'`
  );
  if (!rows[0] || rows[0].days === null) return null;
  return parseInt(rows[0].days);
}

export async function getOliviaContactsThisWeek(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM olivia_contacts
     WHERE user_name = 'David'
       AND contact_date >= DATE_TRUNC('week', CURRENT_DATE)`
  );
  return parseInt(rows[0].count);
}

export async function mentionedCallToday(): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM olivia_contacts
     WHERE user_name = 'David' AND contact_type = 'call' AND contact_date = CURRENT_DATE`
  );
  return parseInt(rows[0].count) > 0;
}
