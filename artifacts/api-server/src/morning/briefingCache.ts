import { query } from "../db.js";

function ctDateKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// ── Text cache — stores the generated briefing text for follow-up context ─────

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
  _textCache.set(userName, { text, generatedAt: Date.now(), dateKey: explicitDateKey ?? ctDateKey() });
}

export function clearCachedBriefing(userName: string): void {
  _textCache.delete(userName);
}

// ── Static context cache — stores pre-built system prompt halves ──────────────
//
// The pre-generation at 5 AM fetches all static data (news, weather, sports,
// bills, Dallas, etc.) and splits the system prompt into two halves:
//
//   preamble — everything before the email + calendar slot
//   suffix   — everything after the calendar slot, through MASTER_BRIEFING_INSTRUCTION
//
// At delivery time the live email block and live calendar block are slotted in
// between preamble and suffix, and Claude generates the final briefing.
//
// Both the in-memory Map and the morning_static_context DB table are used.
// In-memory is the fast path; DB is the authoritative source that survives
// server restarts so we never regenerate an already-built briefing.

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
  // Persist to DB so restarts don't blow away the cache and trigger a full
  // re-generation with all its expensive web_search calls.
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
 * Attempts to load today's static context from the DB into the in-memory cache.
 * Returns true if a valid entry was found and loaded, false otherwise.
 * Call this on startup before deciding whether to trigger pre-generation.
 */
export async function loadStaticContextFromDb(userName: string): Promise<boolean> {
  const today = ctDateKey();
  try {
    const res = await query<{
      preamble: string;
      suffix: string;
      candidate_story_keys: string[];
      built_at: string;
    }>(
      `SELECT preamble, suffix, candidate_story_keys, built_at
         FROM morning_static_context
        WHERE user_name = $1 AND date_key = $2
        LIMIT 1`,
      [userName, today]
    );
    const row = res.rows[0];
    if (!row) return false;

    const builtAt = new Date(row.built_at).getTime();
    if (Date.now() - builtAt > STATIC_MAX_AGE_MS) return false;

    _staticCtxCache.set(userName, {
      preamble: row.preamble,
      suffix: row.suffix,
      candidateStoryKeys: Array.isArray(row.candidate_story_keys) ? row.candidate_story_keys : [],
      dateKey: today,
      builtAt,
    });
    console.log(`[BriefingCache] Loaded today's static context from DB for ${userName} — skipping pre-generation`);
    return true;
  } catch (err) {
    console.warn("[BriefingCache] Could not load static context from DB:", err);
    return false;
  }
}
