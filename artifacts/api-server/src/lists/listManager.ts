import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getConnections } from "../connect/connectManager.js";
import { sendPushToAll } from "../push/pushManager.js";

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

export const SHOPPING_CATEGORIES = [
  "Produce", "Dairy", "Meat", "Bakery", "Frozen",
  "Beverages", "Cleaning", "Personal Care", "Pharmacy",
  "Snacks", "Canned Goods", "Other",
] as const;

const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  SHOPPING_CATEGORIES.map((c, i) => [c, i])
);

// ── DB migrations (idempotent) ────────────────────────────────────────────────

export async function ensureListItemColumns(): Promise<void> {
  // These ALTERs are idempotent (IF NOT EXISTS). They may fail silently when
  // Supabase REST is unavailable — that's acceptable because the columns are
  // seeded in the base schema. If they do fail, we log a warning so it's visible.
  const r1 = await query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS added_by text`).catch((err) => {
    logger.warn({ err }, "[Lists] Could not add added_by column — may already exist or DDL not supported");
    return null;
  });
  const r2 = await query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS category text`).catch((err) => {
    logger.warn({ err }, "[Lists] Could not add category column — may already exist or DDL not supported");
    return null;
  });
  if (r1 !== null && r2 !== null) {
    logger.info("[Lists] list_items columns ensured (added_by, category)");
  }
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

// ── Claude: categorize a single shopping item ─────────────────────────────────

export async function categorizeSingleItem(itemText: string): Promise<string> {
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      system: `Classify the grocery/shopping item into exactly one of these categories:
Produce, Dairy, Meat, Bakery, Frozen, Beverages, Cleaning, Personal Care, Pharmacy, Snacks, Canned Goods, Other
Reply with ONLY the category name, nothing else.`,
      messages: [{ role: "user", content: itemText }],
    });
    const raw = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const match = SHOPPING_CATEGORIES.find((c) => c.toLowerCase() === raw.toLowerCase());
    return match ?? "Other";
  } catch {
    return "Other";
  }
}

/** Batch-categorize multiple items in one Claude call. Returns { itemText → category }. */
export async function batchCategorizeItems(items: string[]): Promise<Record<string, string>> {
  if (!items.length) return {};
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: `Classify each shopping item into one of these categories:
Produce, Dairy, Meat, Bakery, Frozen, Beverages, Cleaning, Personal Care, Pharmacy, Snacks, Canned Goods, Other
Return ONLY a JSON array: [{"item":"...","category":"..."}]`,
      messages: [{ role: "user", content: items.join("\n") }],
    });
    const raw = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return {};
    const parsed = JSON.parse(m[0]) as Array<{ item: string; category: string }>;
    const result: Record<string, string> = {};
    for (const entry of parsed) {
      if (!entry.item) continue;
      const match = SHOPPING_CATEGORIES.find((c) => c.toLowerCase() === (entry.category ?? "").toLowerCase());
      result[entry.item.toLowerCase()] = match ?? "Other";
    }
    return result;
  } catch {
    return {};
  }
}

/** Sort items by category order (Produce first, Other last). */
export function sortByCategory<T extends { category?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aOrder = CATEGORY_ORDER[a.category ?? "Other"] ?? 99;
    const bOrder = CATEGORY_ORDER[b.category ?? "Other"] ?? 99;
    return aOrder - bOrder;
  });
}

// ── Async: categorize an item in the background after insert ─────────────────

export async function categorizeAndUpdateItem(id: number, itemText: string): Promise<void> {
  const category = await categorizeSingleItem(itemText);
  await query(
    `UPDATE list_items SET category = $1 WHERE id = $2`,
    [category, id]
  ).catch((err) => logger.warn({ err, id }, "[Lists] Category update failed"));
}

// ── Sync new items to all connected users ─────────────────────────────────────

export async function syncListItemToConnections(
  listName: string,
  items: string[],
  senderUserName: string
): Promise<void> {
  if (!items.length) return;

  const connections = await getConnections(senderUserName).catch(() => []);
  if (!connections.length) return;

  await Promise.all(connections.map(async (conn) => {
    const connectedUserName =
      conn.requester_user_name === senderUserName
        ? conn.recipient_user_name
        : conn.requester_user_name;
    if (!connectedUserName) return;

    const senderLabel =
      conn.requester_user_name === senderUserName
        ? (conn.requester_label ?? senderUserName)
        : (conn.recipient_label ?? senderUserName);

    for (const item of items) {
      await query(
        `INSERT INTO list_items (user_name, list_name, item_text, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING`,
        [connectedUserName, listName, item, senderLabel]
      ).catch(() => {});
    }

    const listDisplayName = listName === "shopping" ? "shopping" : "to-do";
    const deepLink = listName === "shopping" ? "winston://lists?tab=shopping" : "winston://lists?tab=todo";

    await sendPushToAll(
      {
        title: `${senderLabel} added to your ${listDisplayName} list`,
        body: items.length === 1 ? items[0] : `${items[0]} + ${items.length - 1} more`,
        tag: `list-sync-${listName}`,
        notificationType: "list-sync",
        url: deepLink,
        companionMessage: `${senderLabel} just added ${items.length === 1 ? `"${items[0]}"` : `${items.length} items`} to your ${listDisplayName} list.`,
      },
      connectedUserName
    ).catch((err) => logger.warn({ err, connectedUserName }, "[Lists] Sync push failed"));

    logger.info({ senderUserName, connectedUserName, listName, count: items.length }, "[Lists] Synced to connection");
  }));
}

// ── Extract list operation with Claude ───────────────────────────────────────

export async function extractListOp(message: string, contextListName?: string): Promise<ListOp | null> {
  const contextNote = contextListName
    ? `\n- The recent conversation was about the "${contextListName}" list. If the message doesn't name a specific list, assume it's an "add" to the "${contextListName}" list.`
    : "";

  const extraction = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
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

  // Strip markdown code fences that Haiku sometimes wraps around JSON
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as ListOp;
    if (!parsed.action || !parsed.listName) return null;
    parsed.listName = normaliseListName(parsed.listName);
    return parsed;
  } catch {
    return null;
  }
}

// ── DB operations ─────────────────────────────────────────────────────────────

export async function addItems(
  listName: string,
  items: string[],
  userName: string,
  addedBy?: string
): Promise<Array<{ id: number; item_text: string }>> {
  const inserted: Array<{ id: number; item_text: string }> = [];
  for (const item of items) {
    const { rows } = await query<{ id: number; item_text: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id, item_text`,
      [userName, listName, item.trim(), addedBy ?? null]
    );
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

export async function removeItems(listName: string, items: string[], userName: string): Promise<void> {
  for (const item of items) {
    await query(
      `DELETE FROM list_items
       WHERE user_name = $1
         AND list_name = $2
         AND lower(item_text) = lower($3)
       RETURNING id`,
      [userName, listName, item.trim()]
    );
  }
}

export async function clearList(listName: string, userName: string): Promise<void> {
  await query(
    `DELETE FROM list_items WHERE user_name = $1 AND list_name = $2 RETURNING id`,
    [userName, listName]
  );
}

export async function getItems(listName: string, userName: string): Promise<string[]> {
  const { rows } = await query<{ item_text: string }>(
    `SELECT item_text FROM list_items
     WHERE user_name = $1 AND list_name = $2
     ORDER BY created_at ASC`,
    [userName, listName]
  );
  return rows.map((r) => r.item_text);
}

export async function getAllLists(userName: string): Promise<Record<string, string[]>> {
  const { rows } = await query<{ list_name: string; item_text: string }>(
    `SELECT list_name, item_text FROM list_items
     WHERE user_name = $1
     ORDER BY list_name, created_at ASC`,
    [userName]
  );
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.list_name]) result[row.list_name] = [];
    result[row.list_name].push(row.item_text);
  }
  return result;
}

// ── Execute a list operation and return context for the companion ─────────────

export async function executeListOp(op: ListOp, userName: string): Promise<ListResult> {
  let alreadyExisted: string[] = [];

  switch (op.action) {
    case "add": {
      const existing = await getItems(op.listName, userName);
      const existingLower = new Set(existing.map((i) => i.trim().toLowerCase()));

      const newItems = op.items.filter((i) => !existingLower.has(i.trim().toLowerCase()));
      alreadyExisted = op.items.filter((i) => existingLower.has(i.trim().toLowerCase()));

      if (newItems.length > 0) {
        const inserted = await addItems(op.listName, newItems, userName);

        // Auto-categorize shopping items in the background
        if (op.listName === "shopping") {
          for (const row of inserted) {
            categorizeAndUpdateItem(row.id, row.item_text).catch(() => {});
          }
        }

        // Sync to connected users in the background
        if (op.listName === "shopping" || op.listName === "to do") {
          syncListItemToConnections(op.listName, newItems, userName).catch(() => {});
        }
      }
      op = { ...op, items: newItems };
      break;
    }
    case "remove":
      await removeItems(op.listName, op.items, userName);
      break;
    case "clear":
      await clearList(op.listName, userName);
      break;
    case "read":
      break;
  }

  const currentItems = await getItems(op.listName, userName);
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
        const dupes = result.alreadyExisted.join(", ");
        return (
          `\n\n[List — No Change — ${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
          `Already on list (not added again): ${dupes}\n` +
          `Current list (these are the ONLY items that exist):\n${remaining}\n` +
          `Let the user know that ${dupes} is already on the ${displayName} so you didn't add it again. ` +
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
          `AUTHORITATIVE — The ${displayName} is completely empty. There are zero items. ` +
          `Do not mention any items under any circumstances. Do not suggest any items. ` +
          `Say only: Your ${displayName} is empty.`
        );
      }
      const content = result.currentItems.map((i, n) => `${n + 1}. ${i}`).join("\n");
      return (
        `\n\n[${displayName} — AUTHORITATIVE CURRENT STATE FROM SUPABASE]\n` +
        `Disregard any list items mentioned earlier in this conversation. The ONLY current items are those returned by this query:\n` +
        `${content}\n` +
        `Show ONLY the exact items returned by the database. Never reference meals, recipes, or suggest additional items. ` +
        `Never use conversation history to infer what groceries might be needed. The list is the list — nothing more.`
      );
    }
  }
}
