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

import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getRecentCaptures } from "../lifeCaptures/lifeCapturesManager.js";
import { getRecentAtticItems } from "../attic/atticItemsManager.js";
import { getRecentListItems } from "../lists/listManager.js";
import { getRecentChatFacts } from "../memory/memoryManager.js";

// ── Types ─────────────────────────────────────────────────────────────────────

// 'life_capture' | 'attic_item' | 'list_item' | 'chat_fact' now (Phase 2 added
// Lists, Phase 4a added chat-fact). Goals' StandingContextAdapter variant
// lives separately (Phase 3, standingContextAdapters.ts) since it's a
// standing set, not a stream — extend this union and register below for
// anything else that IS a recency-sorted stream.
export type SourceType = "life_capture" | "attic_item" | "list_item" | "chat_fact";

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

export const listItemAdapter: MemorySourceAdapter = {
  sourceType: "list_item",
  async fetchRecent(userName: string, days: number): Promise<SourceItem[]> {
    const listItems = await getRecentListItems(userName, days);
    return listItems.map((it) => ({
      sourceType: "list_item" as const,
      sourceId:   it.id,
      content:    it.item_text,
      context:    it.list_name,
      occurredAt: it.created_at,
    }));
  },
};

export const chatFactAdapter: MemorySourceAdapter = {
  sourceType: "chat_fact",
  async fetchRecent(userName: string, days: number): Promise<SourceItem[]> {
    const chatFacts = await getRecentChatFacts(userName, days);
    return chatFacts.map((cf) => ({
      sourceType: "chat_fact" as const,
      sourceId:   cf.id,
      content:    cf.content,
      context:    "chat",
      occurredAt: cf.created_at,
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
  [listItemAdapter.sourceType, listItemAdapter],
  [chatFactAdapter.sourceType, chatFactAdapter],
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

// ── user_corrections (Phase 3) ───────────────────────────────────────────────
// Feedback rows referenced by any domain's reasoning — connectionEngineManager
// .ts's three passes, and now goalsManager.ts too — so this table's ownership
// moved here from connectionEngineManager.ts's shared _tableInit (which
// previously created connections/observations/user_corrections together).
// connectionEngineManager.ts now awaits ensureUserCorrectionsTable before its
// own INSERT (applyObservationCorrection) instead of creating this table
// itself.

// .catch() added after a confirmed live crash caused by the same unguarded-IIFE
// pattern in listManager.ts (see its comment) — an uncaught rejection here at
// module-load time would crash the whole Node process, not just this table's init.
export const ensureUserCorrectionsTable = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS user_corrections (
      id                        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name                 text NOT NULL,
      correction_type           text NOT NULL,
      affected_item_ids         integer[] NOT NULL DEFAULT '{}',
      natural_language_feedback text NOT NULL,
      created_at                timestamptz NOT NULL DEFAULT now()
    )
  `);
})().catch((err) => logger.error({ err }, "[MemorySourceAdapters] user_corrections table init failed"));

export interface UserCorrection {
  id:                        number;
  user_name:                 string;
  correction_type:           string;
  affected_item_ids:         number[];
  natural_language_feedback: string;
  created_at:                string;
}

export async function getRecentCorrections(
  userName: string,
  days      = 30,
): Promise<UserCorrection[]> {
  await ensureUserCorrectionsTable;
  const { rows } = await query<UserCorrection>(
    `SELECT * FROM user_corrections
     WHERE user_name = $1 AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

// ── Shared item formatting (Phase 3) ─────────────────────────────────────────
// Moved verbatim from connectionEngineManager.ts — pure functions, no table
// or domain coupling. goalsManager.ts needs formatItemLines directly now;
// connectionEngineManager.ts re-imports recencyLabel for its own passes'
// indexed formatting (formatIndexedItemLines stays local to that file).

export function recencyLabel(occurredAt: string): string {
  const daysAgo = Math.floor((Date.now() - new Date(occurredAt).getTime()) / 86_400_000);
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return `${daysAgo} days ago`;
  const weeks = Math.round(daysAgo / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

export function formatItemLines(items: SourceItem[], tz: string, limit: number): string {
  return items
    .slice(0, limit)
    .map((it) => {
      const date = new Date(it.occurredAt).toLocaleDateString("en-US", {
        timeZone: tz, month: "short", day: "numeric",
      });
      return `• [${date}, ${recencyLabel(it.occurredAt)}, ${it.context}] ${it.content}`;
    })
    .join("\n");
}
