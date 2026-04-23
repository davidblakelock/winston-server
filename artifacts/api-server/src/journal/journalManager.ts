import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

export interface JournalEntry {
  id: number;
  entryDate: string;
  content: string;
  createdAt: string;
}

export async function saveJournalEntry(content: string, userName = NATIVE_STORED_NAME): Promise<JournalEntry> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `INSERT INTO journal_entries (user_name, content)
     VALUES ($1, $2)
     RETURNING id, entry_date, content, created_at`,
    [userName, content]
  );
  return {
    id: rows[0].id,
    entryDate: rows[0].entry_date,
    content: rows[0].content,
    createdAt: rows[0].created_at,
  };
}

export async function getRecentJournalEntries(days = 7, userName = NATIVE_STORED_NAME): Promise<JournalEntry[]> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `SELECT id, entry_date, content, created_at
     FROM journal_entries
     WHERE user_name = $1
       AND entry_date >= CURRENT_DATE - ($2 || ' days')::interval
     ORDER BY entry_date DESC, created_at DESC
     LIMIT 20`,
    [userName, String(days)]
  );
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export async function getAllJournalEntries(userName = NATIVE_STORED_NAME): Promise<JournalEntry[]> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `SELECT id, entry_date, content, created_at
     FROM journal_entries
     WHERE user_name = $1
     ORDER BY entry_date DESC, created_at DESC`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export async function hasJournalEntryTonight(userName = NATIVE_STORED_NAME): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE user_name = $1 AND entry_date = CURRENT_DATE`,
    [userName]
  );
  return parseInt(rows[0].count) > 0;
}

export async function getJournalCountThisWeek(userName = NATIVE_STORED_NAME): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE user_name = $1
       AND entry_date >= DATE_TRUNC('week', CURRENT_DATE)`,
    [userName]
  );
  return parseInt(rows[0].count);
}

export function formatJournalForPrompt(entries: JournalEntry[]): string {
  if (!entries.length) return "No journal entries found.";
  return entries
    .map((e) => {
      const d = new Date(e.entryDate + "T12:00:00");
      const label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      return `[${label}]\n${e.content}`;
    })
    .join("\n\n---\n\n");
}
