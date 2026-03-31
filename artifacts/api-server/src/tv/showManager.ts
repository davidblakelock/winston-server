import { query } from "../db.js";
import { searchShow } from "./tvmaze.js";

export interface WatchedShow {
  id: number;
  showName: string;
  tvmazeId: number | null;
  network: string | null;
  genres: string | null;
  status: string | null;
}

export async function getWatchedShows(): Promise<WatchedShow[]> {
  const result = await query(
    `SELECT id, show_name, tvmaze_id, network, genres, status
     FROM watched_shows
     WHERE user_name = 'David'
     ORDER BY show_name ASC`
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
  rawName: string
): Promise<{ success: boolean; showName: string; alreadyExists: boolean }> {
  const existing = await query(
    `SELECT id, show_name FROM watched_shows WHERE user_name = 'David' AND lower(show_name) = lower($1)`,
    [rawName]
  );
  if (existing.rows.length > 0) {
    return { success: false, showName: existing.rows[0].show_name, alreadyExists: true };
  }

  const tvShow = await searchShow(rawName);
  const showName = tvShow?.name ?? rawName;

  await query(
    `INSERT INTO watched_shows (user_name, show_name, tvmaze_id, network, genres, status)
     VALUES ('David', $1, $2, $3, $4, $5)
     ON CONFLICT (user_name, show_name) DO NOTHING`,
    [
      showName,
      tvShow?.id ?? null,
      tvShow?.network ?? null,
      tvShow?.genres?.join(", ") ?? null,
      tvShow?.status ?? null,
    ]
  );

  return { success: true, showName, alreadyExists: false };
}

export async function removeWatchedShow(rawName: string): Promise<string | null> {
  const result = await query(
    `DELETE FROM watched_shows
     WHERE user_name = 'David' AND lower(show_name) LIKE lower($1)
     RETURNING show_name`,
    [`%${rawName}%`]
  );
  return result.rows[0]?.show_name ?? null;
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
      message.match(/remove\s+(.+?)\s+from\s+my\s+(?:shows?|watch\s+list)/i) ??
      message.match(/(?:i\s+finished|finished)\s+(.+?)(?:\s*[.!,]|$)/i);
  }

  const name = match?.[1]?.trim() ?? null;
  if (!name || name.length < 2 || name.length > 60) return null;
  return name;
}

export function buildShowListBlock(shows: WatchedShow[]): string {
  if (!shows.length) return "No shows currently on David's watch list.";
  return shows
    .map((s) => {
      const net = s.network ? ` (${s.network})` : "";
      const genres = s.genres ? ` [${s.genres}]` : "";
      return `• ${s.showName}${net}${genres}`;
    })
    .join("\n");
}
