import { query } from "../db.js";
import { getRecentSessions } from "../pickleball/pickleballManager.js";
import { getRecentStoryCount } from "../stories/storyManager.js";

export interface SundaryData {
  pickleballCount: number;
  pickleballWins: number;
  storiesCount: number;
  newPlaces: string[];
  memoryHighlights: string[];
  kneeIssues: boolean;
}

export async function collectSundayData(): Promise<SundaryData> {
  const [sessions, storiesCount, newPlaces, memories] = await Promise.all([
    getRecentSessions(7),
    getRecentStoryCount(7).catch(() => 0),
    getNewPlacesThisWeek().catch(() => []),
    getWeekMemoryHighlights().catch(() => []),
  ]);

  const wins = sessions.filter((s) => s.won === true).length;
  const kneeIssues = sessions.some(
    (s) => s.kneeOk === false || (s.notes && /knee/i.test(s.notes))
  );

  return {
    pickleballCount: sessions.length,
    pickleballWins: wins,
    storiesCount,
    newPlaces,
    memoryHighlights: memories,
    kneeIssues,
  };
}

async function getNewPlacesThisWeek(): Promise<string[]> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM profile_items
     WHERE category IN ('places', 'restaurants')
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`
  );
  return rows.map((r) => r.name);
}

async function getWeekMemoryHighlights(): Promise<string[]> {
  const { rows } = await query<{ summary: string }>(
    `SELECT summary FROM conversation_memories
     WHERE conversation_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY conversation_date ASC`
  );
  return rows.map((r) => r.summary).slice(0, 7);
}

export function buildSundaySummaryBlock(data: SundaryData): string {
  const parts: string[] = [];

  // Pickleball
  if (data.pickleballCount > 0) {
    const winStr = data.pickleballWins > 0
      ? ` with ${data.pickleballWins} win${data.pickleballWins === 1 ? "" : "s"}`
      : "";
    parts.push(`pickleball: ${data.pickleballCount} session${data.pickleballCount === 1 ? "" : "s"}${winStr}`);
    if (data.kneeIssues) parts.push("knee was mentioned this week — worth noting");
  } else {
    parts.push("no pickleball sessions this week");
  }

  // Stories
  if (data.storiesCount > 0) {
    parts.push(`${data.storiesCount} stor${data.storiesCount === 1 ? "y" : "ies"} captured for Olivia`);
  } else {
    parts.push("no stories captured for Olivia this week");
  }

  // New places
  if (data.newPlaces.length > 0) {
    parts.push(`new places added: ${data.newPlaces.join(", ")}`);
  }

  // Memory highlights
  const highlights = data.memoryHighlights.slice(0, 3);
  if (highlights.length > 0) {
    parts.push(`conversation highlights this week:\n${highlights.map((h) => `  - ${h}`).join("\n")}`);
  }

  const checklist = parts.map((p) => `• ${p}`).join("\n");

  return `\n\n[Weekly Sunday Summary Data]\n${checklist}\n\nToday is Sunday — open the briefing with a warm, celebratory weekly recap. Include David's pickleball activity, stories captured for Olivia, any new places he explored, and one genuinely encouraging observation about the week. End with something to look forward to in the coming week. Tone: warm and personal, like a trusted friend reflecting on a good week together. Do NOT be clinical or list-like — weave it into conversation. Keep the whole Sunday summary to 4-5 sentences.`;
}
