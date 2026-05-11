import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export async function ensureListShareTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS list_share_permissions (
      id                    SERIAL PRIMARY KEY,
      owner_user_name       TEXT NOT NULL,
      shared_with_user_name TEXT NOT NULL,
      list_name             TEXT NOT NULL,
      created_at            TIMESTAMPTZ DEFAULT now(),
      UNIQUE (owner_user_name, shared_with_user_name, list_name)
    )
  `);
  logger.info("[ListShare] list_share_permissions table ready");
}

export async function grantListShare(
  ownerUserName: string,
  sharedWithUserName: string,
  listName: string
): Promise<void> {
  await query(
    `INSERT INTO list_share_permissions (owner_user_name, shared_with_user_name, list_name)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [ownerUserName, sharedWithUserName, listName]
  );
}

export async function revokeListShare(
  ownerUserName: string,
  sharedWithUserName: string,
  listName: string
): Promise<void> {
  await query(
    `DELETE FROM list_share_permissions
     WHERE owner_user_name = $1 AND shared_with_user_name = $2 AND list_name = $3`,
    [ownerUserName, sharedWithUserName, listName]
  );
}

export async function hasListSharePermission(
  ownerUserName: string,
  sharedWithUserName: string,
  listName: string
): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM list_share_permissions
     WHERE owner_user_name = $1 AND shared_with_user_name = $2 AND list_name = $3`,
    [ownerUserName, sharedWithUserName, listName]
  );
  return rows.length > 0;
}

export async function getSharedWithUser(
  sharedWithUserName: string
): Promise<Array<{ ownerUserName: string; listName: string; createdAt: string }>> {
  const { rows } = await query<{
    owner_user_name: string;
    list_name: string;
    created_at: string;
  }>(
    `SELECT owner_user_name, list_name, created_at
     FROM list_share_permissions
     WHERE shared_with_user_name = $1
     ORDER BY owner_user_name, list_name`,
    [sharedWithUserName]
  );
  return rows.map((r) => ({
    ownerUserName: r.owner_user_name,
    listName: r.list_name,
    createdAt: r.created_at,
  }));
}

export async function getRequesterLabel(
  ownerUserName: string,
  sharedWithUserName: string
): Promise<string> {
  const { rows } = await query<{
    requester_user_name: string;
    requester_label: string | null;
    recipient_label: string | null;
  }>(
    `SELECT requester_user_name, requester_label, recipient_label
     FROM winston_connections
     WHERE ((requester_user_name = $1 AND recipient_user_name = $2)
        OR  (requester_user_name = $2 AND recipient_user_name = $1))
       AND status = 'accepted'
     LIMIT 1`,
    [ownerUserName, sharedWithUserName]
  );
  if (!rows[0]) return sharedWithUserName;
  return rows[0].requester_user_name === sharedWithUserName
    ? (rows[0].requester_label ?? sharedWithUserName)
    : (rows[0].recipient_label ?? sharedWithUserName);
}
