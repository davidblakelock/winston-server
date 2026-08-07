import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getConnections, type WinstonConnection } from "../connect/connectManager.js";
import { getGrantedShareTargets } from "./listShareManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { createReminder } from "../reminders/reminderManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Pending save offers ──────────────────────────────────────────────────────
// Same pattern as pendingReservation/pendingEmailReply/pendingAtticCleanup:
// when Winston makes a save-worthy recommendation (a product, a restaurant, a
// recipe), the real title/url are captured into this cache immediately, from
// that turn's own reply and actual search results — not asked of Claude again
// later. A later "save that" confirmation resolves from here instead of
// trusting Claude to retype content it generated in an earlier, separate call.

export interface SaveOfferCandidate {
  title: string;
  url:   string | null;
}

export interface PendingSaveOffers {
  candidates: SaveOfferCandidate[];
  // Full reply text from the turn the offer was made — shared detail source
  // for whichever candidate gets confirmed. Exact, not regenerated.
  detail: string;
}

const _pendingSaveOffersMap = new Map<string, PendingSaveOffers>();

export function getPendingSaveOffers(userName: string): PendingSaveOffers | null {
  return _pendingSaveOffersMap.get(userName) ?? null;
}

export function setPendingSaveOffers(userName: string, offers: PendingSaveOffers | null): void {
  if (offers === null) {
    _pendingSaveOffersMap.delete(userName);
  } else {
    _pendingSaveOffersMap.set(userName, offers);
  }
}

// ── List type (checklist vs notepad) ─────────────────────────────────────────
// A structured title+notes+url save only makes sense against a checklist —
// a notepad-type list only ever renders/edits a single freeform blob
// (items[0].item_text), so a structured save into one silently vanishes
// from the user's point of view (data's in list_items, but nothing on
// screen reflects it). Lists default to "checklist" unless a row in `lists`
// says otherwise.

export async function getListType(userName: string, listName: string): Promise<string> {
  const { rows } = await query<{ list_type: string }>(
    `SELECT list_type FROM lists WHERE user_name = $1 AND lower(list_name) = lower($2)`,
    [userName, listName]
  );
  return rows[0]?.list_type ?? "checklist";
}

// Flips a notepad list to checklist. No data migration needed — the
// underlying list_items rows are identical either way; only the client's
// list_type-driven rendering differs. Whatever's already there (the
// notepad's single freeform row, if any) just starts rendering as an
// ordinary checklist item instead of the single editable blob.
export async function convertListToChecklist(userName: string, listName: string): Promise<void> {
  await query(
    `INSERT INTO lists (user_name, list_name, list_type)
     VALUES ($1, $2, 'checklist')
     ON CONFLICT (user_name, list_name) DO UPDATE SET list_type = 'checklist'`,
    [userName, listName]
  );
}

// ── Pending list-type conflict ───────────────────────────────────────────────
// Same pattern as pendingSaveOffers: when a structured save targets a
// notepad-type list, the save is held here (not written) while Winston asks
// whether to convert the list or use a different name — resolved on the
// next turn instead of asking Claude to retype the title/notes/url.

export interface PendingListTypeConflict {
  listName: string;
  title:    string;
  notes:    string | null;
  url:      string | null;
}

const _pendingListTypeConflictMap = new Map<string, PendingListTypeConflict>();

export function getPendingListTypeConflict(userName: string): PendingListTypeConflict | null {
  return _pendingListTypeConflictMap.get(userName) ?? null;
}

export function setPendingListTypeConflict(userName: string, conflict: PendingListTypeConflict | null): void {
  if (conflict === null) {
    _pendingListTypeConflictMap.delete(userName);
  } else {
    _pendingListTypeConflictMap.set(userName, conflict);
  }
}

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
  "Beverages", "Snacks", "Canned Goods", "Cleaning",
  "Personal Care", "Pharmacy", "Other",
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
  const r3 = await query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS url text`).catch((err) => {
    logger.warn({ err }, "[Lists] Could not add url column — may already exist or DDL not supported");
    return null;
  });
  if (r1 !== null && r2 !== null && r3 !== null) {
    logger.info("[Lists] list_items columns ensured (added_by, category, url)");
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
  logger.info({ id, itemText, category }, "[Lists] Item categorized");
  await query(
    `UPDATE list_items SET category = $1 WHERE id = $2`,
    [category, id]
  ).catch((err) => logger.warn({ err, id }, "[Lists] Category update failed"));
}

/** Batch-categorize multiple items in one Haiku call, then update each row in the DB. */
export async function batchCategorizeAndUpdateItems(rows: Array<{ id: number; item_text: string }>): Promise<void> {
  if (!rows.length) return;
  const categoryMap = await batchCategorizeItems(rows.map((r) => r.item_text));
  for (const row of rows) {
    const category = categoryMap[row.item_text.toLowerCase()] ?? "Other";
    logger.info({ id: row.id, itemText: row.item_text, category }, "[Lists] Item categorized");
    await query(
      `UPDATE list_items SET category = $1 WHERE id = $2`,
      [category, row.id]
    ).catch((err) => logger.warn({ err, id: row.id }, "[Lists] Category update failed"));
  }
}

// ── Sync new items to all connected users ─────────────────────────────────────

export async function syncListItemToConnections(
  listName: string,
  items: string[],
  senderUserName: string
): Promise<void> {
  if (!items.length) return;

  // Permission-gated — a list only syncs to people explicitly granted
  // access to THIS list (confirmed decision, Aug 2026: shopping/to-do get
  // the same opt-in treatment as any other list, many-to-many).
  const grantedTargets = await getGrantedShareTargets(senderUserName, listName).catch(() => []);
  if (!grantedTargets.length) return;

  const connections = await getConnections(senderUserName).catch((): WinstonConnection[] => []);
  const isPlainTodo = listName === "to do" || listName === "reminders";

  await Promise.all(grantedTargets.map(async (connectedUserName) => {
    if (!connectedUserName || connectedUserName === senderUserName) return;

    // Display label still sourced from the connection record — that's
    // still where a person's chosen label to this specific other person
    // lives, unrelated to whether sharing is granted.
    const conn = connections.find((c) =>
      (c.requester_user_name === senderUserName && c.recipient_user_name === connectedUserName) ||
      (c.recipient_user_name === senderUserName && c.requester_user_name === connectedUserName)
    );
    const senderLabel =
      conn?.requester_user_name === senderUserName
        ? (conn.requester_label ?? senderUserName)
        : (conn?.recipient_label ?? senderUserName);

    if (isPlainTodo) {
      // To-dos live in the reminders table, not list_items — mirror that here
      // so a synced to-do actually shows up on the recipient's To Do screen,
      // instead of silently landing in list_items where nothing reads it back.
      const { timezone: targetTz } = await getUserLocationContext(connectedUserName).catch(() => ({ timezone: "UTC" }));
      for (const item of items) {
        await createReminder({
          userName: connectedUserName,
          reminderText: item,
          fireAt: null as any,
          timezone: targetTz,
        }).catch(() => {});
      }
    } else {
      for (const item of items) {
        await query(
          `INSERT INTO list_items (user_name, list_name, item_text, added_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING`,
          [connectedUserName, listName, item, senderLabel]
        ).catch(() => {});
      }
    }

    // Generalized beyond the old hardcoded shopping/to-do display strings —
    // this function can now be called for any list.
    const listDisplayName = listName === "shopping" ? "shopping" : listName;
    const deepLink =
      listName === "shopping" ? "winston://lists?tab=shopping" :
      listName === "to do"    ? "winston://lists?tab=todo" :
      `winston://lists?list=${encodeURIComponent(listName)}`;

    await sendFcmNotification({
      userName: connectedUserName,
      notificationType: 'list-sync',
      title: `${senderLabel} added to your ${listDisplayName} list`,
      body: items.length === 1 ? items[0] : `${items[0]} + ${items.length - 1} more`,
      data: {
        tag: `list-sync-${listName}`,
        deepLink,
        companionMessage: `${senderLabel} just added ${items.length === 1 ? `"${items[0]}"` : `${items.length} items`} to your ${listDisplayName} list.`,
      },
    }).catch((err) => logger.warn({ err, connectedUserName }, '[Lists] Sync push failed'));

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
  addedBy?: string,
  notes?: string | null,
  url?: string | null,
): Promise<Array<{ id: number; item_text: string }>> {
  const inserted: Array<{ id: number; item_text: string }> = [];
  // notes/url describe ONE thing — a title/content/source-link save (a
  // recipe, a product recommendation). A multi-item save (shopping-list
  // style) has no per-item notes or url concept, so both are only applied
  // when there's exactly one item.
  const itemNotes = items.length === 1 ? (notes ?? null) : null;
  const itemUrl   = items.length === 1 ? (url ?? null) : null;
  for (const item of items) {
    const { rows } = await query<{ id: number; item_text: string }>(
      `INSERT INTO list_items (user_name, list_name, item_text, added_by, notes, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id, item_text`,
      [userName, listName, item.trim(), addedBy ?? null, itemNotes, itemUrl]
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

// ── Recent list items (for the connection engine's Lists adapter) ───────────
// Excludes the shopping list — groceries are too transitory to carry any
// signal for pattern/interest detection and would just add noise to what the
// passes reason over. All other named lists (wish lists, notepad saves,
// custom lists, etc.) are included. No `completed` filter — that column
// doesn't exist on list_items (only on shared_list_items, a different
// table) — see verification checklist below re: the query this replaces.
export async function getRecentListItems(
  userName: string,
  days: number,
): Promise<Array<{ id: number; list_name: string; item_text: string; created_at: string }>> {
  const { rows } = await query<{ id: number; list_name: string; item_text: string; created_at: string }>(
    `SELECT id, list_name, item_text, created_at
     FROM list_items
     WHERE user_name = $1
       AND lower(list_name) != 'shopping'
       AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

// ── Cleanup / archive ────────────────────────────────────────────────────────
// "Clean up my wish list": age-based candidate selection + a pending-state
// confirmation flow, same pattern as Attic's getArchiveCandidates/
// archiveAtticItems/pendingAtticCleanup. Diverges from Attic's approach in
// one way: Attic archives via an in-place status flag (attic_items has a
// single controlled read path in atticItemsManager.ts), but list_items has
// no status/completed column and is read from many scattered call sites
// across routes/lists.ts and chatHandlerCore.ts — adding a status column
// would mean auditing and updating every one of those reads. Moving rows
// out to a separate table instead means every existing list_items read path
// keeps working completely unmodified, since archived rows simply aren't in
// that table anymore.

const _listArchiveTableInit = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS list_items_archive (
      id          integer PRIMARY KEY,
      user_name   text NOT NULL,
      list_name   text NOT NULL,
      item_text   text NOT NULL,
      added_by    text,
      notes       text,
      url         text,
      created_at  timestamptz NOT NULL,
      archived_at timestamptz NOT NULL DEFAULT now()
    )
  `);
})();

export const DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS = 120; // longer than
// Attic's 60 — list items tend to be more deliberate/curated (a wish list,
// a reading list) than Attic's catch-all "caught my attention, no
// destination" bucket, so a longer default before suggesting cleanup.

export interface ListArchiveCandidate {
  id:        number;
  listName:  string;
  itemText:  string;
  createdAt: string;
}

export interface PendingListCleanup {
  listName:      string | null; // null = across all (non-shopping) lists
  candidates:    ListArchiveCandidate[];
  thresholdDays: number;
}

const _pendingListCleanupMap = new Map<string, PendingListCleanup>();

export function getPendingListCleanup(userName: string): PendingListCleanup | null {
  return _pendingListCleanupMap.get(userName) ?? null;
}

export function setPendingListCleanup(userName: string, state: PendingListCleanup | null): void {
  if (state === null) {
    _pendingListCleanupMap.delete(userName);
  } else {
    _pendingListCleanupMap.set(userName, state);
  }
}

// Scoped to a single list when listName is given ("clean up my wish
// list"), or across every non-shopping list when omitted. Shopping is
// excluded here too, same reasoning as getRecentListItems above —
// groceries are transitory, nobody wants to "clean up" a shopping list,
// they just clear it.
export async function getListArchiveCandidates(
  userName:      string,
  listName:      string | null,
  thresholdDays  = DEFAULT_LIST_ARCHIVE_THRESHOLD_DAYS,
): Promise<ListArchiveCandidate[]> {
  await _listArchiveTableInit;
  const conditions = [`user_name = $1`, `lower(list_name) != 'shopping'`, `created_at < now() - ($2 || ' days')::interval`];
  const params: unknown[] = [userName, thresholdDays.toString()];
  if (listName) {
    params.push(listName);
    conditions.push(`lower(list_name) = lower($${params.length})`);
  }
  const { rows } = await query<{ id: number; list_name: string; item_text: string; created_at: string }>(
    `SELECT id, list_name, item_text, created_at FROM list_items WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
    params
  );
  return rows.map((r) => ({ id: r.id, listName: r.list_name, itemText: r.item_text, createdAt: r.created_at }));
}

// Moves rows out of list_items entirely, not a status flag — see the note
// above. Sequential INSERT-then-DELETE, not a transaction — query() has no
// transaction support (each call is an independent Supabase REST/exec_sql
// round-trip, confirmed against the real db.ts). A crash between the two
// leaves a duplicate (row survives in both tables), not a loss — the
// DELETE is what actually removes it from the live table, so the failure
// mode leans toward "item survives" rather than "item lost."
export async function archiveListItems(userName: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  await _listArchiveTableInit;
  await query(
    `INSERT INTO list_items_archive (id, user_name, list_name, item_text, added_by, notes, url, created_at)
     SELECT id, user_name, list_name, item_text, added_by, notes, url, created_at
     FROM list_items WHERE id = ANY($1) AND user_name = $2
     ON CONFLICT (id) DO NOTHING`,
    [ids, userName]
  );
  const { rows } = await query<{ id: number }>(
    `DELETE FROM list_items WHERE id = ANY($1) AND user_name = $2 RETURNING id`,
    [ids, userName]
  );
  logger.info({ userName, count: rows.length }, "[Lists] Items archived");
  return rows.length;
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

        // Sync to anyone granted permission for this specific list — no
        // longer hardcoded to shopping/to-do; syncListItemToConnections
        // itself no-ops if nobody's been granted access to this list.
        syncListItemToConnections(op.listName, newItems, userName).catch(() => {});
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
        `Current list (for reference only — do NOT read this back unprompted):\n${remaining}\n` +
        `RESPONSE RULES: Confirm what was just added in one brief, warm sentence (e.g. "Done — eggs are on your list."). ` +
        `Do NOT read back the full list. Do NOT mention other items already on the list. ` +
        `Do NOT suggest additional items. Do NOT invent context, recipes, or dinner plans. ` +
        `If the user explicitly asks what's on the list, then you may read the current list above.`
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
