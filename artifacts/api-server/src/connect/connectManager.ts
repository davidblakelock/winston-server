import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { randomBytes } from "node:crypto";

// ── Ensure tables exist (idempotent) ─────────────────────────────────────────

export async function ensureConnectTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS winston_connections (
      id                    integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      requester_user_name   text NOT NULL,
      recipient_user_name   text,
      status                text NOT NULL DEFAULT 'pending',
      invite_token          text NOT NULL UNIQUE,
      requester_label       text,
      recipient_label       text,
      created_at            timestamptz DEFAULT now(),
      accepted_at           timestamptz
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS connect_messages (
      id                  integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      sender_user_name    text NOT NULL,
      recipient_user_name text NOT NULL,
      message_type        text NOT NULL DEFAULT 'message',
      message_text        text NOT NULL,
      delivered           boolean DEFAULT false,
      created_at          timestamptz DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS shared_lists (
      id            integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      connection_id integer NOT NULL,
      name          text NOT NULL DEFAULT 'Shared List',
      created_by    text NOT NULL,
      created_at    timestamptz DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS shared_list_items (
      id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      list_id     integer NOT NULL,
      text        text NOT NULL,
      added_by    text NOT NULL,
      completed   boolean DEFAULT false,
      created_at  timestamptz DEFAULT now()
    )
  `);

  // Add birthday/key-date columns if they don't exist yet
  await query(`ALTER TABLE winston_connections ADD COLUMN IF NOT EXISTS date_of_birth DATE`);
  await query(`ALTER TABLE winston_connections ADD COLUMN IF NOT EXISTS key_dates JSONB DEFAULT '[]'`);

  logger.info("[Connect] Tables ready");
}

// ── Birthday / key-date profile update ───────────────────────────────────────

export async function updateConnectionProfile(
  id: number,
  userName: string,
  data: {
    dateOfBirth?: string | null;
    keyDates?: Array<{ label: string; date: string }> | null;
  }
): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (data.dateOfBirth !== undefined) {
    sets.push(`date_of_birth = $${idx++}`);
    vals.push(data.dateOfBirth || null);
  }
  if (data.keyDates !== undefined) {
    sets.push(`key_dates = $${idx++}`);
    vals.push(data.keyDates ? JSON.stringify(data.keyDates) : "[]");
  }

  if (!sets.length) return false;

  vals.push(id, userName);
  const { rows } = await query(
    `UPDATE winston_connections SET ${sets.join(", ")}
      WHERE id = $${idx}
        AND (requester_user_name = $${idx + 1} OR recipient_user_name = $${idx + 1})
     RETURNING id`,
    vals
  );
  return rows.length > 0;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WinstonConnection {
  id: number;
  requester_user_name: string;
  recipient_user_name: string | null;
  status: string;
  invite_token: string;
  requester_label: string | null;
  recipient_label: string | null;
  created_at: string;
  accepted_at: string | null;
}

export interface SharedList {
  id: number;
  connection_id: number;
  name: string;
  created_by: string;
  created_at: string;
}

export interface SharedListItem {
  id: number;
  list_id: number;
  text: string;
  added_by: string;
  completed: boolean;
  created_at: string;
}

// ── Connection management ─────────────────────────────────────────────────────

export async function createInvite(
  requesterUserName: string,
  requesterLabel: string
): Promise<{ inviteToken: string; id: number }> {
  const token = randomBytes(16).toString("hex");
  const { rows } = await query<{ id: number }>(
    `INSERT INTO winston_connections (requester_user_name, requester_label, invite_token, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [requesterUserName, requesterLabel, token]
  );
  return { inviteToken: token, id: rows[0]!.id };
}

export async function acceptInvite(
  recipientUserName: string,
  inviteToken: string,
  recipientLabel: string
): Promise<WinstonConnection | null> {
  const { rows } = await query<WinstonConnection>(
    `UPDATE winston_connections
     SET status               = 'accepted',
         recipient_user_name  = $1,
         recipient_label      = $2,
         accepted_at          = now()
     WHERE invite_token = $3
       AND status = 'pending'
     RETURNING *`,
    [recipientUserName, recipientLabel, inviteToken]
  );
  if (!rows[0]) return null;

  // Auto-create a shared shopping list for this connection
  await query(
    `INSERT INTO shared_lists (connection_id, name, created_by)
     VALUES ($1, 'Shared List', $2)
     RETURNING id`,
    [rows[0].id, recipientUserName]
  ).catch(() => {});

  return rows[0];
}

export async function getConnections(userName: string): Promise<WinstonConnection[]> {
  const { rows } = await query<WinstonConnection>(
    `SELECT * FROM winston_connections
     WHERE (requester_user_name = $1 OR recipient_user_name = $1)
       AND status = 'accepted'
     ORDER BY accepted_at DESC`,
    [userName]
  );
  return rows;
}

export async function getPendingInvites(userName: string): Promise<WinstonConnection[]> {
  const { rows } = await query<WinstonConnection>(
    `SELECT * FROM winston_connections
     WHERE requester_user_name = $1 AND status = 'pending'
     ORDER BY created_at DESC`,
    [userName]
  );
  return rows;
}

/**
 * Find the other user in a connection given a display name/label.
 * Returns the recipient's user_name and the sender's stored display label.
 */
export async function findConnectionByLabel(
  senderUserName: string,
  targetLabel: string
): Promise<{ recipientUserName: string; senderLabel: string } | null> {
  const like = `%${targetLabel.toLowerCase()}%`;

  // Sender is the requester
  const { rows: asReq } = await query<{
    recipient_user_name: string;
    requester_label: string | null;
    recipient_label: string | null;
  }>(
    `SELECT recipient_user_name, requester_label, recipient_label
     FROM winston_connections
     WHERE requester_user_name = $1
       AND status = 'accepted'
       AND recipient_user_name IS NOT NULL
       AND (lower(recipient_label) LIKE $2 OR lower(requester_label) LIKE $2)`,
    [senderUserName, like]
  );
  if (asReq[0]?.recipient_user_name) {
    return {
      recipientUserName: asReq[0].recipient_user_name,
      senderLabel: asReq[0].requester_label ?? senderUserName,
    };
  }

  // Sender is the recipient
  const { rows: asRec } = await query<{
    requester_user_name: string;
    requester_label: string | null;
    recipient_label: string | null;
  }>(
    `SELECT requester_user_name, requester_label, recipient_label
     FROM winston_connections
     WHERE recipient_user_name = $1
       AND status = 'accepted'
       AND (lower(requester_label) LIKE $2 OR lower(recipient_label) LIKE $2)`,
    [senderUserName, like]
  );
  if (asRec[0]?.requester_user_name) {
    return {
      recipientUserName: asRec[0].requester_user_name,
      senderLabel: asRec[0].recipient_label ?? senderUserName,
    };
  }

  return null;
}

// ── Message management ────────────────────────────────────────────────────────

export async function saveConnectMessage(
  senderUserName: string,
  recipientUserName: string,
  messageType: string,
  messageText: string
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO connect_messages (sender_user_name, recipient_user_name, message_type, message_text)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [senderUserName, recipientUserName, messageType, messageText]
  );
  return rows[0]!.id;
}

export async function markMessageDelivered(messageId: number): Promise<void> {
  await query(
    `UPDATE connect_messages SET delivered = true WHERE id = $1 RETURNING id`,
    [messageId]
  );
}

// ── Shared list management ────────────────────────────────────────────────────

export async function getSharedListForConnection(connectionId: number): Promise<SharedList | null> {
  const { rows } = await query<SharedList>(
    `SELECT * FROM shared_lists WHERE connection_id = $1 LIMIT 1`,
    [connectionId]
  );
  return rows[0] ?? null;
}

export async function getSharedListItems(listId: number): Promise<SharedListItem[]> {
  const { rows } = await query<SharedListItem>(
    `SELECT * FROM shared_list_items WHERE list_id = $1 ORDER BY created_at ASC`,
    [listId]
  );
  return rows;
}

export async function addSharedListItem(
  listId: number,
  text: string,
  addedBy: string
): Promise<SharedListItem> {
  const { rows } = await query<SharedListItem>(
    `INSERT INTO shared_list_items (list_id, text, added_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [listId, text, addedBy]
  );
  return rows[0]!;
}

export async function toggleSharedListItem(
  itemId: number,
  listId: number
): Promise<SharedListItem | null> {
  const { rows } = await query<SharedListItem>(
    `UPDATE shared_list_items SET completed = NOT completed
     WHERE id = $1 AND list_id = $2
     RETURNING *`,
    [itemId, listId]
  );
  return rows[0] ?? null;
}

export async function deleteSharedListItem(itemId: number, listId: number): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `DELETE FROM shared_list_items WHERE id = $1 AND list_id = $2 RETURNING id`,
    [itemId, listId]
  );
  return rows.length > 0;
}

export async function createSharedList(
  connectionId: number,
  createdBy: string
): Promise<SharedList> {
  const { rows } = await query<SharedList>(
    `INSERT INTO shared_lists (connection_id, name, created_by)
     VALUES ($1, 'Shared List', $2)
     RETURNING *`,
    [connectionId, createdBy]
  );
  return rows[0]!;
}

// ── Winston Connect ↔ key_people sync ────────────────────────────────────────

/**
 * After an invite is accepted, mark winston_connected = true in key_people for
 * both sides of the connection — wherever a person's stored name matches the
 * other party's label (case-insensitive exact match).
 *
 * requester_label  = how the requester identifies themselves
 * recipient_label  = how the accepter identifies themselves
 *
 * So in the REQUESTER's key_people we look for the recipient_label name, and
 * in the RECIPIENT's key_people we look for the requester_label name.
 */
export async function syncWinstonConnectedOnAccept(
  connection: WinstonConnection
): Promise<void> {
  const { requester_user_name, recipient_user_name, requester_label, recipient_label } = connection;
  if (!recipient_user_name || !requester_label || !recipient_label) return;

  await Promise.all([
    // Requester's list: find the person whose name matches how the accepter calls themselves
    query(
      `UPDATE key_people SET winston_connected = true
       WHERE user_name = $1 AND LOWER(name) = LOWER($2)`,
      [requester_user_name, recipient_label]
    ).catch((err) => logger.warn({ err, userName: requester_user_name }, "[Connect] key_people sync failed for requester")),

    // Recipient's list: find the person whose name matches how the requester calls themselves
    query(
      `UPDATE key_people SET winston_connected = true
       WHERE user_name = $1 AND LOWER(name) = LOWER($2)`,
      [recipient_user_name, requester_label]
    ).catch((err) => logger.warn({ err, userName: recipient_user_name }, "[Connect] key_people sync failed for recipient")),
  ]);

  logger.info(
    { requester: requester_user_name, recipient: recipient_user_name, requesterLabel: requester_label, recipientLabel: recipient_label },
    "[Connect] winston_connected synced to key_people for both sides"
  );
}
