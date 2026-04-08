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

// ── GET /api/messages/search — full-text search across archived transcripts ───
// Used when the user asks "what did I say about X last week / last month".
// Returns matching excerpts from the last `days` days (default 90).
// This is the ONLY way archived conversations reach Claude — never auto-loaded.
router.get("/messages/search", async (req: Request, res: Response) => {
  try {
    const userName = await getUserName(req);
    if (!userName) { res.status(401).json({ error: "unauthorized" }); return; }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const days = Math.min(Number(req.query.days) || 90, 365);

    if (!q || q.length < 2) {
      res.status(400).json({ error: "q param required (min 2 chars)" });
      return;
    }

    const { rows } = await query<{
      role: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE user_name = $1
         AND created_at >= NOW() - ($2 || ' days')::interval
         AND content ILIKE '%' || $3 || '%'
       ORDER BY created_at DESC
       LIMIT 10`,
      [userName, days.toString(), q]
    );

    const hits = rows.map((r) => ({
      role: r.role,
      excerpt: r.content.slice(0, 400),
      date: r.created_at.toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago",
      }),
    }));

    res.json({ hits, query: q, days });
  } catch (err) {
    req.log.error({ err }, "Transcript search error");
    res.status(500).json({ error: "server_error" });
  }
});

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

    // Archive: keep 365 days of messages. chat_messages is the full transcript store —
    // Layer 2 of conversation memory. Claude never auto-loads old messages; they are
    // only surfaced on demand via GET /api/messages/search.
    await query(
      "DELETE FROM chat_messages WHERE user_name = $1 AND created_at < NOW() - INTERVAL '365 days'",
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
