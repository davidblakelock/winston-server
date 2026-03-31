import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ProfileCategory =
  | "places"
  | "shows"
  | "restaurants"
  | "people"
  | "interests"
  | "other";

export interface ProfileItem {
  id: number;
  category: ProfileCategory;
  name: string;
  detail: string | null;
  createdAt: Date;
}

export interface ProfileOperation {
  operation: "add" | "remove" | "read";
  category: ProfileCategory;
  name: string | null;
  detail: string | null;
}

export async function ensureProfileTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS profile_items (
      id serial PRIMARY KEY,
      category varchar(50) NOT NULL,
      name text NOT NULL,
      detail text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS profile_items_category_idx
    ON profile_items (category)
  `);
}

// Use Claude to extract structured profile operation from natural language
export async function extractProfileOperation(
  message: string
): Promise<ProfileOperation | null> {
  const extraction = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 200,
    system: `You extract profile management operations from natural language for a personal AI companion.

Categories:
- "places" — locations with optional address (restaurants, venues, landmarks, saved addresses)
- "shows" — TV shows or movies currently watching
- "restaurants" — favorite or frequently visited restaurants  
- "people" — contacts (friends, family, colleagues)
- "interests" — hobbies, topics, preferences
- "other" — anything else

Return ONLY valid JSON:
{
  "operation": "add" | "remove" | "read",
  "category": "places" | "shows" | "restaurants" | "people" | "interests" | "other",
  "name": string or null,
  "detail": string or null
}

Rules:
- "add a place called Chelsea Corner at 6315 La Vista" → {"operation":"add","category":"places","name":"Chelsea Corner","detail":"6315 La Vista Drive Dallas Texas"}
- "I'm watching The Diplomat" → {"operation":"add","category":"shows","name":"The Diplomat","detail":null}
- "add Tate's Pizza as a favorite restaurant" → {"operation":"add","category":"restaurants","name":"Tate's Pizza","detail":null}
- "remove Chelsea Corner from my places" → {"operation":"remove","category":"places","name":"Chelsea Corner","detail":null}
- "what places do I have saved" → {"operation":"read","category":"places","name":null,"detail":null}
- "what shows am I watching" → {"operation":"read","category":"shows","name":null,"detail":null}
- "what restaurants do I have" → {"operation":"read","category":"restaurants","name":null,"detail":null}
- If not a profile operation, return null exactly.

For "add" with restaurants that are also places (have an address), use category "places".
For restaurants without an address (just adding as favorite), use "restaurants".`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text =
      extraction.content[0].type === "text"
        ? extraction.content[0].text.trim()
        : "";
    if (text === "null" || !text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as ProfileOperation;
    if (!parsed.operation || !parsed.category) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function addProfileItem(
  category: ProfileCategory,
  name: string,
  detail: string | null
): Promise<ProfileItem> {
  // Check for duplicates (case-insensitive)
  const existing = await query<{ id: number }>(
    `SELECT id FROM profile_items WHERE category = $1 AND LOWER(name) = LOWER($2)`,
    [category, name]
  );

  if (existing.rows.length > 0) {
    // Update detail if provided
    if (detail) {
      await query(
        `UPDATE profile_items SET detail = $1 WHERE id = $2`,
        [detail, existing.rows[0].id]
      );
    }
    const updated = await query<{
      id: number;
      category: string;
      name: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT id, category, name, detail, created_at FROM profile_items WHERE id = $1`,
      [existing.rows[0].id]
    );
    return mapRow(updated.rows[0]);
  }

  const { rows } = await query<{
    id: number;
    category: string;
    name: string;
    detail: string | null;
    created_at: Date;
  }>(
    `INSERT INTO profile_items (category, name, detail)
     VALUES ($1, $2, $3)
     RETURNING id, category, name, detail, created_at`,
    [category, name, detail ?? null]
  );
  return mapRow(rows[0]);
}

export async function removeProfileItem(
  category: ProfileCategory,
  name: string
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM profile_items WHERE category = $1 AND LOWER(name) = LOWER($2)`,
    [category, name]
  );
  return (rowCount ?? 0) > 0;
}

export async function getProfileItems(
  category?: ProfileCategory
): Promise<ProfileItem[]> {
  const { rows } = category
    ? await query<{
        id: number;
        category: string;
        name: string;
        detail: string | null;
        created_at: Date;
      }>(
        `SELECT id, category, name, detail, created_at
         FROM profile_items WHERE category = $1
         ORDER BY created_at ASC`,
        [category]
      )
    : await query<{
        id: number;
        category: string;
        name: string;
        detail: string | null;
        created_at: Date;
      }>(
        `SELECT id, category, name, detail, created_at
         FROM profile_items ORDER BY category, created_at ASC`
      );

  return rows.map(mapRow);
}

function mapRow(r: {
  id: number;
  category: string;
  name: string;
  detail: string | null;
  created_at: Date;
}): ProfileItem {
  return {
    id: r.id,
    category: r.category as ProfileCategory,
    name: r.name,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

// Format all dynamic profile items for injection into system prompt
export function formatProfileForContext(items: ProfileItem[]): string {
  if (items.length === 0) return "";

  const byCategory = new Map<string, ProfileItem[]>();
  for (const item of items) {
    const existing = byCategory.get(item.category) ?? [];
    existing.push(item);
    byCategory.set(item.category, existing);
  }

  const LABELS: Record<string, string> = {
    places: "Saved Places",
    shows: "Shows Currently Watching",
    restaurants: "Favorite Restaurants",
    people: "People",
    interests: "Interests",
    other: "Other",
  };

  const lines: string[] = [];
  for (const [cat, catItems] of byCategory) {
    const label = LABELS[cat] ?? cat;
    const formatted = catItems
      .map((i) => (i.detail ? `${i.name} (${i.detail})` : i.name))
      .join(", ");
    lines.push(`• ${label}: ${formatted}`);
  }

  return (
    `\n\n[David's Dynamic Profile — items he has added himself]\n` +
    lines.join("\n") +
    `\nThese supplement the static profile above. Reference them naturally.`
  );
}

// Build result context for Emma's response after an operation
export function buildProfileResultContext(
  op: ProfileOperation,
  items: ProfileItem[],
  removed: boolean,
  added?: ProfileItem
): string {
  if (op.operation === "add" && added) {
    const detail = added.detail ? ` at ${added.detail}` : "";
    const catLabel = getCategoryLabel(op.category);
    return (
      `\n\n[Profile Updated]\nAdded "${added.name}"${detail} to ${catLabel}. ` +
      `Confirm warmly and specifically, e.g. "Got it — I've added ${added.name} to your ${catLabel.toLowerCase()}." ` +
      `Keep it brief and natural.`
    );
  }

  if (op.operation === "remove") {
    const catLabel = getCategoryLabel(op.category);
    if (removed) {
      return (
        `\n\n[Profile Updated]\nRemoved "${op.name}" from ${catLabel}. ` +
        `Confirm simply: "Done — removed ${op.name} from your ${catLabel.toLowerCase()}."`
      );
    } else {
      return (
        `\n\n[Profile Note]\nCouldn't find "${op.name}" in ${catLabel} to remove — it may not be saved. ` +
        `Let David know gently.`
      );
    }
  }

  if (op.operation === "read") {
    const catLabel = getCategoryLabel(op.category);
    if (items.length === 0) {
      return (
        `\n\n[Profile Read — ${catLabel}]\nNo items saved in ${catLabel} yet. ` +
        `Let David know he hasn't added anything to that category yet.`
      );
    }
    const list = items
      .map((i) => (i.detail ? `${i.name} (${i.detail})` : i.name))
      .join(", ");
    return (
      `\n\n[Profile Read — ${catLabel}]\n` +
      `David's saved ${catLabel.toLowerCase()}: ${list}\n` +
      `Read these back to him naturally and conversationally.`
    );
  }

  return "";
}

function getCategoryLabel(category: ProfileCategory): string {
  const labels: Record<ProfileCategory, string> = {
    places: "Places",
    shows: "Shows",
    restaurants: "Restaurants",
    people: "People",
    interests: "Interests",
    other: "Other",
  };
  return labels[category] ?? category;
}

// Get places with addresses for navigation lookup
export async function getProfilePlaces(): Promise<
  Array<{ name: string; address: string }>
> {
  const { rows } = await query<{ name: string; detail: string }>(
    `SELECT name, detail FROM profile_items
     WHERE category = 'places' AND detail IS NOT NULL AND detail != ''`
  );
  return rows.map((r) => ({ name: r.name, address: r.detail }));
}

export { logger };
