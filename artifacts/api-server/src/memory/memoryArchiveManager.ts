import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const VALID_CATEGORIES = [
  "Childhood",
  "Family",
  "Career",
  "Wisdom",
  "Love",
  "Faith",
  "Adventure",
  "Friends",
] as const;

export type MemoryCategory = (typeof VALID_CATEGORIES)[number];

export interface MemoryEntry {
  id: number;
  text: string;
  category: string;
  createdAt: string;
}

export async function ensureMemoryArchiveTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS memory_archive (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function categorizeMemory(text: string): Promise<MemoryCategory> {
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content:
            `Classify this personal memory into exactly one category.\nCategories: Childhood, Family, Career, Wisdom, Love, Faith, Adventure, Friends\n\nMemory: "${text.substring(0, 500)}"\n\nRespond with only the category name.`,
        },
      ],
    });
    const cat =
      resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (VALID_CATEGORIES.includes(cat as MemoryCategory)) {
      return cat as MemoryCategory;
    }
    return "Family";
  } catch {
    return "Family";
  }
}

export async function saveMemoryToArchive(
  text: string,
  userName: string,
  category?: string
): Promise<MemoryEntry> {
  const resolvedCategory =
    category && VALID_CATEGORIES.includes(category as MemoryCategory)
      ? (category as MemoryCategory)
      : await categorizeMemory(text);

  const { rows } = await query<{
    id: number;
    text: string;
    category: string;
    created_at: string;
  }>(
    `INSERT INTO memory_archive (user_name, text, category)
     VALUES ($1, $2, $3)
     RETURNING id, text, category, created_at`,
    [userName, text.trim(), resolvedCategory]
  );
  logger.info({ userName, category: resolvedCategory }, "[MemoryArchive] Entry saved");
  return {
    id: rows[0].id,
    text: rows[0].text,
    category: rows[0].category,
    createdAt: rows[0].created_at,
  };
}

export async function getMemoriesGroupedByCategory(
  userName: string
): Promise<Record<string, MemoryEntry[]>> {
  const { rows } = await query<{
    id: number;
    text: string;
    category: string;
    created_at: string;
  }>(
    `SELECT id, text, category, created_at
     FROM memory_archive
     WHERE user_name = $1
     ORDER BY category ASC, created_at DESC`,
    [userName]
  );
  const grouped: Record<string, MemoryEntry[]> = {};
  for (const r of rows) {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push({
      id: r.id,
      text: r.text,
      category: r.category,
      createdAt: r.created_at,
    });
  }
  return grouped;
}

export async function deleteMemoryEntry(
  id: number,
  userName: string
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM memory_archive WHERE id = $1 AND user_name = $2`,
    [id, userName]
  );
  return (rowCount ?? 0) > 0;
}

export async function recategorizeMemoryEntry(
  id: number,
  userName: string,
  category: string
): Promise<boolean> {
  if (!VALID_CATEGORIES.includes(category as MemoryCategory)) return false;
  const { rowCount } = await query(
    `UPDATE memory_archive SET category = $1 WHERE id = $2 AND user_name = $3`,
    [category, id, userName]
  );
  return (rowCount ?? 0) > 0;
}
