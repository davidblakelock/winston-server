/**
 * Story deduplication for the morning briefing.
 * Tracks which headlines appeared in the last 3 days and filters them out
 * so David never hears the same story twice in a row.
 *
 * Table: daily_briefing_stories
 *   id          serial PK
 *   user_name   text
 *   headline    text   (normalized — lowercase, stripped punctuation, 80-char max)
 *   story_date  date
 *   created_at  timestamptz
 *   UNIQUE(user_name, headline, story_date)
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export async function initBriefingStoriesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS daily_briefing_stories (
      id         serial PRIMARY KEY,
      user_name  text NOT NULL,
      headline   text NOT NULL,
      story_date date NOT NULL DEFAULT CURRENT_DATE,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, headline, story_date)
    )
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_briefing_stories_lookup
     ON daily_briefing_stories (user_name, story_date)`
  );
}

export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function getSeenHeadlines(userName: string, days = 3): Promise<Set<string>> {
  try {
    // Strictly PREVIOUS days only — never today.
    // Today's briefing must always regenerate freely (server restarts, cache misses).
    // We log today's stories so they are filtered starting TOMORROW.
    const { rows } = await query<{ headline: string }>(
      `SELECT headline FROM daily_briefing_stories
       WHERE user_name = $1
         AND story_date >= CURRENT_DATE - ($2 || ' days')::interval
         AND story_date < CURRENT_DATE`,
      [userName, String(days)]
    );
    const set = new Set(rows.map((r) => r.headline));
    logger.info({ userName, count: set.size, days }, "[StoryDedup] Loaded seen headlines (previous days only)");
    return set;
  } catch (err) {
    logger.warn({ err }, "[StoryDedup] Failed to load seen headlines — skipping dedup this run");
    return new Set();
  }
}

export async function logBriefingStories(userName: string, rawHeadlines: string[]): Promise<void> {
  if (!rawHeadlines.length) return;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  let logged = 0;
  for (const raw of rawHeadlines) {
    const key = normalizeKey(raw);
    if (key.length < 5) continue;
    try {
      // RETURNING id routes this through exec_dml_ret on Supabase (plain INSERTs without
      // RETURNING are wrapped as SELECT FROM (INSERT) r which Supabase rejects).
      await query(
        `INSERT INTO daily_briefing_stories (user_name, headline, story_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_name, headline, story_date) DO NOTHING
         RETURNING id`,
        [userName, key, today]
      );
      logged++;
    } catch (err) {
      logger.warn({ err, key }, "[StoryDedup] Failed to log headline — skipping");
    }
  }
  logger.info({ userName, logged, total: rawHeadlines.length }, "[StoryDedup] Logged briefing stories");
}

export function isDuplicate(headline: string, seen: Set<string>): boolean {
  if (seen.size === 0) return false;
  return seen.has(normalizeKey(headline));
}

/**
 * Extract bold `**Title**` headlines from a formatted news block string.
 */
export function extractBoldHeadlines(newsBlock: string): string[] {
  const matches = [...newsBlock.matchAll(/\*\*([^*]{3,100})\*\*/g)];
  return matches.map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Remove headline+sentence pairs from a news block where the normalized headline
 * appears in the `seen` set. Returns the cleaned block and a count of removals.
 */
export function filterNewsBlock(
  newsBlock: string,
  seen: Set<string>
): { filtered: string; removed: string[] } {
  if (seen.size === 0) return { filtered: newsBlock, removed: [] };

  const removed: string[] = [];

  const filtered = newsBlock.replace(
    /\*\*([^*]{3,100})\*\*\n([^\n]*\n?)/g,
    (match, title: string, sentence: string) => {
      const key = normalizeKey(title);
      if (seen.has(key)) {
        removed.push(title.trim());
        return "";
      }
      return match;
    }
  );

  const cleaned = filtered.replace(/\n{3,}/g, "\n\n");
  return { filtered: cleaned, removed };
}
