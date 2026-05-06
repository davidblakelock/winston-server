/**
 * Winston Connect — Group Management
 *
 * Manages named groups on top of the existing Winston Connect infrastructure.
 * Tables are created on first call to ensureGroupTables().
 */

import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Ensure tables ─────────────────────────────────────────────────────────────

export async function ensureGroupTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS connect_groups (
      id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      name        text NOT NULL,
      created_by  text NOT NULL,
      created_at  timestamptz DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS connect_group_members (
      id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      group_id    integer NOT NULL REFERENCES connect_groups(id) ON DELETE CASCADE,
      user_name   text NOT NULL,
      added_at    timestamptz DEFAULT now(),
      UNIQUE (group_id, user_name)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS connect_group_messages (
      id              integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      group_id        integer NOT NULL REFERENCES connect_groups(id) ON DELETE CASCADE,
      sender_user_name text NOT NULL,
      message_type    text NOT NULL DEFAULT 'message',
      message_text    text NOT NULL,
      created_at      timestamptz DEFAULT now()
    )
  `);

  logger.info("[Groups] Tables ready");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectGroup {
  id: number;
  name: string;
  created_by: string;
  created_at: string;
}

export interface ConnectGroupMember {
  id: number;
  group_id: number;
  user_name: string;
  added_at: string;
}

export interface ConnectGroupWithMembers extends ConnectGroup {
  members: string[];
}

// ── Group CRUD ────────────────────────────────────────────────────────────────

export async function createGroup(
  createdBy: string,
  name: string,
  initialMembers: string[] = []
): Promise<ConnectGroupWithMembers> {
  const { rows } = await query<ConnectGroup>(
    `INSERT INTO connect_groups (name, created_by) VALUES ($1, $2) RETURNING *`,
    [name.trim(), createdBy]
  );
  const group = rows[0]!;

  // Add creator + initial members (deduplicate)
  const allMembers = [...new Set([createdBy, ...initialMembers])];
  for (const member of allMembers) {
    await query(
      `INSERT INTO connect_group_members (group_id, user_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [group.id, member]
    );
  }

  logger.info({ groupId: group.id, name, members: allMembers }, "[Groups] Group created");
  return { ...group, members: allMembers };
}

export async function getGroupsForUser(userName: string): Promise<ConnectGroupWithMembers[]> {
  const { rows: memberRows } = await query<{ group_id: number }>(
    `SELECT group_id FROM connect_group_members WHERE user_name = $1`,
    [userName]
  );

  if (memberRows.length === 0) return [];

  const groupIds = memberRows.map((r) => r.group_id);
  const placeholders = groupIds.map((_, i) => `$${i + 1}`).join(", ");
  const { rows: groups } = await query<ConnectGroup>(
    `SELECT * FROM connect_groups WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
    groupIds
  );

  const result: ConnectGroupWithMembers[] = [];
  for (const g of groups) {
    const { rows: mRows } = await query<{ user_name: string }>(
      `SELECT user_name FROM connect_group_members WHERE group_id = $1 ORDER BY added_at`,
      [g.id]
    );
    result.push({ ...g, members: mRows.map((r) => r.user_name) });
  }

  return result;
}

export async function getGroup(groupId: number): Promise<ConnectGroupWithMembers | null> {
  const { rows } = await query<ConnectGroup>(
    `SELECT * FROM connect_groups WHERE id = $1`,
    [groupId]
  );
  if (!rows[0]) return null;
  const { rows: mRows } = await query<{ user_name: string }>(
    `SELECT user_name FROM connect_group_members WHERE group_id = $1 ORDER BY added_at`,
    [groupId]
  );
  return { ...rows[0], members: mRows.map((r) => r.user_name) };
}

export async function addGroupMember(
  groupId: number,
  newMember: string,
  requestingUser: string
): Promise<boolean> {
  const group = await getGroup(groupId);
  if (!group) return false;

  if (!group.members.includes(requestingUser)) {
    throw new Error("Not a group member");
  }

  await query(
    `INSERT INTO connect_group_members (group_id, user_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [groupId, newMember]
  );
  logger.info({ groupId, newMember, requestingUser }, "[Groups] Member added");
  return true;
}

export async function removeGroupMember(
  groupId: number,
  memberToRemove: string,
  requestingUser: string
): Promise<boolean> {
  const group = await getGroup(groupId);
  if (!group) return false;

  if (group.created_by !== requestingUser && requestingUser !== memberToRemove) {
    throw new Error("Only the group creator can remove other members");
  }

  const { rows } = await query<{ id: number }>(
    `DELETE FROM connect_group_members WHERE group_id = $1 AND user_name = $2 RETURNING id`,
    [groupId, memberToRemove]
  );
  logger.info({ groupId, memberToRemove }, "[Groups] Member removed");
  return rows.length > 0;
}

export async function deleteGroup(groupId: number, requestingUser: string): Promise<boolean> {
  const group = await getGroup(groupId);
  if (!group) return false;

  if (group.created_by !== requestingUser) {
    throw new Error("Only the group creator can delete the group");
  }

  await query(`DELETE FROM connect_groups WHERE id = $1`, [groupId]);
  logger.info({ groupId, requestingUser }, "[Groups] Group deleted");
  return true;
}

export async function renameGroup(
  groupId: number,
  newName: string,
  requestingUser: string
): Promise<ConnectGroup | null> {
  const group = await getGroup(groupId);
  if (!group) return null;

  if (group.created_by !== requestingUser) {
    throw new Error("Only the group creator can rename the group");
  }

  const { rows } = await query<ConnectGroup>(
    `UPDATE connect_groups SET name = $1 WHERE id = $2 RETURNING *`,
    [newName.trim(), groupId]
  );
  logger.info({ groupId, newName }, "[Groups] Group renamed");
  return rows[0] ?? null;
}

export async function saveGroupMessage(
  groupId: number,
  senderUserName: string,
  messageType: string,
  messageText: string
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO connect_group_messages (group_id, sender_user_name, message_type, message_text)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, senderUserName, messageType, messageText]
  );
  return rows[0]!.id;
}
