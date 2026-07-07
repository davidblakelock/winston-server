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

// ── Text cache — stores the generated briefing text for follow-up context ─────
// In-memory for speed; also persisted to DB so it survives server restarts.

interface BriefingEntry {
  text: string;
  generatedAt: number;
  dateKey: string;
}

const _textCache = new Map<string, BriefingEntry>();
// 20-hour window covers any realistic usage pattern in a day.
// The dateKey check is the primary guard — this is a belt-and-suspenders
// backstop so a briefing never survives into the next morning.
const TEXT_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export function getCachedBriefing(userName: string): string | null {
  const entry = _textCache.get(userName);
  if (!entry) return null;
  if (entry.dateKey !== ctDateKey()) { _textCache.delete(userName); return null; }
  if (Date.now() - entry.generatedAt > TEXT_MAX_AGE_MS) { _textCache.delete(userName); return null; }
  return entry.text;
}

/**
 * Returns the cached briefing only if it was generated within maxAgeMs milliseconds.
 * Used by the native path to skip regeneration on rapid successive calls (e.g. app restart,
 * background refresh). Default: 15 minutes.
 */
export function getCachedBriefingIfRecent(userName: string, maxAgeMs = 15 * 60 * 1000): string | null {
  const entry = _textCache.get(userName);
  if (!entry) return null;
  if (entry.dateKey !== ctDateKey()) { _textCache.delete(userName); return null; }
  if (Date.now() - entry.generatedAt > maxAgeMs) return null;
  return entry.text;
}

export function setCachedBriefing(userName: string, text: string, explicitDateKey?: string): void {
  const dateKey = explicitDateKey ?? ctDateKey();
  _textCache.set(userName, { text, generatedAt: Date.now(), dateKey });
  // Persist so the web "already loaded" endpoint can return it after a restart
  query(
    `INSERT INTO morning_static_context (user_name, date_key, briefing_text)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_name, date_key) DO UPDATE
       SET briefing_text = EXCLUDED.briefing_text
     RETURNING user_name`,
    [userName, dateKey, text]
  ).catch((err: unknown) => {
    console.warn("[BriefingCache] Failed to persist briefing text to DB:", err);
  });
}

export function clearCachedBriefing(userName: string): void {
  _textCache.delete(userName);
}

// ── Push-sent tracking — survives server restarts ──────────────────────────────

const _pushSentDone = new Map<string, string>(); // userName → dateKey

export async function markPushSent(userName: string): Promise<void> {
  const dateKey = ctDateKey();
  _pushSentDone.set(userName, dateKey);
  try {
    await query(
      `INSERT INTO morning_static_context (user_name, date_key, push_sent_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_name, date_key) DO UPDATE
         SET push_sent_at = NOW()
       RETURNING user_name`,
      [userName, dateKey]
    );
  } catch (err) {
    console.warn("[BriefingCache] Failed to persist push_sent_at:", err);
  }
}

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

// ── Retrieve persisted briefing text from DB (for "already loaded" endpoint) ──

export async function getPersistedBriefingText(userName: string): Promise<string | null> {
  const summary = await getPersistedBriefingSummary(userName);
  return summary?.text ?? null;
}

/**
 * Returns { text, generatedAt } for today's briefing, pulling from in-memory
 * cache first and falling back to DB. Returns null if no briefing exists today.
 */
export async function getPersistedBriefingSummary(
  userName: string
): Promise<{ text: string; generatedAt: Date } | null> {
  // Check in-memory first
  const entry = _textCache.get(userName);
  if (entry && entry.dateKey === ctDateKey()) {
    const ageMs = Date.now() - entry.generatedAt;
    if (ageMs <= TEXT_MAX_AGE_MS) {
      return { text: entry.text, generatedAt: new Date(entry.generatedAt) };
    }
    _textCache.delete(userName);
  }

  // Fall back to DB
  const today = ctDateKey();
  try {
    const res = await query<{ briefing_text: string | null; built_at: string }>(
      `SELECT briefing_text, built_at FROM morning_static_context
        WHERE user_name = $1 AND date_key = $2
        LIMIT 1`,
      [userName, today]
    );
    const row = res.rows[0];
    if (!row?.briefing_text) return null;

    // Restore to in-memory cache
    const builtAt = new Date(row.built_at).getTime();
    _textCache.set(userName, { text: row.briefing_text, generatedAt: builtAt, dateKey: today });
    return { text: row.briefing_text, generatedAt: new Date(row.built_at) };
  } catch {
    return null;
  }
}

// ── Static context cache — stores pre-built system prompt halves ──────────────

export interface StaticContextEntry {
  preamble: string;
  suffix: string;
  candidateStoryKeys: string[];
  dateKey: string;
  builtAt: number;
}

const _staticCtxCache = new Map<string, StaticContextEntry>();
const STATIC_MAX_AGE_MS = 10 * 60 * 60 * 1000;

export function getStaticBriefingContext(userName: string): StaticContextEntry | null {
  const entry = _staticCtxCache.get(userName);
  if (!entry) return null;
  if (entry.dateKey !== ctDateKey()) { _staticCtxCache.delete(userName); return null; }
  if (Date.now() - entry.builtAt > STATIC_MAX_AGE_MS) { _staticCtxCache.delete(userName); return null; }
  return entry;
}

export function setStaticBriefingContext(userName: string, entry: StaticContextEntry): void {
  _staticCtxCache.set(userName, entry);
  query(
    `INSERT INTO morning_static_context
       (user_name, date_key, preamble, suffix, candidate_story_keys, built_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_name, date_key) DO UPDATE
       SET preamble = EXCLUDED.preamble,
           suffix = EXCLUDED.suffix,
           candidate_story_keys = EXCLUDED.candidate_story_keys,
           built_at = NOW()
     RETURNING user_name`,
    [userName, entry.dateKey, entry.preamble, entry.suffix, JSON.stringify(entry.candidateStoryKeys)]
  ).catch((err: unknown) => {
    console.warn("[BriefingCache] Failed to persist static context to DB:", err);
  });
}

export function clearStaticBriefingContext(userName: string): void {
  _staticCtxCache.delete(userName);
}

/**
 * Returns true if the given UTC timestamp was built during the legitimate morning
 * pre-generation window (05:00–07:30 CT). Briefings built outside this window
 * (e.g. a midnight server-restart pre-gen or a late-night chat "good morning")
 * should NOT be served as the push-notification briefing — they contain stale
 * overnight news and will have been generated before the Apify morning actors ran.
 */
function isBuiltInMorningWindow(builtAtMs: number): boolean {
  const hourCT = parseInt(
    new Date(builtAtMs).toLocaleTimeString("en-US", {
      timeZone: "America/Chicago", // Server process is in CT — briefing generation window
      hour: "2-digit",
      hour12: false,
    }),
    10
  );
  // 05:00–07:29 CT covers the scheduled pre-gen window (5:40 AM) with buffer
  return hourCT >= 5 && hourCT < 8;
}

/**
 * Attempts to load today's static context (and push-sent state) from the DB
 * into the in-memory caches. Returns true if a valid entry was found.
 *
 * Push-sent state is ALWAYS restored (so we never double-send after a restart).
 * Static context and briefing text are only restored if they were built during
 * the legitimate morning window (05:00–07:59 CT) — this prevents a midnight
 * startup pre-gen from being served as the morning briefing hours later.
 */
export async function loadStaticContextFromDb(userName: string): Promise<boolean> {
  const today = ctDateKey();
  try {
    const res = await query<{
      preamble: string;
      suffix: string;
      candidate_story_keys: string[];
      built_at: string;
      push_sent_at: string | null;
      briefing_text: string | null;
    }>(
      `SELECT preamble, suffix, candidate_story_keys, built_at, push_sent_at, briefing_text
         FROM morning_static_context
        WHERE user_name = $1 AND date_key = $2
        LIMIT 1`,
      [userName, today]
    );
    const row = res.rows[0];
    if (!row) return false;

    // ALWAYS restore push-sent state — this prevents double-sending regardless
    // of whether the briefing content itself is considered fresh.
    if (row.push_sent_at) {
      const sentDate = new Date(row.push_sent_at).toLocaleDateString("en-CA", { timeZone: "UTC" });
      if (sentDate === today) {
        _pushSentDone.set(userName, today);
        console.log(`[BriefingCache] Push already sent today for ${userName} — restored from DB`);
      }
    }

    // Preamble/suffix are NULLed by /api/briefing/refresh to force re-generation.
    // Treat a null preamble as a cache miss so the morning briefing re-generates fresh.
    if (!row.preamble || !row.suffix) return false;

    const builtAt = new Date(row.built_at).getTime();
    if (Date.now() - builtAt > STATIC_MAX_AGE_MS) return false;

    // Reject briefings built outside the 05:00–07:59 CT morning window.
    // A server restart at midnight triggers an immediate pre-gen with overnight
    // news; that stale content must not be cached as the morning briefing.
    // The morning scheduler will regenerate fresh content at 05:40 CT.
    if (!isBuiltInMorningWindow(builtAt)) {
      console.log(`[BriefingCache] Briefing for ${userName} built outside morning window (${new Date(builtAt).toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false })} UTC) — discarding content, will regenerate`);
      return false;
    }

    // Invalidate cached context that was built before weather was removed from
    // the briefing. If the suffix still contains a [VERIFIED — Google Weather API]
    // block, the entry is stale and must be regenerated with the current code.
    if (row.suffix?.includes("[VERIFIED — Google Weather API")) {
      console.log(`[BriefingCache] Stale cached context for ${userName} contains weather block — discarding and regenerating`);
      return false;
    }

    _staticCtxCache.set(userName, {
      preamble: row.preamble,
      suffix: row.suffix,
      candidateStoryKeys: Array.isArray(row.candidate_story_keys) ? row.candidate_story_keys : [],
      dateKey: today,
      builtAt,
    });

    // Restore briefing text if present
    if (row.briefing_text) {
      _textCache.set(userName, { text: row.briefing_text, generatedAt: builtAt, dateKey: today });
      console.log(`[BriefingCache] Briefing text restored from DB for ${userName}`);
    }

    console.log(`[BriefingCache] Loaded today's static context from DB for ${userName} — skipping pre-generation`);
    return true;
  } catch (err) {
    console.warn("[BriefingCache] Could not load static context from DB:", err);
    return false;
  }
}
