/**
 * Memory Source Adapters
 *
 * Phase 1 of the unified memory architecture (see
 * winston-unified-memory-architecture.md). A shared interface every domain's
 * data implements, so the connection engine (and anything else that needs
 * cross-domain awareness) reads through one registry instead of hand-wired
 * per-domain calls.
 *
 * Pure refactor — this phase wraps the two sources that already work
 * (life_captures, attic_items) as adapters with ZERO behavior change. The
 * adapters are thin pass-throughs to the existing manager functions; nothing
 * about what the connection engine sees or does changes yet. This only
 * proves the abstraction holds before Lists/Goals/Chat get added on top of
 * it in later phases.
 *
 * Domain tables stay exactly as they are and stay authoritative — this file
 * owns no storage of its own, only the read-side normalization that used to
 * live inline in connectionEngineManager.ts's fetchSourceItems.
 */

import { getRecentCaptures } from "../lifeCaptures/lifeCapturesManager.js";
import { getRecentAtticItems } from "../attic/atticItemsManager.js";

// ── Types ─────────────────────────────────────────────────────────────────────

// 'life_capture' | 'attic_item' today; a new domain (Lists in Phase 2, Goals'
// StandingContextAdapter variant in Phase 3, chat-fact in Phase 4) extends
// this union and registers below — the passes never need to change to see it.
export type SourceType = "life_capture" | "attic_item";

export interface SourceItem {
  sourceType: SourceType;
  sourceId:   number;
  content:    string;
  context:    string;
  occurredAt: string;
}

// For domains that are a recency-sorted stream of dated events — the only
// shape Phase 1 needs. StandingContextAdapter (for domains like Goals that
// are a small current set, not a stream) is intentionally deferred to
// Phase 3, when Goals actually moves onto this registry — no speculative
// interface for a caller that doesn't exist yet.
export interface MemorySourceAdapter {
  sourceType: SourceType;
  fetchRecent(userName: string, days: number): Promise<SourceItem[]>;
}

// ── Adapters ──────────────────────────────────────────────────────────────────
// Each one is a pure reshape of its domain's existing query into SourceItem —
// same field mapping fetchSourceItems already did inline, moved here
// verbatim. No new queries, no new judgment, nothing that wasn't already
// happening.

export const lifeCaptureAdapter: MemorySourceAdapter = {
  sourceType: "life_capture",
  async fetchRecent(userName: string, days: number): Promise<SourceItem[]> {
    const captures = await getRecentCaptures(userName, days);
    return captures.map((c) => ({
      sourceType: "life_capture" as const,
      sourceId:   c.id,
      content:    c.content,
      context:    c.context,
      occurredAt: c.captured_at,
    }));
  },
};

export const atticItemAdapter: MemorySourceAdapter = {
  sourceType: "attic_item",
  async fetchRecent(userName: string, days: number): Promise<SourceItem[]> {
    const atticItems = await getRecentAtticItems(userName, days);
    return atticItems.map((it) => ({
      sourceType: "attic_item" as const,
      sourceId:   it.id,
      content:    it.raw_content,
      context:    it.source_type,
      occurredAt: it.created_at,
    }));
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────
// Adding a new domain later means writing one adapter and adding one line
// here — the passes in connectionEngineManager.ts iterate this map and never
// need to know which domains exist.

const registry = new Map<SourceType, MemorySourceAdapter>([
  [lifeCaptureAdapter.sourceType, lifeCaptureAdapter],
  [atticItemAdapter.sourceType, atticItemAdapter],
]);

// ── Fetch across adapters ────────────────────────────────────────────────────
// Same body as the old fetchSourceItems: fetch each requested source type
// through its adapter, concatenate, sort by recency. connectionEngineManager
// .ts's fetchSourceItems becomes a one-line call to this.

export async function fetchFromAdapters(
  userName:    string,
  sourceTypes: SourceType[],
  days:        number,
): Promise<SourceItem[]> {
  const items: SourceItem[] = [];

  for (const sourceType of sourceTypes) {
    const adapter = registry.get(sourceType);
    if (!adapter) continue; // unregistered source type — no-op, not an error
    const fetched = await adapter.fetchRecent(userName, days);
    items.push(...fetched);
  }

  items.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  return items;
}
