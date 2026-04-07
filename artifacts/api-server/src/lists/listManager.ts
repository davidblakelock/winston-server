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

export async function extractListOp(message: string): Promise<ListOp | null> {
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
- If you cannot detect a list operation, return null.
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
       VALUES ($1, $2, $3)`,
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
  switch (op.action) {
    case "add":
      await addItems(op.listName, op.items);
      break;
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
  return { ...op, currentItems };
}

// ── Build the system-prompt injection ────────────────────────────────────────

export function buildListContext(result: ListResult): string {
  const displayName = result.listName + " list";

  switch (result.action) {
    case "add": {
      const added = result.items.join(", ");
      const remaining =
        result.currentItems.length > 0
          ? result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n")
          : "(empty)";
      return (
        `\n\n[List updated — ${displayName}]\n` +
        `Added: ${added}\n` +
        `Current list:\n${remaining}\n` +
        `Confirm warmly and mention what was added. You may optionally read the full list if it is short.`
      );
    }
    case "remove": {
      const removed = result.items.join(", ");
      const remaining =
        result.currentItems.length > 0
          ? result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n")
          : "(now empty)";
      return (
        `\n\n[List updated — ${displayName}]\n` +
        `Removed: ${removed}\n` +
        `Remaining:\n${remaining}\n` +
        `Confirm the removal naturally.`
      );
    }
    case "clear":
      return (
        `\n\n[List cleared — ${displayName}]\n` +
        `The list is now empty. Confirm naturally.`
      );
    case "read": {
      if (result.currentItems.length === 0) {
        return (
          `\n\n[${displayName} — EMPTY OR UNREADABLE]\n` +
          `The list returned no items — this may mean the list is empty or there was a retrieval issue.\n` +
          `Tell David exactly: "I had trouble reading your list — try checking the list screen directly." ` +
          `Do NOT say the list is empty. Do NOT invent any items.`
        );
      }
      const content = result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n");
      return (
        `\n\n[${displayName} — current contents]\n` +
        `${content}\n` +
        `Read this list back to David naturally and conversationally.`
      );
    }
  }
}
