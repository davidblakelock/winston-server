import { query } from "../db.js";

export interface JournalEntry {
  id: number;
  entryDate: string;
  content: string;
  createdAt: string;
}

export async function saveJournalEntry(content: string): Promise<JournalEntry> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `INSERT INTO journal_entries (user_name, content)
     VALUES ('David', $1)
     RETURNING id, entry_date, content, created_at`,
    [content]
  );
  return {
    id: rows[0].id,
    entryDate: rows[0].entry_date,
    content: rows[0].content,
    createdAt: rows[0].created_at,
  };
}

export async function getRecentJournalEntries(days = 7): Promise<JournalEntry[]> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `SELECT id, entry_date, content, created_at
     FROM journal_entries
     WHERE user_name = 'David'
       AND entry_date >= CURRENT_DATE - INTERVAL '${days} days'
     ORDER BY entry_date DESC, created_at DESC
     LIMIT 20`
  );
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export async function getAllJournalEntries(): Promise<JournalEntry[]> {
  const { rows } = await query<{
    id: number; entry_date: string; content: string; created_at: string;
  }>(
    `SELECT id, entry_date, content, created_at
     FROM journal_entries
     WHERE user_name = 'David'
     ORDER BY entry_date DESC, created_at DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export async function hasJournalEntryTonight(): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE user_name = 'David' AND entry_date = CURRENT_DATE`
  );
  return parseInt(rows[0].count) > 0;
}

export async function getJournalCountThisWeek(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE user_name = 'David'
       AND entry_date >= DATE_TRUNC('week', CURRENT_DATE)`
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
