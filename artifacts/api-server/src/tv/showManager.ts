import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { searchShow } from "./tvmaze.js";

export interface WatchedShow {
  id: number;
  showName: string;
  tvmazeId: number | null;
  network: string | null;
  genres: string | null;
  status: string | null;
}

export async function getWatchedShows(userName = NATIVE_STORED_NAME): Promise<WatchedShow[]> {
  const result = await query(
    `SELECT DISTINCT ON (lower(show_name)) id, show_name, tvmaze_id, network, genres, status
     FROM watched_shows
     WHERE user_name = $1
     ORDER BY lower(show_name) ASC, id ASC`,
    [userName]
  );
  return result.rows.map((r) => ({
    id: r.id,
    showName: r.show_name,
    tvmazeId: r.tvmaze_id ?? null,
    network: r.network ?? null,
    genres: r.genres ?? null,
    status: r.status ?? null,
  }));
}

export async function addWatchedShow(
  rawName: string,
  userName = NATIVE_STORED_NAME
): Promise<{ success: boolean; showName: string; alreadyExists: boolean }> {
  // Step 1: check by the raw name the user typed
  const existingByRaw = await query(
    `SELECT id, show_name FROM watched_shows WHERE user_name = $1 AND lower(show_name) = lower($2)`,
    [userName, rawName]
  );
  if (existingByRaw.rows.length > 0) {
    return { success: false, showName: existingByRaw.rows[0].show_name, alreadyExists: true };
  }

  // Step 2: look up TVmaze to get the canonical name + metadata
  const tvShow = await searchShow(rawName);
  const showName = tvShow?.name ?? rawName;

  // Step 3: also check by the canonical TVmaze name (catches "Lincoln Lawyer" vs "The Lincoln Lawyer")
  if (showName.toLowerCase() !== rawName.toLowerCase()) {
    const existingByCanonical = await query(
      `SELECT id, show_name FROM watched_shows WHERE user_name = $1 AND lower(show_name) = lower($2)`,
      [userName, showName]
    );
    if (existingByCanonical.rows.length > 0) {
      return { success: false, showName: existingByCanonical.rows[0].show_name, alreadyExists: true };
    }
  }

  // Step 4: also check by TVmaze ID if we have one (most reliable dedup)
  if (tvShow?.id) {
    const existingById = await query(
      `SELECT id, show_name FROM watched_shows WHERE user_name = $1 AND tvmaze_id = $2`,
      [userName, tvShow.id]
    );
    if (existingById.rows.length > 0) {
      return { success: false, showName: existingById.rows[0].show_name, alreadyExists: true };
    }
  }

  // Step 5: safe to insert
  await query(
    `INSERT INTO watched_shows (user_name, show_name, tvmaze_id, network, genres, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_name, show_name) DO NOTHING
     RETURNING id`,
    [
      userName,
      showName,
      tvShow?.id ?? null,
      tvShow?.network ?? null,
      tvShow?.genres?.join(", ") ?? null,
      tvShow?.status ?? null,
    ]
  );

  return { success: true, showName, alreadyExists: false };
}

// TVmaze ID is only resolved once, at add time (addWatchedShow above) — if
// that lookup fails for any reason (transient network blip, rate limit),
// the show is left with tvmaze_id = null permanently, since nothing ever
// retries it. tvEpisodeScheduler.ts silently drops any show with a null ID
// from its check, so a one-time failure meant that show could never be
// checked for new episodes again. This re-attempts the lookup for anything
// still unresolved — cheap to call on every scheduled check since it's a
// no-op once every show has an ID.
export async function backfillMissingTvmazeIds(userName = NATIVE_STORED_NAME): Promise<number> {
  const { rows } = await query<{ id: number; show_name: string }>(
    `SELECT id, show_name FROM watched_shows WHERE user_name = $1 AND tvmaze_id IS NULL`,
    [userName]
  );
  if (rows.length === 0) return 0;

  let resolved = 0;
  for (const row of rows) {
    const tvShow = await searchShow(row.show_name).catch(() => null);
    if (!tvShow?.id) continue;
    await query(
      `UPDATE watched_shows SET tvmaze_id = $1, network = $2, genres = $3, status = $4 WHERE id = $5`,
      [tvShow.id, tvShow.network, tvShow.genres.join(", ") || null, tvShow.status, row.id]
    ).catch(() => {});
    resolved++;
  }
  return resolved;
}

export async function removeWatchedShow(rawName: string, userName = NATIVE_STORED_NAME): Promise<string | null> {
  const result = await query(
    `DELETE FROM watched_shows
     WHERE user_name = $1 AND lower(show_name) LIKE lower($2)
     RETURNING show_name`,
    [userName, `%${rawName}%`]
  );
  return result.rows[0]?.show_name ?? null;
}

export function buildShowListBlock(shows: WatchedShow[]): string {
  if (shows.length === 0) return "No shows on the watch list.";
  return shows.map((s) => `• ${s.showName}${s.network ? ` (${s.network})` : ""}`).join("\n");
}

export function extractShowName(message: string, action: "add" | "remove"): string | null {
  let match: RegExpMatchArray | null = null;

  if (action === "add") {
    match =
      message.match(/(?:i\s+started\s+watching|i'?m\s+(?:now\s+)?watching|i\s+am\s+watching|started\s+watching)\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/add\s+(.+?)\s+to\s+my\s+(?:shows?|watch\s+list)/i) ??
      message.match(/(?:i\s+picked\s+up|i\s+just\s+started)\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/i'?m\s+(?:binging|binge\s+watching|checking\s+out|giving|trying)\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/i\s+(?:want(?:ed)?\s+to|decided\s+to|plan(?:ning)?\s+to|(?:am\s+)?going\s+to|about\s+to)\s+(?:start\s+)?watch(?:ing)?\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/i'?m\s+(?:going|planning)\s+to\s+(?:start\s+)?watch(?:ing)?\s+(.+?)(?:\s*[.!,]|$)/i);
  } else {
    match =
      message.match(/(?:i\s+finished|i\s+stopped\s+watching|i'?m\s+done\s+with|done\s+watching|finished\s+watching)\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/remove\s+(.+?)\s+from\s+my\s+(?:shows?|watch\s+list)/i);
  }

  return match?.[1]?.trim() ?? null;
}
