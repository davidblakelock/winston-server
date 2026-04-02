interface BriefingEntry {
  text: string;
  generatedAt: number;
}

const _cache = new Map<string, BriefingEntry>();
const TTL_MS = 10 * 60 * 60 * 1000; // 10 hours

export function getCachedBriefing(userName: string): string | null {
  const entry = _cache.get(userName);
  if (!entry) return null;
  if (Date.now() - entry.generatedAt > TTL_MS) {
    _cache.delete(userName);
    return null;
  }
  return entry.text;
}

export function setCachedBriefing(userName: string, text: string): void {
  _cache.set(userName, { text, generatedAt: Date.now() });
}
