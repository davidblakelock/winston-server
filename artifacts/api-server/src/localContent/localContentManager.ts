/**
 * localContentManager.ts
 * DB read/write for the local_content_items table.
 * City-agnostic — works for any city the user happens to be in.
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface LocalContentItem {
  id: number;
  userName: string;
  category: string;
  headline: string;
  summary: string | null;
  url: string | null;
  city: string;
  eventDate: string | null;   // YYYY-MM-DD
  relevanceScore: number;
  notifiedAt: Date | null;
  seenAt: Date | null;
  expiresAt: string;          // YYYY-MM-DD
  source: string | null;
  createdAt: Date;
}

export interface NewLocalContentItem {
  userName: string;
  category: string;
  headline: string;
  summary?: string | null;
  url?: string | null;
  city: string;
  eventDate?: string | null;
  relevanceScore: number;
  expiresAt: string;
  source?: string | null;
}

/**
 * Insert a new local content item, skipping duplicates.
 * Deduplication key: (user_name, headline, city) — same headline in same city = skip.
 */
export async function insertLocalContentItem(item: NewLocalContentItem): Promise<number | null> {
  try {
    const result = await query<{ id: number }>(
      `INSERT INTO local_content_items
         (user_name, category, headline, summary, url, city,
          event_date, relevance_score, expires_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        item.userName, item.category, item.headline,
        item.summary ?? null, item.url ?? null, item.city,
        item.eventDate ?? null, item.relevanceScore,
        item.expiresAt, item.source ?? null,
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err, headline: item.headline }, "[LocalContent] Insert failed");
    return null;
  }
}

/**
 * Get items that are ready to be notified:
 * - Not yet notified (notified_at IS NULL)
 * - Not expired
 * - Above relevance threshold
 * - For this user
 */
export async function getPendingNotifications(
  userName: string,
  minScore = 70
): Promise<LocalContentItem[]> {
  const { rows } = await query<{
    id: number; user_name: string; category: string; headline: string;
    summary: string | null; url: string | null; city: string;
    event_date: string | null; relevance_score: number;
    notified_at: Date | null; seen_at: Date | null;
    expires_at: string; source: string | null; created_at: Date;
  }>(
    `SELECT * FROM local_content_items
     WHERE user_name = $1
       AND notified_at IS NULL
       AND expires_at >= CURRENT_DATE
       AND relevance_score >= $2
     ORDER BY relevance_score DESC, created_at DESC
     LIMIT 5`,
    [userName, minScore]
  );

  return rows.map(r => ({
    id: r.id,
    userName: r.user_name,
    category: r.category,
    headline: r.headline,
    summary: r.summary,
    url: r.url,
    city: r.city,
    eventDate: r.event_date,
    relevanceScore: r.relevance_score,
    notifiedAt: r.notified_at,
    seenAt: r.seen_at,
    expiresAt: r.expires_at,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/**
 * Mark an item as notified.
 */
export async function markNotified(id: number): Promise<void> {
  await query(
    `UPDATE local_content_items SET notified_at = NOW() WHERE id = $1`,
    [id]
  );
}

/**
 * Mark an item as seen (user tapped the notification).
 */
export async function markSeen(id: number): Promise<void> {
  await query(
    `UPDATE local_content_items SET seen_at = NOW() WHERE id = $1`,
    [id]
  );
}

/**
 * Delete expired items older than 7 days past expiry — periodic cleanup.
 */
export async function cleanupExpiredItems(userName: string): Promise<void> {
  await query(
    `DELETE FROM local_content_items
     WHERE user_name = $1
       AND expires_at < CURRENT_DATE - INTERVAL '7 days'`,
    [userName]
  ).catch(() => {});
}

/**
 * Check if we've already scanned this city for this user today.
 * Prevents re-scanning multiple times per day.
 */
export async function hasScannedTodayForCity(
  userName: string,
  city: string
): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM local_content_items
     WHERE user_name = $1
       AND city = $2
       AND created_at >= NOW() - INTERVAL '8 hours'`,
    [userName, city]
  );
  return parseInt(rows[0]?.count ?? "0", 10) > 0;
}
