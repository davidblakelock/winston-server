import { query } from "../db.js";
import { getRecentStoryCount } from "../stories/storyManager.js";
import { fetchWeekEvents } from "../google/calendar.js";
import { getMoodSummaryThisWeek } from "../mood/moodManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface SundayData {
  storiesCount: number;
  newPlaces: string[];
  memoryHighlights: string[];
  weekCalendarEvents: string[];
  moodSummary: string;
}

export interface SundaryData extends SundayData {}

export async function collectSundayData(userName = NATIVE_STORED_NAME): Promise<SundayData> {
  const [storiesCount, newPlaces, memories, calendarEvents, moodRows] = await Promise.all([
    getRecentStoryCount(7).catch(() => 0),
    getNewPlacesThisWeek(userName).catch(() => []),
    getWeekMemoryHighlights(userName).catch(() => []),
    fetchWeekEvents(false, userName).catch(() => null),
    getMoodSummaryThisWeek(userName).catch(() => []),
  ]);

  const weekCalendarEvents = (calendarEvents ?? [])
    .filter((e) => {
      const start = e.startIso ? new Date(e.startIso) : (e.isoDate ? new Date(e.isoDate + "T12:00:00") : null);
      return start !== null && start <= new Date();
    })
    .slice(0, 7)
    .map((e) => {
      const d = e.isoDate
        ? new Date(e.isoDate + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : e.dateLabel;
      const timeLabel = e.allDay ? "" : ` at ${e.start}`;
      return `${d}${timeLabel}: ${e.summary}`;
    });

  const moodSummary = buildMoodSummaryText(moodRows);

  return {
    storiesCount,
    newPlaces,
    memoryHighlights: memories,
    weekCalendarEvents,
    moodSummary,
  };
}

function buildMoodSummaryText(
  moodRows: Array<{ date: string; mood_text: string }>
): string {
  if (!moodRows.length) return "";
  const snippets = moodRows
    .slice(-5)
    .map((r) => {
      const day = new Date(r.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
      });
      return `${day}: "${r.mood_text.substring(0, 80)}"`;
    })
    .join("; ");
  return snippets;
}

async function getNewPlacesThisWeek(userName: string): Promise<string[]> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM profile_items
     WHERE user_name = $1
       AND category IN ('places', 'restaurants')
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT 5`,
    [userName]
  );
  return rows.map((r) => r.name);
}

async function getWeekMemoryHighlights(_userName: string): Promise<string[]> {
  const { rows } = await query<{ summary: string }>(
    `SELECT summary FROM conversation_memories
     WHERE conversation_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY conversation_date ASC`
  );
  return rows.map((r) => r.summary).slice(0, 7);
}

export function buildSundaySummaryBlock(data: SundayData): string {
  const parts: string[] = [];

  if (data.storiesCount > 0) {
    parts.push(
      `${data.storiesCount} stor${data.storiesCount === 1 ? "y" : "ies"} in the family archive this week`
    );
  } else {
    parts.push("no new stories in the family archive this week");
  }

  if (data.newPlaces.length > 0) {
    parts.push(`new places added: ${data.newPlaces.join(", ")}`);
  }

  if (data.weekCalendarEvents.length > 0) {
    parts.push(
      `calendar events this week:\n${data.weekCalendarEvents
        .map((e) => `  - ${e}`)
        .join("\n")}`
    );
  }

  if (data.moodSummary) {
    parts.push(`mood check-ins this week: ${data.moodSummary}`);
  }

  const highlights = data.memoryHighlights.slice(0, 3);
  if (highlights.length > 0) {
    parts.push(
      `conversation highlights:\n${highlights
        .map((h) => `  - ${h}`)
        .join("\n")}`
    );
  }

  const checklist = parts.map((p) => `• ${p}`).join("\n");

  return (
    `\n\n[Weekly Sunday Summary Data]\n${checklist}\n\n` +
    `Today is Sunday — open the briefing with a warm, celebratory weekly recap. ` +
    `Mention highlights from the week: any calendar events, how their mood trended, ` +
    `any new places explored, and how the family archive is growing. End with something to look forward to in the week ahead. ` +
    `CRITICAL — STORY RULE: If the data says "X stories in the family archive this week", say ONLY something like "Your family archive is up to X stories." ` +
    `Do NOT say the user "added" or "captured" stories. Do NOT say the stories are for or from any specific person. Do NOT imply anyone actively did anything — the archive grows on its own. ` +
    `Tone: warm and personal, like a trusted friend reflecting on a good week together. ` +
    `Do NOT be clinical or list-like — weave it into conversation. Keep the whole Sunday summary to 4-5 sentences.`
  );
}
