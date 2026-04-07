import { Router, type Request, type Response } from "express";
import { query } from "../db.js";
import { validateSession } from "../auth/sessionAuth.js";
import { broadcastToUser } from "../reminders/sseStore.js";

const router = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getUserName(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const session = await validateSession(authHeader.slice(7));
  return session?.userName ?? null;
}

// ── GET /api/messages — load recent messages ─────────────────────────────────
router.get("/messages", async (req: Request, res: Response) => {
  try {
    const userName = await getUserName(req);
    if (!userName) { res.status(401).json({ error: "unauthorized" }); return; }

    const limit = Math.min(Number(req.query.limit) || 100, 200);

    const { rows } = await query<{
      id: number;
      role: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT id, role, content, created_at
       FROM chat_messages
       WHERE user_name = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [userName, limit]
    );

    // Return in chronological order (oldest first)
    const messages = rows.reverse().map((r) => ({
      id: `db-${r.id}`,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));

    res.json({ messages });
  } catch (err) {
    req.log.error({ err }, "Messages load error");
    res.status(500).json({ error: "server_error" });
  }
});

// ── POST /api/messages — save messages ───────────────────────────────────────
router.post("/messages", async (req: Request, res: Response) => {
  try {
    const userName = await getUserName(req);
    if (!userName) { res.status(401).json({ error: "unauthorized" }); return; }

    const { messages } = req.body as {
      messages: Array<{ role: string; content: string }>;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages_required" });
      return;
    }

    // Insert all messages — skip system messages
    const toSave = messages.filter(
      (m) => m.role === "user" || m.role === "assistant"
    );

    const senderDeviceId = (req.body as { deviceId?: string }).deviceId ?? null;
    const savedAt = new Date().toISOString();

    for (const m of toSave) {
      await query(
        "INSERT INTO chat_messages (user_name, role, content) VALUES ($1, $2, $3)",
        [userName, m.role, m.content.slice(0, 8000)] // cap at 8k chars
      );
      // Broadcast to all other devices for this user so chat stays in sync
      broadcastToUser(userName, "chat_sync", {
        role: m.role,
        content: m.content.slice(0, 8000),
        createdAt: savedAt,
        senderDeviceId,
      });
    }

    // Auto-prune messages older than 14 days to keep DB tidy
    await query(
      "DELETE FROM chat_messages WHERE user_name = $1 AND created_at < NOW() - INTERVAL '14 days'",
      [userName]
    ).catch(() => {});

    res.json({ saved: toSave.length });
  } catch (err) {
    req.log.error({ err }, "Messages save error");
    res.status(500).json({ error: "server_error" });
  }
});

// ── DELETE /api/messages — clear conversation history ────────────────────────
router.delete("/messages", async (req: Request, res: Response) => {
  try {
    const userName = await getUserName(req);
    if (!userName) { res.status(401).json({ error: "unauthorized" }); return; }

    await query("DELETE FROM chat_messages WHERE user_name = $1", [userName]);
    res.json({ cleared: true });
  } catch (err) {
    req.log.error({ err }, "Messages clear error");
    res.status(500).json({ error: "server_error" });
  }
});

export default router;
