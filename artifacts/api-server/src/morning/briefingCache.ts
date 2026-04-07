interface BriefingEntry {
  text: string;
  generatedAt: number;
  dateKey: string;
}

const _cache = new Map<string, BriefingEntry>();
const MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours max — but date key is the primary guard

function ctDateKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
}

export function getCachedBriefing(userName: string): string | null {
  const entry = _cache.get(userName);
  if (!entry) return null;

  // Invalidate if it was generated on a different calendar day (CT)
  if (entry.dateKey !== ctDateKey()) {
    _cache.delete(userName);
    return null;
  }

  // Also invalidate if older than 8 hours (safety net)
  if (Date.now() - entry.generatedAt > MAX_AGE_MS) {
    _cache.delete(userName);
    return null;
  }

  return entry.text;
}

// explicitDateKey must be passed as the CT date captured at the START of generation,
// not computed here at completion time. This prevents a midnight race condition where
// generation begins on April 6 but finishes after midnight and would otherwise be
// stamped with April 7's key while containing April 6 calendar data.
export function setCachedBriefing(userName: string, text: string, explicitDateKey?: string): void {
  _cache.set(userName, { text, generatedAt: Date.now(), dateKey: explicitDateKey ?? ctDateKey() });
}

export function clearCachedBriefing(userName: string): void {
  _cache.delete(userName);
}
