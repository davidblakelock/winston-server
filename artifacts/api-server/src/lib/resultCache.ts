/**
 * Generic DB-backed key/value cache.
 *
 * Survives server restarts — used to cache expensive fetch results (e.g.
 * Ticketmaster event lookups) and to persist "did we already do X today?"
 * flags across restarts.
 *
 * Table: apify_cache (cache_key TEXT PK, content TEXT, fetched_at TIMESTAMPTZ)
 * — table name predates this module being made generic; kept as-is to avoid
 * an unnecessary migration, it's an internal storage detail only.
 */

import { query } from "../db.js";
import { logger } from "./logger.js";

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Returns cached content if it exists and is fresher than `ttlMs`.
 * Returns null on cache miss, expiry, or any DB error.
 */
export async function getCachedResult(key: string, ttlMs: number): Promise<string | null> {
  try {
    const { rows } = await query<{ content: string; fetched_at: string }>(
      `SELECT content, fetched_at FROM apify_cache WHERE cache_key = $1`,
      [key]
    );
    if (!rows[0]) return null;
    const age = Date.now() - new Date(rows[0].fetched_at).getTime();
    if (age > ttlMs) {
      logger.info({ key, ageHours: (age / 3_600_000).toFixed(1) }, "[ResultCache] Cache expired");
      return null;
    }
    logger.info({ key, ageHours: (age / 3_600_000).toFixed(1) }, "[ResultCache] Cache hit");
    return rows[0].content;
  } catch (err) {
    logger.warn({ err, key }, "[ResultCache] getCachedResult DB error — treating as miss");
    return null;
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Upserts content into the cache for the given key. Non-fatal on error. */
export async function setCachedResult(key: string, content: string): Promise<void> {
  try {
    await query(
      `INSERT INTO apify_cache (cache_key, content, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET content = EXCLUDED.content,
             fetched_at = NOW()`,
      [key, content]
    );
    logger.info({ key, chars: content.length }, "[ResultCache] Saved to DB");
  } catch (err) {
    logger.warn({ err, key }, "[ResultCache] setCachedResult DB error — non-fatal");
  }
}

// ── Daily flag (for "did we already do X today?") ────────────────────────────

/**
 * Returns true if the daily flag for `key` is already set to `dateKey`.
 * Use this to prevent duplicate midday checks / once-per-day actions after restarts.
 */
export async function wasDailyFlagSet(key: string, dateKey: string): Promise<boolean> {
  try {
    const { rows } = await query<{ content: string }>(
      `SELECT content FROM apify_cache WHERE cache_key = $1`,
      [key]
    );
    return rows[0]?.content === dateKey;
  } catch {
    return false; // treat as not set on DB error
  }
}

/** Marks a daily flag for `key` as completed for `dateKey`. Non-fatal on error. */
export async function setDailyFlag(key: string, dateKey: string): Promise<void> {
  try {
    await query(
      `INSERT INTO apify_cache (cache_key, content, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET content = EXCLUDED.content,
             fetched_at = NOW()`,
      [key, dateKey]
    );
  } catch (err) {
    logger.warn({ err, key }, "[ResultCache] setDailyFlag DB error — non-fatal");
  }
}

// ── Table creation (called from index.ts startup) ─────────────────────────────

export async function ensureResultCacheTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS apify_cache (
      cache_key   TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info("[ResultCache] apify_cache table ready");
}
