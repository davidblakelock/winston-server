import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface TrackedPerson {
  name: string;
  relationship: string;
  aliases: string[];
  callVerbs: string[];
}

// ── People to track (drawn from David's profile "people" array) ───────────────
// Olivia is tracked separately via contact_mentions; other important personal
// relationships live here.  Doctor/professional contacts are excluded —
// those don't need relationship-nurturing nudges.
export const TRACKED_PEOPLE: TrackedPerson[] = [
  {
    name: "Susan",
    relationship: "girlfriend",
    aliases: ["susan", "susan smart"],
    callVerbs: ["called", "texted", "talked to", "spoke with", "saw", "had dinner with", "facetimed"],
  },
];

// ── Ensure table exists ────────────────────────────────────────────────────────
export async function ensureRelationshipTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS relationship_mentions (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL DEFAULT 'David',
      person_name TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      mention_type TEXT NOT NULL DEFAULT 'mention', -- 'mention' | 'call' | 'visit'
      notes TEXT,
      mention_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS relationship_mentions_lookup
    ON relationship_mentions (user_name, person_name, mention_date)
  `);
}

// ── Record a mention ──────────────────────────────────────────────────────────
export async function recordMention(
  personName: string,
  relationshipType: string,
  mentionType: "mention" | "call" | "visit",
  notes?: string,
  userName = "David"
): Promise<void> {
  await query(
    `INSERT INTO relationship_mentions (user_name, person_name, relationship_type, mention_type, notes, mention_date)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
    [userName, personName, relationshipType, mentionType, notes ?? null]
  ).catch((err) => logger.warn({ err }, "recordMention failed"));
}

// ── Days since last mention ────────────────────────────────────────────────────
export async function getDaysSinceLastMention(personName: string, userName = "David"): Promise<number | null> {
  const { rows } = await query<{ days: string | null }>(
    `SELECT EXTRACT(DAY FROM (CURRENT_DATE - MAX(mention_date)))::int AS days
     FROM relationship_mentions
     WHERE user_name = $1 AND person_name = $2`,
    [userName, personName]
  );
  if (!rows[0] || rows[0].days === null) return null;
  return parseInt(rows[0].days);
}

// ── Check for call-type mention today ─────────────────────────────────────────
export async function mentionedCallToday(personName: string, userName = "David"): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM relationship_mentions
     WHERE user_name = $1 AND person_name = $2
       AND mention_type = 'call' AND mention_date = CURRENT_DATE`,
    [userName, personName]
  );
  return parseInt(rows[0].count) > 0;
}

// ── Detect which tracked person is mentioned ──────────────────────────────────
export function detectPersonMention(
  message: string
): { person: TrackedPerson; isCall: boolean } | null {
  const lower = message.toLowerCase();
  for (const person of TRACKED_PEOPLE) {
    const mentioned = person.aliases.some((a) => lower.includes(a));
    if (!mentioned) continue;
    const isCall = person.callVerbs.some((v) => lower.includes(v));
    return { person, isCall };
  }
  return null;
}
