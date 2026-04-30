import { query } from "../db.js";

export interface MydayEntry {
  id: number;
  entry_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export async function saveMydayEntry(
  userName: string,
  content: string,
  date?: string
): Promise<MydayEntry> {
  const entryDate =
    date ??
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const { rows } = await query<MydayEntry>(
    `INSERT INTO myday_entries (user_name, entry_date, content, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_name, entry_date)
     DO UPDATE SET content = EXCLUDED.content, updated_at = now()
     RETURNING id, entry_date, content, created_at, updated_at`,
    [userName, entryDate, content.trim()]
  );
  return rows[0];
}

export async function getTodayMydayEntry(
  userName: string
): Promise<MydayEntry | null> {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
  const { rows } = await query<MydayEntry>(
    `SELECT id, entry_date, content, created_at, updated_at
     FROM myday_entries
     WHERE user_name = $1 AND entry_date = $2`,
    [userName, today]
  );
  return rows[0] ?? null;
}

export async function getMydayEntries(userName: string): Promise<MydayEntry[]> {
  const { rows } = await query<MydayEntry>(
    `SELECT id, entry_date, content, created_at, updated_at
     FROM myday_entries
     WHERE user_name = $1
     ORDER BY entry_date DESC`,
    [userName]
  );
  return rows;
}

export function extractMydayContent(message: string): string {
  const stripped = message
    .replace(
      /^(?:okay[,.]?\s*|ok[,.]?\s*|alright[,.]?\s*|sure[,.]?\s*)?(?:(?:please\s+)?(?:add(?:\s+(?:this|that))?\s+to\s+my\s+(?:day(?:'?s?\s*(?:log|recap|notes?)?)?|daily\s*(?:log|recap))|log(?:\s+(?:this|that|it))?\s+(?:to|for|in)\s+(?:my\s+)?(?:day|today)|jot\s+(?:this|that)\s+down(?:\s+for\s+today)?|save\s+(?:this|that)\s+to\s+my\s+(?:day(?:'?s?\s*(?:log|recap)?)?|daily\s*(?:log|recap))|capture\s+(?:this|that)\s+for\s+today|note\s+that\b|note\s+this\s+down\s+for\s+today|remember\s+that\s+for\s+today))[:\s]*/i,
      ""
    )
    .trim();
  return stripped || message.trim();
}
