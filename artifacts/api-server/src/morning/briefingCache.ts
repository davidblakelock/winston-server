import { query } from "../db.js";

function ctDateKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// ── Startup migrations ─────────────────────────────────────────────────────────
// Idempotent — safe to run on every server start.

export async function runBriefingCacheMigrations(): Promise<void> {
  try {
    await query(`ALTER TABLE morning_static_context ADD COLUMN IF NOT EXISTS push_sent_at timestamptz`);
    await query(`ALTER TABLE morning_static_context ADD COLUMN IF NOT EXISTS briefing_text text`);
    console.log("[BriefingCache] Startup migrations complete");
  } catch (err) {
    console.warn("[BriefingCache] Startup migration warning:", err);
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
const TEXT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export function getCachedBriefing(userName: string): string | null {
  const entry = _textCache.get(userName);
  if (!entry) return null;
  if (entry.dateKey !== ctDateKey()) { _textCache.delete(userName); return null; }
  if (Date.now() - entry.generatedAt > TEXT_MAX_AGE_MS) { _textCache.delete(userName); return null; }
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

// ── Retrieve persisted briefing text from DB (for "already loaded" endpoint) ──

export async function getPersistedBriefingText(userName: string): Promise<string | null> {
  // Check in-memory first
  const mem = getCachedBriefing(userName);
  if (mem) return mem;

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
    return row.briefing_text;
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
 * Attempts to load today's static context (and push-sent state) from the DB
 * into the in-memory caches. Returns true if a valid entry was found.
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

    // Preamble/suffix are NULLed by /api/briefing/refresh to force re-generation.
    // Treat a null preamble as a cache miss so the morning briefing re-generates fresh.
    if (!row.preamble || !row.suffix) return false;

    const builtAt = new Date(row.built_at).getTime();
    if (Date.now() - builtAt > STATIC_MAX_AGE_MS) return false;

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

    // Restore push-sent state so we don't re-send after a restart
    if (row.push_sent_at) {
      const sentDate = new Date(row.push_sent_at).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      if (sentDate === today) {
        _pushSentDone.set(userName, today);
        console.log(`[BriefingCache] Push already sent today for ${userName} — restored from DB`);
      }
    }

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
