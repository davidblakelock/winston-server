/**
 * DB-backed cache for Apify actor results.
 *
 * Survives server restarts — prevents redundant actor runs when the
 * in-memory cache is wiped by a deploy or crash.
 *
 * Table: apify_cache (cache_key TEXT PK, content TEXT, fetched_at TIMESTAMPTZ)
 */

import { query } from "../db.js";
import { logger } from "./logger.js";

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Returns cached content if it exists and is fresher than `ttlMs`.
 * Returns null on cache miss, expiry, or any DB error.
 */
export async function getCachedApify(key: string, ttlMs: number): Promise<string | null> {
  try {
    const { rows } = await query<{ content: string; fetched_at: string }>(
      `SELECT content, fetched_at FROM apify_cache WHERE cache_key = $1`,
      [key]
    );
    if (!rows[0]) return null;
    const age = Date.now() - new Date(rows[0].fetched_at).getTime();
    if (age > ttlMs) {
      logger.info({ key, ageHours: (age / 3_600_000).toFixed(1) }, "[ApifyCache] Cache expired");
      return null;
    }
    logger.info({ key, ageHours: (age / 3_600_000).toFixed(1) }, "[ApifyCache] Cache hit");
    return rows[0].content;
  } catch (err) {
    logger.warn({ err, key }, "[ApifyCache] getCachedApify DB error — treating as miss");
    return null;
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Upserts content into the cache for the given key. Non-fatal on error. */
export async function setCachedApify(key: string, content: string): Promise<void> {
  try {
    await query(
      `INSERT INTO apify_cache (cache_key, content, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET content = EXCLUDED.content,
             fetched_at = NOW()`,
      [key, content]
    );
    logger.info({ key, chars: content.length }, "[ApifyCache] Saved to DB");
  } catch (err) {
    logger.warn({ err, key }, "[ApifyCache] setCachedApify DB error — non-fatal");
  }
}

// ── Daily flag (for "did we already do X today?") ────────────────────────────

/**
 * Returns true if the daily flag for `key` is already set to `dateKey`.
 * Use this to prevent duplicate midday checks / once-per-day actions after restarts.
 */
export async function wasApifyDailyFlagSet(key: string, dateKey: string): Promise<boolean> {
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
export async function setApifyDailyFlag(key: string, dateKey: string): Promise<void> {
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
    logger.warn({ err, key }, "[ApifyCache] setApifyDailyFlag DB error — non-fatal");
  }
}

// ── Atomic per-actor run lock ─────────────────────────────────────────────────

/**
 * Atomically claim an Apify actor run slot using a DB-level hard lock.
 *
 * Returns true  → you won the slot; proceed with the actor run.
 * Returns false → a successful run already happened within ttlMs; skip entirely.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE WHERE fetched_at < cutoff so that only
 * ONE caller across concurrent processes/restarts can win.  The lock key is
 * stored as "lock:<key>" separate from the result cache key, so it persists
 * even after the result entry is overwritten with real content.
 */
export async function claimActorRun(key: string, ttlMs: number): Promise<boolean> {
  const lockKey = `lock:${key}`;
  const cutoff  = new Date(Date.now() - ttlMs).toISOString();
  try {
    const { rows } = await query<{ cache_key: string }>(
      `INSERT INTO apify_cache (cache_key, content, fetched_at)
       VALUES ($1, 'claimed', NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET content    = 'claimed',
             fetched_at = NOW()
         WHERE apify_cache.fetched_at < $2::timestamptz
       RETURNING cache_key`,
      [lockKey, cutoff]
    );
    if (rows.length > 0) {
      logger.info({ key }, "[ApifyCache] Actor lock claimed — proceeding with run");
      return true;
    }
    logger.info({ key }, "[ApifyCache] Actor lock is fresh — skipping run (within 23 h)");
    return false;
  } catch (err) {
    logger.warn({ err, key }, "[ApifyCache] claimActorRun DB error — allowing run as fallback");
    return true;
  }
}

// ── Table creation (called from index.ts startup) ─────────────────────────────

export async function ensureApifyCacheTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS apify_cache (
      cache_key   TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  logger.info("[ApifyCache] apify_cache table ready");
}
