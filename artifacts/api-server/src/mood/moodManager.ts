import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export async function ensureMoodTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mood_checkins (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      mood_text TEXT NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mood_checkins_user_date_uq
    ON mood_checkins (user_name, date)
  `);
}

export async function saveMoodCheckin(
  moodText: string,
  userName: string
): Promise<void> {
  await query(
    `INSERT INTO mood_checkins (user_name, mood_text, date)
     VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT (user_name, date) DO UPDATE SET mood_text = EXCLUDED.mood_text
     RETURNING user_name`,
    [userName, moodText]
  );
  logger.info({ userName, preview: moodText.substring(0, 60) }, "[Mood] Check-in saved");
}

export async function getMoodForToday(userName: string): Promise<string | null> {
  const { rows } = await query<{ mood_text: string }>(
    `SELECT mood_text FROM mood_checkins WHERE user_name = $1 AND date = CURRENT_DATE`,
    [userName]
  );
  return rows[0]?.mood_text ?? null;
}

export async function getMoodSummaryThisWeek(
  userName: string
): Promise<Array<{ date: string; mood_text: string }>> {
  const { rows } = await query<{ date: string; mood_text: string }>(
    `SELECT date::text, mood_text
     FROM mood_checkins
     WHERE user_name = $1
       AND date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY date ASC`,
    [userName]
  );
  return rows;
}
