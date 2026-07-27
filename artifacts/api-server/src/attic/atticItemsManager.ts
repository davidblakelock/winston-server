/**
 * Attic Items — storage only.
 *
 * This is just the table and a read accessor so the connection engine has a
 * real second source to query. Capture (trigger phrases, email-forward
 * parsing, the actual insert path) is Phase 1 of the Attic build and is not
 * implemented here — this table will sit empty until that ships.
 *
 * Table:
 *   attic_items — id, user_name, source_type, raw_content, raw_url,
 *                 source_metadata, status, created_at, updated_at
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Table init ────────────────────────────────────────────────────────────────

const _tableInit = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS attic_items (
      id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name       text NOT NULL,
      source_type     text NOT NULL,
      raw_content     text NOT NULL,
      raw_url         text,
      source_metadata jsonb NOT NULL DEFAULT '{}',
      status          text NOT NULL DEFAULT 'active',
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `).catch((err) => logger.error({ err }, "[AtticItems] Table init failed"));

  await query(`
    CREATE INDEX IF NOT EXISTS attic_items_user_created_idx ON attic_items (user_name, created_at DESC)
  `).catch((err) => logger.error({ err }, "[AtticItems] Index init failed"));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export type AtticSourceType =
  | "voice" | "text" | "email_forward" | "url"
  | "screenshot" | "article" | "social_snippet" | "manual_entry";

export interface AtticItem {
  id:              number;
  user_name:       string;
  source_type:     AtticSourceType;
  raw_content:     string;
  raw_url:         string | null;
  source_metadata: Record<string, unknown>;
  status:          "active" | "archived" | "deleted";
  created_at:      string;
  updated_at:      string;
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function saveAtticItem(params: {
  userName:        string;
  sourceType:      AtticSourceType;
  rawContent:      string;
  rawUrl?:         string | null;
  sourceMetadata?: Record<string, unknown>;
}): Promise<AtticItem> {
  await _tableInit;
  const { userName, sourceType, rawContent, rawUrl = null, sourceMetadata = {} } = params;

  const { rows } = await query<AtticItem>(
    `INSERT INTO attic_items (user_name, source_type, raw_content, raw_url, source_metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userName, sourceType, rawContent.trim(), rawUrl, JSON.stringify(sourceMetadata)]
  );
  logger.info({ userName, sourceType, chars: rawContent.length }, "[AtticItems] Item saved");
  return rows[0]!;
}

// ── Query ─────────────────────────────────────────────────────────────────────

export async function getRecentAtticItems(
  userName: string,
  days      = 30,
): Promise<AtticItem[]> {
  await _tableInit;
  const { rows } = await query<AtticItem>(
    `SELECT * FROM attic_items
     WHERE user_name = $1
       AND status = 'active'
       AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

// ── Cleanup / archive ────────────────────────────────────────────────────────
// "Clean up the attic": age-based candidate selection + a pending-state
// confirmation flow, same pattern as pendingText/pendingEmailReply in
// textMessageComposer.ts / emailMeetingManager.ts. No AI call needed to pick
// candidates — age alone is a sufficient, cheap heuristic for v1.

export const DEFAULT_ARCHIVE_THRESHOLD_DAYS = 60;

export interface AtticArchiveCandidate {
  id:          number;
  sourceType:  AtticSourceType;
  rawContent:  string;
  createdAt:   string;
}

export interface PendingAtticCleanup {
  candidates:    AtticArchiveCandidate[];
  thresholdDays: number;
}

const _pendingCleanupMap = new Map<string, PendingAtticCleanup>();

export function getPendingAtticCleanup(userName: string): PendingAtticCleanup | null {
  return _pendingCleanupMap.get(userName) ?? null;
}

export function setPendingAtticCleanup(userName: string, state: PendingAtticCleanup | null): void {
  if (state === null) {
    _pendingCleanupMap.delete(userName);
  } else {
    _pendingCleanupMap.set(userName, state);
  }
}

export async function getArchiveCandidates(
  userName:      string,
  thresholdDays  = DEFAULT_ARCHIVE_THRESHOLD_DAYS,
): Promise<AtticArchiveCandidate[]> {
  await _tableInit;
  const { rows } = await query<{ id: number; source_type: AtticSourceType; raw_content: string; created_at: string }>(
    `SELECT id, source_type, raw_content, created_at FROM attic_items
     WHERE user_name = $1
       AND status = 'active'
       AND created_at < now() - ($2 || ' days')::interval
     ORDER BY created_at ASC`,
    [userName, thresholdDays.toString()]
  );
  return rows.map((r) => ({
    id: r.id, sourceType: r.source_type, rawContent: r.raw_content, createdAt: r.created_at,
  }));
}

export async function archiveAtticItems(userName: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  await _tableInit;
  const { rows } = await query<{ id: number }>(
    `UPDATE attic_items SET status = 'archived', updated_at = now()
     WHERE user_name = $1 AND id = ANY($2) AND status = 'active'
     RETURNING id`,
    [userName, ids]
  );
  logger.info({ userName, count: rows.length }, "[AtticItems] Items archived");
  return rows.length;
}
