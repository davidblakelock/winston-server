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
  const existing = await query(
    `SELECT id, show_name FROM watched_shows WHERE user_name = $1 AND lower(show_name) = lower($2)`,
    [userName, rawName]
  );
  if (existing.rows.length > 0) {
    return { success: false, showName: existing.rows[0].show_name, alreadyExists: true };
  }

  const tvShow = await searchShow(rawName);
  const showName = tvShow?.name ?? rawName;

  await query(
    `INSERT INTO watched_shows (user_name, show_name, tvmaze_id, network, genres, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_name, show_name) DO NOTHING`,
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
      message.match(/(?:i\s+picked\s+up|i\s+started)\s+(.+?)(?:\s*[.!,]|$)/i);
  } else {
    match =
      message.match(/(?:i\s+finished|i\s+stopped\s+watching|i'?m\s+done\s+with|done\s+watching|finished\s+watching)\s+(.+?)(?:\s*[.!,]|$)/i) ??
      message.match(/remove\s+(.+?)\s+from\s+my\s+(?:shows?|watch\s+list)/i);
  }

  return match?.[1]?.trim() ?? null;
}
