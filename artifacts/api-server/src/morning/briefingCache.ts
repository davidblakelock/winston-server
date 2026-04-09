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
}

export function clearStaticBriefingContext(userName: string): void {
  _staticCtxCache.delete(userName);
}
