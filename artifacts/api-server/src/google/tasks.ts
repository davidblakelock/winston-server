import { google } from "googleapis";
import { query } from "../db.js";
import { getAuthClientForUser } from "./oauth.js";
import { logger } from "../lib/logger.js";

// ── Table init ─────────────────────────────────────────────────────────────────

export async function ensureTasksSyncTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS google_tasks_sync (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      item_text TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS google_tasks_sync_uq
    ON google_tasks_sync (user_name, lower(item_text))
  `);
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface GTaskItem {
  id: string;
  title: string;
  status: "needsAction" | "completed";
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function getTasksClient(userName: string) {
  try {
    const auth = await getAuthClientForUser(userName);
    if (!auth) return null;
    return google.tasks({ version: "v1", auth });
  } catch {
    return null;
  }
}

async function getDefaultTaskListId(
  tasks: ReturnType<typeof google.tasks>
): Promise<string | null> {
  try {
    const res = await tasks.tasklists.list({ maxResults: 1 });
    return res.data.items?.[0]?.id ?? "@default";
  } catch {
    return "@default";
  }
}

// ── Public: list Google Tasks ──────────────────────────────────────────────────

export async function listGoogleTasks(userName: string): Promise<GTaskItem[]> {
  const tasks = await getTasksClient(userName);
  if (!tasks) return [];

  const listId = await getDefaultTaskListId(tasks);

  try {
    const res = await tasks.tasks.list({
      tasklist: listId!,
      showCompleted: false,
      maxResults: 100,
    });
    return (res.data.items ?? [])
      .filter((t) => t.status === "needsAction" && t.title)
      .map((t) => ({
        id: t.id!,
        title: t.title!,
        status: "needsAction" as const,
      }));
  } catch (err) {
    logger.warn({ err, userName }, "[Tasks] Failed to list Google Tasks");
    return [];
  }
}

// ── Public: create a Google Task ───────────────────────────────────────────────

export async function createGoogleTask(
  userName: string,
  title: string
): Promise<string | null> {
  const tasks = await getTasksClient(userName);
  if (!tasks) return null;

  const listId = await getDefaultTaskListId(tasks);

  try {
    const res = await tasks.tasks.insert({
      tasklist: listId!,
      requestBody: { title: title.trim(), status: "needsAction" },
    });
    return res.data.id ?? null;
  } catch (err) {
    logger.warn({ err, userName, title }, "[Tasks] Failed to create Google Task");
    return null;
  }
}

// ── Public: complete a Google Task ────────────────────────────────────────────

export async function completeGoogleTask(
  userName: string,
  taskId: string
): Promise<void> {
  const tasks = await getTasksClient(userName);
  if (!tasks) return;

  const listId = await getDefaultTaskListId(tasks);

  try {
    await tasks.tasks.patch({
      tasklist: listId!,
      task: taskId,
      requestBody: { status: "completed" },
    });
  } catch (err) {
    logger.warn({ err, userName, taskId }, "[Tasks] Failed to complete Google Task");
  }
}

// ── Sync: Winston → Google Tasks ──────────────────────────────────────────────
// Pushes a set of item texts to Google Tasks. Skips any already synced.

export async function pushItemsToGoogleTasks(
  userName: string,
  itemTexts: string[]
): Promise<void> {
  if (!itemTexts.length) return;

  for (const itemText of itemTexts) {
    const { rows } = await query<{ task_id: string }>(
      `SELECT task_id FROM google_tasks_sync
       WHERE user_name = $1 AND lower(item_text) = lower($2)`,
      [userName, itemText]
    );
    if (rows.length > 0) continue;

    const taskId = await createGoogleTask(userName, itemText);
    if (taskId) {
      await query(
        `INSERT INTO google_tasks_sync (user_name, item_text, task_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_name, lower(item_text))
         DO UPDATE SET task_id = EXCLUDED.task_id
         RETURNING user_name`,
        [userName, itemText, taskId]
      );
      logger.info({ userName, itemText, taskId }, "[Tasks] Pushed to Google Tasks");
    }
  }
}

// ── Sync: Google Tasks → Winston ──────────────────────────────────────────────
// Pulls incomplete Google Tasks into Winston's "to do" list.

export async function pullTasksFromGoogle(
  userName: string
): Promise<{ added: string[] }> {
  const googleTasks = await listGoogleTasks(userName);
  if (!googleTasks.length) return { added: [] };

  const added: string[] = [];

  for (const task of googleTasks) {
    const title = task.title.trim();
    if (!title) continue;

    const result = await query(
      `INSERT INTO list_items (user_name, list_name, item_text)
       VALUES ($1, 'to do', $2)
       ON CONFLICT (user_name, list_name, lower(item_text)) DO NOTHING
       RETURNING id`,
      [userName, title]
    );

    const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
    if (rowCount > 0) {
      added.push(title);
      await query(
        `INSERT INTO google_tasks_sync (user_name, item_text, task_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_name, lower(item_text)) DO NOTHING
         RETURNING user_name`,
        [userName, title, task.id]
      );
    }
  }

  if (added.length > 0) {
    logger.info({ userName, count: added.length, added }, "[Tasks] Pulled from Google Tasks → Winston");
  }

  return { added };
}

// ── Full bidirectional sync ────────────────────────────────────────────────────

export async function fullTasksSync(
  userName: string
): Promise<{ fromGoogle: number; toGoogle: number }> {
  // 1. Pull Google Tasks → Winston
  const { added } = await pullTasksFromGoogle(userName);

  // 2. Push Winston → Google (only items not yet recorded in sync table)
  const { rows: winstonItems } = await query<{ item_text: string }>(
    `SELECT item_text FROM list_items
     WHERE user_name = $1 AND list_name = 'to do'
     ORDER BY created_at ASC`,
    [userName]
  );

  const { rows: syncedRows } = await query<{ item_text: string }>(
    `SELECT item_text FROM google_tasks_sync WHERE user_name = $1`,
    [userName]
  );
  const syncedLower = new Set(syncedRows.map((r) => r.item_text.toLowerCase()));

  const unsynced = winstonItems
    .filter((r) => !syncedLower.has(r.item_text.toLowerCase()))
    .map((r) => r.item_text);

  await pushItemsToGoogleTasks(userName, unsynced);

  logger.info(
    { userName, fromGoogle: added.length, toGoogle: unsynced.length },
    "[Tasks] Bidirectional sync complete"
  );

  return { fromGoogle: added.length, toGoogle: unsynced.length };
}
