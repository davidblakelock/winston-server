import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ListAction = "add" | "remove" | "clear" | "read";

export interface ListOp {
  action: ListAction;
  listName: string;
  items: string[];
}

export interface ListResult {
  action: ListAction;
  listName: string;
  items: string[];
  alreadyExisted: string[];
  currentItems: string[];
}

// ── Normalise list name for storage ──────────────────────────────────────────

function normaliseListName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\bto\s*[-–]?\s*do\b/g, "to do")
    .replace(/\bshopping\b/, "shopping")
    .replace(/\s+list\s*$/, "")
    .trim();
}

// ── Extract list operation with Claude ───────────────────────────────────────

export async function extractListOp(message: string, contextListName?: string): Promise<ListOp | null> {
  const contextNote = contextListName
    ? `\n- The recent conversation was about the "${contextListName}" list. If the message doesn't name a specific list, assume it's an "add" to the "${contextListName}" list.`
    : "";

  const extraction = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    system: `Extract a list management operation from the user's message.
Return ONLY a JSON object with this shape:
{
  "action": "add" | "remove" | "clear" | "read",
  "listName": <normalised list name, e.g. "shopping", "to do", "errands">,
  "items": [<array of item strings, empty for clear/read>]
}

Rules:
- "add" = user wants to add one or more items to a list
- "remove" = user wants to remove / delete / cross off one or more items
- "clear" = user wants to wipe the whole list
- "read" = user wants to hear what's on the list
- Strip trailing "list" from the list name ("shopping list" → "shopping")
- Casual phrases like "X as well", "also X", "X too", "throw in X", "grab X", "pick up X", "X also", "and X too", "also add X", "also get X" all mean action="add" with X as the item
- If you cannot detect a list operation, return null.${contextNote}
Return raw JSON only — no markdown fences.`,
    messages: [{ role: "user", content: message }],
  });

  const raw =
    extraction.content[0].type === "text" ? extraction.content[0].text.trim() : "";

  if (!raw || raw === "null") return null;

  try {
    const parsed = JSON.parse(raw) as ListOp;
    if (!parsed.action || !parsed.listName) return null;
    parsed.listName = normaliseListName(parsed.listName);
    return parsed;
  } catch {
    return null;
  }
}

// ── DB operations ─────────────────────────────────────────────────────────────

const USER = "David";

export async function addItems(listName: string, items: string[]): Promise<void> {
  for (const item of items) {
    await query(
      `INSERT INTO list_items (user_name, list_name, item_text)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM list_items
         WHERE user_name = $1
           AND list_name = $2
           AND lower(item_text) = lower($3)
       )`,
      [USER, listName, item.trim()]
    );
  }
}

export async function removeItems(listName: string, items: string[]): Promise<void> {
  for (const item of items) {
    await query(
      `DELETE FROM list_items
       WHERE user_name = $1
         AND list_name = $2
         AND lower(item_text) = lower($3)`,
      [USER, listName, item.trim()]
    );
  }
}

export async function clearList(listName: string): Promise<void> {
  await query(
    `DELETE FROM list_items WHERE user_name = $1 AND list_name = $2`,
    [USER, listName]
  );
}

export async function getItems(listName: string): Promise<string[]> {
  const { rows } = await query<{ item_text: string }>(
    `SELECT item_text FROM list_items
     WHERE user_name = $1 AND list_name = $2
     ORDER BY created_at ASC`,
    [USER, listName]
  );
  return rows.map((r) => r.item_text);
}

export async function getAllLists(): Promise<Record<string, string[]>> {
  const { rows } = await query<{ list_name: string; item_text: string }>(
    `SELECT list_name, item_text FROM list_items
     WHERE user_name = $1
     ORDER BY list_name, created_at ASC`,
    [USER]
  );
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.list_name]) result[row.list_name] = [];
    result[row.list_name].push(row.item_text);
  }
  return result;
}

// ── Execute a list operation and return context for Emma Peel ─────────────────

export async function executeListOp(op: ListOp): Promise<ListResult> {
  let alreadyExisted: string[] = [];

  switch (op.action) {
    case "add": {
      // Always read current state from Supabase first — never trust local state or cache
      const existing = await getItems(op.listName);
      const existingLower = new Set(existing.map((i) => i.trim().toLowerCase()));

      const newItems = op.items.filter((i) => !existingLower.has(i.trim().toLowerCase()));
      alreadyExisted = op.items.filter((i) => existingLower.has(i.trim().toLowerCase()));

      if (newItems.length > 0) {
        await addItems(op.listName, newItems);
      }
      // Replace op.items with only what was actually inserted
      op = { ...op, items: newItems };
      break;
    }
    case "remove":
      await removeItems(op.listName, op.items);
      break;
    case "clear":
      await clearList(op.listName);
      break;
    case "read":
      break;
  }

  const currentItems = await getItems(op.listName);
  return { ...op, alreadyExisted, currentItems };
}

// ── Build the system-prompt injection ────────────────────────────────────────

export function buildListContext(result: ListResult): string {
  const displayName = result.listName + " list";

  switch (result.action) {
    case "add": {
      const remaining =
        result.currentItems.length > 0
          ? result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n")
          : "(empty)";

      if (result.items.length === 0 && result.alreadyExisted.length > 0) {
        // Nothing new was added — every item was already in Supabase
        const dupes = result.alreadyExisted.join(", ");
        return (
          `\n\n[List — No Change — ${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
          `Already on list (not added again): ${dupes}\n` +
          `Current list (these are the ONLY items that exist):\n${remaining}\n` +
          `Tell David that ${dupes} is already on his ${displayName} so you didn't add it again. ` +
          `Do NOT mention, suggest, or reference any items not in the current list above.`
        );
      }

      const added = result.items.join(", ");
      const dupeNote = result.alreadyExisted.length > 0
        ? `\nAlready existed (skipped): ${result.alreadyExisted.join(", ")}`
        : "";
      return (
        `\n\n[List updated — ${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
        `Added: ${added}${dupeNote}\n` +
        `Current list (these are the ONLY items that exist — disregard anything mentioned earlier in this conversation):\n${remaining}\n` +
        `Confirm warmly what was added. If you read back the list, read ONLY the items above. ` +
        `Do NOT suggest additional items. Do NOT invent context, recipes, or dinner plans.`
      );
    }
    case "remove": {
      const removed = result.items.join(", ");
      const remaining =
        result.currentItems.length > 0
          ? result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n")
          : "(now empty)";
      return (
        `\n\n[List updated — ${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
        `Removed: ${removed}\n` +
        `Remaining (these are the ONLY items left — disregard anything mentioned earlier in this conversation):\n${remaining}\n` +
        `Confirm the removal naturally. Do NOT mention the removed item(s) as still being needed. ` +
        `Do NOT suggest replacements or additional items.`
      );
    }
    case "clear":
      return (
        `\n\n[List cleared — ${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
        `The list is now completely empty — zero items remain. ` +
        `Do NOT mention any previous items from this conversation. Confirm naturally.`
      );
    case "read": {
      if (result.currentItems.length === 0) {
        return (
          `\n\n[${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
          `The list is empty — zero items. This is a confirmed live read from the database.\n` +
          `CRITICAL: Tell David his ${displayName} is empty. ` +
          `Do NOT mention ANY items from earlier in this conversation. ` +
          `Do NOT suggest what he might need. Do NOT invent items. Say only that it is empty.`
        );
      }
      const content = result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n");
      return (
        `\n\n[${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
        `This is the COMPLETE list. Every item that exists in the database is listed below. There are NO other items:\n` +
        `${content}\n` +
        `CRITICAL: Read back ONLY the items listed above — nothing else. ` +
        `Do NOT add suggestions. Do NOT mention items from earlier in this conversation that are not listed above. ` +
        `Do NOT invent dinner plans, recipes, or what David might need. ` +
        `Do NOT say "you might also want" or similar. The list contains exactly these items and nothing else.`
      );
    }
  }
}
