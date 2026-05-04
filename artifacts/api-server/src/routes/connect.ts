import { Router, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { logger } from "../lib/logger.js";
import {
  createInvite,
  acceptInvite,
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
} from "../connect/connectManager.js";
import { sendPushToAll } from "../push/pushManager.js";

const router = Router();

// ── POST /api/connect/invite ──────────────────────────────────────────────────
// Generate a one-time invite token. Share it with the other Winston user who
// will call /connect/accept to establish the connection.
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
// Accept an invite using the token. Establishes the connection and creates a
// shared list. Sends a push notification to the requester.
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

    // Notify the requester that their invite was accepted
    await sendPushToAll({
      title: "Winston Connect",
      body: `${yourName} accepted your Winston Connect invite!`,
      tag: "connect-accepted",
      notificationType: "connect-accepted",
      companionMessage: `${yourName} has joined your Winston Connect! You can now send each other reminders, messages, and share a shopping list through your companions.`,
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
// Send a voice/text message to a connected user. Their companion reads it aloud.
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
// Send a reminder to a connected user. Delivered as a push notification;
// their companion speaks the reminder text aloud when tapped.
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

export { logger };
export default router;
