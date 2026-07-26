import { query } from "../db.js";

function ctDateKey(tz = "UTC"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// ── Startup migrations ─────────────────────────────────────────────────────────
// Idempotent — safe to run on every server start.

export async function runBriefingCacheMigrations(): Promise<void> {
  // Create the table if it doesn't exist (idempotent).
  // UNIQUE constraint is a separate index to avoid exec_sql parse issues on Supabase.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS morning_static_context (
        user_name             text NOT NULL,
        date_key              text NOT NULL,
        preamble              text,
        suffix                text,
        candidate_story_keys  jsonb,
        built_at              timestamptz NOT NULL DEFAULT NOW(),
        push_sent_at          timestamptz,
        briefing_text         text
      )
    `);
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS morning_static_context_pk
       ON morning_static_context (user_name, date_key)`
    );
    console.log("[BriefingCache] morning_static_context table ready");
  } catch (err) {
    console.warn("[BriefingCache] morning_static_context table creation warning:", err);
  }

  // Add columns that may be missing on older deployments (idempotent).
  try {
    await query(`ALTER TABLE morning_static_context ADD COLUMN IF NOT EXISTS push_sent_at timestamptz`);
    await query(`ALTER TABLE morning_static_context ADD COLUMN IF NOT EXISTS briefing_text text`);
    console.log("[BriefingCache] Startup migrations complete");
  } catch (err) {
    console.warn("[BriefingCache] Startup migration warning:", err);
  }

  // Drop NOT NULL constraints on preamble/suffix — older deployments created the table
  // with NOT NULL which causes the briefing_text-only INSERT in setCachedBriefing to fail,
  // breaking the "briefing doesn't change during the day" guarantee after server restarts.
  try {
    await query(`ALTER TABLE morning_static_context ALTER COLUMN preamble DROP NOT NULL`);
    await query(`ALTER TABLE morning_static_context ALTER COLUMN suffix DROP NOT NULL`);
    console.log("[BriefingCache] preamble/suffix NOT NULL constraints dropped (idempotent)");
  } catch (err) {
    console.warn("[BriefingCache] Could not drop NOT NULL constraints (may already be nullable):", err);
  }
}

// ── Push-sent tracking — survives server restarts ──────────────────────────────

const _pushSentDone = new Map<string, string>(); // userName → dateKey

export function wasPushSentToday(userName: string): boolean {
  return _pushSentDone.get(userName) === ctDateKey();
}

/**
 * Atomically claim the morning push send slot for this user+day.
 * Returns true if THIS process should send the push, false if another process
 * (or a previous restart) already sent it.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE WHERE push_sent_at IS NULL — only one
 * process across an autoscale cluster can win the RETURNING row.
 */
export async function claimMorningPushSlot(userName: string): Promise<boolean> {
  const dateKey = ctDateKey();

  // Fast path: in-memory already set (single-process restarts won't re-send)
  if (wasPushSentToday(userName)) return false;

  try {
    // Atomic claim: the UPDATE only fires when push_sent_at is still NULL.
    // RETURNING returns a row only if we actually inserted or updated —
    // so exactly one process wins across the autoscale cluster.
    const { rows } = await query<{ user_name: string }>(
      `INSERT INTO morning_static_context (user_name, date_key, push_sent_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_name, date_key) DO UPDATE
         SET push_sent_at = NOW()
       WHERE morning_static_context.push_sent_at IS NULL
       RETURNING user_name`,
      [userName, dateKey]
    );
    if (rows.length > 0) {
      _pushSentDone.set(userName, dateKey);
      return true; // We won the claim
    }
    // Another process already claimed it
    _pushSentDone.set(userName, dateKey);
    return false;
  } catch {
    // Table not yet created — fall back to non-atomic in-memory only.
    // Will be correct for single-process deployments; multi-process may double-send
    // until the table is created on next restart.
    if (!wasPushSentToday(userName)) {
      _pushSentDone.set(userName, dateKey);
      return true;
    }
    return false;
  }
}

/**
 * Release a previously claimed morning push slot so the scheduler can retry.
 * Called when the push send fails (network error, TLS drop, etc.) so the next
 * scheduler tick will attempt to send again instead of silently giving up.
 */
export async function releaseMorningPushSlot(userName: string): Promise<void> {
  const dateKey = ctDateKey();
  _pushSentDone.delete(userName);
  try {
    await query(
      `UPDATE morning_static_context
          SET push_sent_at = NULL
        WHERE user_name = $1 AND date_key = $2`,
      [userName, dateKey]
    );
  } catch {
    // Best-effort — if DB update fails the in-memory flag is already cleared
    // so the next tick will try again (may double-send on multi-process, acceptable)
  }
}

/**
 * Restores today's push-sent state from the DB into the in-memory cache, so a
 * server restart doesn't cause a duplicate morning push. This is the only
 * thing still read from morning_static_context — the preamble/suffix/
 * briefing_text columns and the static-context/text caches that used to back
 * the old pre-generation pipeline were retired along with it (generateDailyBrief()
 * is the only morning-briefing path now; it doesn't read or write this cache).
 */
export async function loadStaticContextFromDb(userName: string): Promise<boolean> {
  const today = ctDateKey();
  try {
    const res = await query<{ push_sent_at: string | null }>(
      `SELECT push_sent_at FROM morning_static_context
        WHERE user_name = $1 AND date_key = $2
        LIMIT 1`,
      [userName, today]
    );
    const row = res.rows[0];
    if (!row?.push_sent_at) return false;

    const sentDate = new Date(row.push_sent_at).toLocaleDateString("en-CA", { timeZone: "UTC" });
    if (sentDate === today) {
      _pushSentDone.set(userName, today);
      console.log(`[BriefingCache] Push already sent today for ${userName} — restored from DB`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[BriefingCache] Could not load push-sent state from DB:", err);
    return false;
  }
}
