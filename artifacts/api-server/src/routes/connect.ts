import { Router, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import {
  createInvite,
  acceptInvite,
  syncWinstonConnectedOnAccept,
  getConnections,
  getPendingInvites,
  saveConnectMessage,
  markMessageDelivered,
  getSharedListForConnection,
  getSharedListItems,
  addSharedListItem,
  toggleSharedListItem,
  deleteSharedListItem,
  createSharedList,
  updateConnectionProfile,
} from "../connect/connectManager.js";
import {
  createGroup,
  getGroupsForUser,
  getGroup,
  getGroupWithMemberDetails,
  addGroupMember,
  removeGroupMember,
  deleteGroup,
  renameGroup,
  saveGroupMessage,
} from "../connect/groupManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { fetchEventsForDateRange, createCalendarEvent } from "../google/calendar.js";

const router = Router();

// ── POST /api/connect/invite ──────────────────────────────────────────────────

router.post("/connect/invite", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { yourName } = req.body as { yourName?: string };

  if (!yourName) {
    res.status(400).json({ error: "yourName is required (how you want to appear to the other user)" });
    return;
  }

  try {
    const { inviteToken, id } = await createInvite(userName, yourName);
    req.log.info({ userName, id }, "[Connect] Invite created");
    res.json({
      inviteToken,
      connectionId: id,
      instructions: `Share this token with the other Winston user. They call POST /api/connect/accept with this token to link your companions.`,
    });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to create invite");
    res.status(500).json({ error: "Failed to create invite" });
  }
});

// ── POST /api/connect/accept ──────────────────────────────────────────────────

router.post("/connect/accept", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { inviteToken, yourName } = req.body as { inviteToken?: string; yourName?: string };

  if (!inviteToken || !yourName) {
    res.status(400).json({ error: "inviteToken and yourName are required" });
    return;
  }

  try {
    const connection = await acceptInvite(userName, inviteToken, yourName);
    if (!connection) {
      res.status(404).json({ error: "Invite not found or already accepted" });
      return;
    }

    req.log.info({ connectionId: connection.id, userName }, "[Connect] Invite accepted");

    // Sync winston_connected flag in key_people for both users
    syncWinstonConnectedOnAccept(connection).catch((err) =>
      req.log.warn({ err }, "[Connect] key_people sync after accept failed")
    );

    // Use the requester's persona name so the notification reflects their companion
    const requesterProfile = await getProfile(connection.requester_user_name).catch(() => null);
    const connectName = `${requesterProfile?.companionName ?? "Winston"} Connect`;

    await sendPushToAll({
      title: connectName,
      body: `${yourName} accepted your ${connectName} invite!`,
      tag: "connect-accepted",
      notificationType: "connect-accepted",
      companionMessage: `${yourName} has joined your ${connectName}! You can now send each other reminders, messages, and share a shopping list through your companions.`,
      requireInteraction: true,
    }, connection.requester_user_name).catch(() => {});

    res.json({ success: true, connection });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to accept invite");
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

// ── GET /api/connect/connections ──────────────────────────────────────────────

router.get("/connect/connections", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const [connections, pendingInvites] = await Promise.all([
      getConnections(userName),
      getPendingInvites(userName),
    ]);
    res.json({ connections, pendingInvites });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to get connections");
    res.status(500).json({ error: "Failed to get connections" });
  }
});

// ── POST /api/connect/message ─────────────────────────────────────────────────

router.post("/connect/message", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { recipientUserName, messageText, senderName } = req.body as {
    recipientUserName?: string;
    messageText?: string;
    senderName?: string;
  };

  if (!recipientUserName || !messageText) {
    res.status(400).json({ error: "recipientUserName and messageText are required" });
    return;
  }

  try {
    const displayName = senderName ?? userName;
    const msgId = await saveConnectMessage(userName, recipientUserName, "message", messageText);
    const companionMessage = `Message from ${displayName}: "${messageText}"`;

    const result = await sendPushToAll({
      title: `Message from ${displayName}`,
      body: messageText,
      tag: `connect-message-${msgId}`,
      notificationType: "connect-message",
      companionMessage,
      requireInteraction: true,
    }, recipientUserName);

    if (result.sent > 0) {
      await markMessageDelivered(msgId);
    }

    req.log.info({ msgId, recipientUserName, sent: result.sent }, "[Connect] Message sent");
    res.json({ success: true, messageId: msgId, delivered: result.sent > 0 });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to send message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ── POST /api/connect/reminder ────────────────────────────────────────────────

router.post("/connect/reminder", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { recipientUserName, reminderText, senderName } = req.body as {
    recipientUserName?: string;
    reminderText?: string;
    senderName?: string;
  };

  if (!recipientUserName || !reminderText) {
    res.status(400).json({ error: "recipientUserName and reminderText are required" });
    return;
  }

  try {
    const displayName = senderName ?? userName;
    const msgId = await saveConnectMessage(userName, recipientUserName, "reminder", reminderText);
    const companionMessage = `Reminder from ${displayName}: ${reminderText}`;

    const result = await sendPushToAll({
      title: `Reminder from ${displayName}`,
      body: reminderText,
      tag: `connect-reminder-${msgId}`,
      notificationType: "connect-reminder",
      companionMessage,
      requireInteraction: true,
    }, recipientUserName);

    if (result.sent > 0) {
      await markMessageDelivered(msgId);
    }

    req.log.info({ msgId, recipientUserName, sent: result.sent }, "[Connect] Reminder sent");
    res.json({ success: true, messageId: msgId, delivered: result.sent > 0 });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to send reminder");
    res.status(500).json({ error: "Failed to send reminder" });
  }
});

// ── GET /api/connect/shared-list/:connectionId ────────────────────────────────

router.get("/connect/shared-list/:connectionId", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const connectionId = parseInt(req.params.connectionId ?? "", 10);
  if (isNaN(connectionId)) {
    res.status(400).json({ error: "Invalid connectionId" });
    return;
  }

  try {
    const list = await getSharedListForConnection(connectionId);
    if (!list) {
      res.json({ list: null, items: [] });
      return;
    }
    const items = await getSharedListItems(list.id);
    res.json({ list, items });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to get shared list");
    res.status(500).json({ error: "Failed to get shared list" });
  }
});

// ── POST /api/connect/shared-list/:connectionId/items ────────────────────────

router.post("/connect/shared-list/:connectionId/items", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const connectionId = parseInt(req.params.connectionId ?? "", 10);
  const { text } = req.body as { text?: string };

  if (isNaN(connectionId) || !text) {
    res.status(400).json({ error: "connectionId and text are required" });
    return;
  }

  try {
    let list = await getSharedListForConnection(connectionId);
    if (!list) {
      list = await createSharedList(connectionId, userName);
    }

    const item = await addSharedListItem(list.id, text.trim(), userName);
    res.json({ success: true, item });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to add shared list item");
    res.status(500).json({ error: "Failed to add item" });
  }
});

// ── PATCH /api/connect/shared-list/:connectionId/items/:itemId ───────────────

router.patch("/connect/shared-list/:connectionId/items/:itemId", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const connectionId = parseInt(req.params.connectionId ?? "", 10);
  const itemId = parseInt(req.params.itemId ?? "", 10);

  if (isNaN(connectionId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid IDs" });
    return;
  }

  try {
    const list = await getSharedListForConnection(connectionId);
    if (!list) {
      res.status(404).json({ error: "Shared list not found" });
      return;
    }
    const item = await toggleSharedListItem(itemId, list.id);
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json({ success: true, item });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to toggle item");
    res.status(500).json({ error: "Failed to toggle item" });
  }
});

// ── DELETE /api/connect/shared-list/:connectionId/items/:itemId ──────────────

router.delete("/connect/shared-list/:connectionId/items/:itemId", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const connectionId = parseInt(req.params.connectionId ?? "", 10);
  const itemId = parseInt(req.params.itemId ?? "", 10);

  if (isNaN(connectionId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid IDs" });
    return;
  }

  try {
    const list = await getSharedListForConnection(connectionId);
    if (!list) {
      res.status(404).json({ error: "Shared list not found" });
      return;
    }
    const deleted = await deleteSharedListItem(itemId, list.id);
    res.json({ success: deleted });
  } catch (err) {
    req.log.error({ err }, "[Connect] Failed to delete item");
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ══ GROUP ENDPOINTS ═══════════════════════════════════════════════════════════

// ── POST /api/connect/groups/create ──────────────────────────────────────────
// Body: { name: string, members?: string[] }

router.post("/connect/groups/create", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { name, members } = req.body as { name?: string; members?: string[] };
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const group = await createGroup(userName, name.trim(), members ?? []);
    req.log.info({ groupId: group.id, userName }, "[Groups] Group created");
    res.json({ success: true, group });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to create group");
    res.status(500).json({ error: "Failed to create group" });
  }
});

// ── GET /api/connect/groups ───────────────────────────────────────────────────

router.get("/connect/groups", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const groups = await getGroupsForUser(userName);
    res.json({ groups });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to get groups");
    res.status(500).json({ error: "Failed to get groups" });
  }
});

// ── GET /api/connect/groups/:id ───────────────────────────────────────────────

router.get("/connect/groups/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  try {
    const group = await getGroupWithMemberDetails(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }
    res.json({ group });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to get group detail");
    res.status(500).json({ error: "Failed to get group" });
  }
});

// ── POST /api/connect/groups/:id/add-member ───────────────────────────────────
// Body: { userName: string }

router.post("/connect/groups/:id/add-member", async (req: Request, res: Response) => {
  const currentUser = await authenticate(req, res);
  if (!currentUser) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { userName: newMember } = req.body as { userName?: string };
  if (!newMember) {
    res.status(400).json({ error: "userName is required" });
    return;
  }

  try {
    const ok = await addGroupMember(groupId, newMember, currentUser);
    if (!ok) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    req.log.info({ groupId, newMember }, "[Groups] Member added");
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to add member";
    res.status(403).json({ error: msg });
  }
});

// ── DELETE /api/connect/groups/:id/remove-member ──────────────────────────────
// Body: { userName: string }

router.delete("/connect/groups/:id/remove-member", async (req: Request, res: Response) => {
  const currentUser = await authenticate(req, res);
  if (!currentUser) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { userName: memberToRemove } = req.body as { userName?: string };
  if (!memberToRemove) {
    res.status(400).json({ error: "userName is required" });
    return;
  }

  try {
    const ok = await removeGroupMember(groupId, memberToRemove, currentUser);
    res.json({ success: ok });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to remove member";
    res.status(403).json({ error: msg });
  }
});

// ── DELETE /api/connect/groups/:id ────────────────────────────────────────────

router.delete("/connect/groups/:id", async (req: Request, res: Response) => {
  const currentUser = await authenticate(req, res);
  if (!currentUser) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  try {
    const ok = await deleteGroup(groupId, currentUser);
    if (!ok) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to delete group";
    res.status(403).json({ error: msg });
  }
});

// ── PUT /api/connect/groups/:id/rename ────────────────────────────────────────
// Body: { name: string }

router.put("/connect/groups/:id/rename", async (req: Request, res: Response) => {
  const currentUser = await authenticate(req, res);
  if (!currentUser) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { name } = req.body as { name?: string };
  if (!name || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const group = await renameGroup(groupId, name.trim(), currentUser);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    res.json({ success: true, group });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to rename group";
    res.status(403).json({ error: msg });
  }
});

// ── POST /api/connect/groups/:id/message ──────────────────────────────────────
// Body: { messageText: string }

router.post("/connect/groups/:id/message", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { messageText } = req.body as { messageText?: string };
  if (!messageText) {
    res.status(400).json({ error: "messageText is required" });
    return;
  }

  try {
    const group = await getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }

    await saveGroupMessage(groupId, userName, "message", messageText);

    const recipients = group.members.filter((m) => m !== userName);
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sendPushToAll({
          title: `Group message: ${group.name}`,
          body: messageText,
          tag: `group-${groupId}-msg-${Date.now()}`,
          notificationType: "connect-message",
          companionMessage: `Group message from ${userName} in "${group.name}": "${messageText}"`,
          requireInteraction: false,
        }, r)
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    req.log.info({ groupId, sent, total: recipients.length }, "[Groups] Group message sent");
    res.json({ success: true, recipientCount: recipients.length, sent });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to send group message");
    res.status(500).json({ error: "Failed to send group message" });
  }
});

// ── POST /api/connect/groups/:id/reminder ─────────────────────────────────────
// Body: { reminderText: string }

router.post("/connect/groups/:id/reminder", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { reminderText } = req.body as { reminderText?: string };
  if (!reminderText) {
    res.status(400).json({ error: "reminderText is required" });
    return;
  }

  try {
    const group = await getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }

    await saveGroupMessage(groupId, userName, "reminder", reminderText);

    const recipients = group.members.filter((m) => m !== userName);
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sendPushToAll({
          title: `Reminder from ${group.name}`,
          body: reminderText,
          tag: `group-${groupId}-reminder-${Date.now()}`,
          notificationType: "connect-reminder",
          companionMessage: `Group reminder from "${group.name}": ${reminderText}`,
          requireInteraction: true,
        }, r)
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    req.log.info({ groupId, sent }, "[Groups] Group reminder sent");
    res.json({ success: true, recipientCount: recipients.length, sent });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to send group reminder");
    res.status(500).json({ error: "Failed to send group reminder" });
  }
});

// ── POST /api/connect/groups/:id/find-time ────────────────────────────────────
// Finds mutually available 1-hour slots across all group members who have Google Calendar.
// Body: { startDate: string (YYYY-MM-DD), endDate: string (YYYY-MM-DD), durationMinutes?: number }

router.post("/connect/groups/:id/find-time", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { startDate, endDate, durationMinutes = 60 } = req.body as {
    startDate?: string;
    endDate?: string;
    durationMinutes?: number;
  };

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  try {
    const group = await getGroupWithMemberDetails(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }

    // Split members: those with Google Calendar vs. those without
    const withCalendar: string[] = [];
    const withoutCalendar: string[] = [];
    for (const m of group.memberDetails) {
      if (m.winstonConnected) withCalendar.push(m.username);
      else withoutCalendar.push(m.username);
    }

    // Fetch busy blocks for the requested date range (not just the current week)
    const memberBusyMap = new Map<string, Array<{ start: number; end: number }>>();

    await Promise.allSettled(
      withCalendar.map(async (member) => {
        try {
          const events = await fetchEventsForDateRange(startDate, endDate, member);
          if (!events) return;
          const busy: Array<{ start: number; end: number }> = [];
          for (const ev of events) {
            if (ev.allDay || !ev.startIso || !ev.endIso) continue;
            busy.push({ start: new Date(ev.startIso).getTime(), end: new Date(ev.endIso).getTime() });
          }
          memberBusyMap.set(member, busy);
        } catch {
          // No calendar data available — skip
        }
      })
    );

    // Send push to members without Google Calendar asking them to share availability
    if (withoutCalendar.length > 0) {
      const requesterDetail = group.memberDetails.find((m) => m.username === userName);
      const requesterName = requesterDetail?.name ?? userName;
      await Promise.allSettled(
        withoutCalendar
          .filter((m) => m !== userName)
          .map((m) =>
            sendPushToAll(
              {
                title: `${group.name} — Scheduling`,
                body: `${requesterName} is looking for a time that works for everyone. Please reply with your availability for ${startDate} – ${endDate}.`,
                tag: `group-${groupId}-findtime-${Date.now()}`,
                notificationType: "connect-message",
                companionMessage: `${requesterName} wants to find a meeting time for "${group.name}" (${startDate} – ${endDate}). Check with them directly about your availability.`,
                requireInteraction: true,
              },
              m
            )
          )
      );
    }

    // Generate candidate slots (9am–6pm CT, every 30 min) across the date range
    const dur = (durationMinutes ?? 60) * 60 * 1000;
    const participatingMembers = [...memberBusyMap.keys()];
    const allSlots: Array<{ start: string; end: string; label: string }> = [];

    // Walk day by day from startDate to endDate
    const rangeStart = new Date(startDate + "T12:00:00Z");
    const rangeEnd = new Date(endDate + "T12:00:00Z");

    for (
      const cursor = new Date(rangeStart);
      cursor <= rangeEnd && allSlots.length < 50;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      // Skip Sundays (0) — keep Mon–Sat; adjust to taste
      const ctDate = new Date(cursor.toLocaleString("en-US", { timeZone: "America/Chicago" }));
      if (ctDate.getDay() === 0) continue;

      // CT midnight of this day
      const ctDateStr = cursor.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const ctParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" })
        .formatToParts(cursor);
      const offsetStr = ctParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
      const offsetHours = parseInt(offsetStr.replace("GMT", "") || "-5", 10);
      const utcHour = String(-offsetHours).padStart(2, "0");
      const ctMidnight = new Date(`${ctDateStr}T${utcHour}:00:00.000Z`);

      // 9am CT = ctMidnight + 9h, 6pm CT = ctMidnight + 18h
      const dayStart = ctMidnight.getTime() + 9 * 3600000;
      const dayEnd = ctMidnight.getTime() + 18 * 3600000;

      let slotStart = dayStart;
      while (slotStart + dur <= dayEnd && allSlots.length < 50) {
        const slotEnd = slotStart + dur;
        let isFree = true;

        for (const [, busy] of memberBusyMap) {
          for (const b of busy) {
            if (slotStart < b.end && slotEnd > b.start) {
              isFree = false;
              break;
            }
          }
          if (!isFree) break;
        }

        if (isFree) {
          const startDt = new Date(slotStart);
          const endDt = new Date(slotEnd);
          const label = startDt.toLocaleString("en-US", {
            timeZone: "America/Chicago",
            weekday: "long",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          allSlots.push({ start: startDt.toISOString(), end: endDt.toISOString(), label });
        }
        slotStart += 30 * 60 * 1000;
      }
    }

    // Return top 3 free slots
    const suggestedSlots = allSlots.slice(0, 3);

    req.log.info(
      { groupId, slotsFound: suggestedSlots.length, membersChecked: participatingMembers.length, notified: withoutCalendar.length },
      "[Groups] find-time complete"
    );
    res.json({
      group: group.name,
      membersWithCalendar: withCalendar,
      membersWithoutCalendar: withoutCalendar,
      durationMinutes,
      suggestedSlots,
      note: withoutCalendar.length > 0
        ? `${withoutCalendar.length} member(s) without Google Calendar have been notified to share their availability.`
        : undefined,
    });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to find time");
    res.status(500).json({ error: "Failed to find available time slots" });
  }
});

// ── POST /api/connect/groups/:id/propose-time ─────────────────────────────────
// Body: { start: string (ISO), end: string (ISO), title: string, message?: string }

router.post("/connect/groups/:id/propose-time", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { start, end, title, message: extraMessage } = req.body as {
    start?: string;
    end?: string;
    title?: string;
    message?: string;
  };

  if (!start || !end || !title) {
    res.status(400).json({ error: "start, end, and title are required" });
    return;
  }

  try {
    const group = await getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }

    const startDt = new Date(start);
    const label = startDt.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    const proposalText = `Time proposal for "${group.name}": ${title} on ${label}${extraMessage ? ` — ${extraMessage}` : ""}`;
    await saveGroupMessage(groupId, userName, "proposal", proposalText);

    const recipients = group.members.filter((m) => m !== userName);
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sendPushToAll({
          title: `Time Proposal: ${group.name}`,
          body: `${title} — ${label}`,
          tag: `group-${groupId}-proposal-${Date.now()}`,
          notificationType: "connect-message",
          companionMessage: proposalText,
          requireInteraction: true,
        }, r)
      )
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    req.log.info({ groupId, sent }, "[Groups] Time proposal sent");
    res.json({ success: true, proposalText, recipientCount: recipients.length, sent });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to propose time");
    res.status(500).json({ error: "Failed to propose time" });
  }
});

// ── POST /api/connect/groups/:id/confirm-time ─────────────────────────────────
// Confirms a proposed time, adds to calendars of all Winston members with Google Calendar,
// and sends a notification to all members (including non-Winston members via message).
// Body: { start: string (ISO), end: string (ISO), title: string, location?: string, description?: string }

router.post("/connect/groups/:id/confirm-time", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const groupId = parseInt(req.params.id ?? "", 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }

  const { start, end, title, location, description } = req.body as {
    start?: string;
    end?: string;
    title?: string;
    location?: string;
    description?: string;
  };

  if (!start || !end || !title) {
    res.status(400).json({ error: "start, end, and title are required" });
    return;
  }

  try {
    const group = await getGroup(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    if (!group.members.includes(userName)) {
      res.status(403).json({ error: "Not a group member" });
      return;
    }

    const startDt = new Date(start);
    const endDt = new Date(end);
    const label = startDt.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    // Add to Google Calendar for each member who has access
    const calendarResults: Array<{ member: string; eventId?: string; ok: boolean }> = [];
    await Promise.allSettled(
      group.members.map(async (member) => {
        try {
          const result = await createCalendarEvent({
            summary: title,
            description: description ?? `Group event: ${group.name}`,
            location: location ?? "",
            startIso: startDt.toISOString(),
            endIso: endDt.toISOString(),
            userName: member,
          });
          calendarResults.push({ member, eventId: result?.id ?? undefined, ok: !!result });
        } catch {
          calendarResults.push({ member, ok: false });
        }
      })
    );

    // Notify all members
    const confirmText = `Confirmed: "${title}" on ${label}${location ? ` at ${location}` : ""}`;
    await saveGroupMessage(groupId, userName, "confirm", confirmText);

    const recipients = group.members.filter((m) => m !== userName);
    await Promise.allSettled(
      recipients.map((r) =>
        sendPushToAll({
          title: `Confirmed: ${group.name}`,
          body: `${title} — ${label}`,
          tag: `group-${groupId}-confirm-${Date.now()}`,
          notificationType: "connect-message",
          companionMessage: `${confirmText}. It's been added to your calendar.`,
          requireInteraction: true,
        }, r)
      )
    );

    const addedToCalendar = calendarResults.filter((r) => r.ok).map((r) => r.member);
    req.log.info({ groupId, addedToCalendar }, "[Groups] Time confirmed");
    res.json({
      success: true,
      confirmText,
      calendarAddedFor: addedToCalendar,
      calendarResults,
    });
  } catch (err) {
    req.log.error({ err }, "[Groups] Failed to confirm time");
    res.status(500).json({ error: "Failed to confirm time" });
  }
});

// ── PATCH /api/connect/:id/profile ──────────────────────────────────────────
// Updates date_of_birth and/or key_dates on a connection profile.
// Body: { dateOfBirth?: "YYYY-MM-DD" | null, keyDates?: [{ label, date }] | null }
router.patch(
  "/connect/:id/profile",
  express.json({ limit: "1mb" }),
  async (req: Request, res: Response) => {
    const userName = await authenticate(req, res);
    if (!userName) return;

    const id = parseInt(String(req.params["id"] ?? ""), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "invalid connection id" });
      return;
    }

    const body = req.body as { dateOfBirth?: string | null; keyDates?: Array<{ label: string; date: string }> | null };

    const data: Parameters<typeof updateConnectionProfile>[2] = {};
    if ("dateOfBirth" in body) data.dateOfBirth = body.dateOfBirth ?? null;
    if ("keyDates" in body)    data.keyDates    = Array.isArray(body.keyDates) ? body.keyDates : null;

    if (!Object.keys(data).length) {
      res.status(400).json({ error: "Provide dateOfBirth and/or keyDates" });
      return;
    }

    try {
      const updated = await updateConnectionProfile(id, userName, data);
      if (!updated) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      req.log.info({ userName, id, fields: Object.keys(data) }, "[Connect] Profile updated");
      res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "[Connect] PATCH /connect/:id/profile error");
      res.status(500).json({ error: "Failed to update connection profile" });
    }
  }
);

export { logger };
export default router;
