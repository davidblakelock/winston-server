import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { query } from "../db.js";
import { addClient, removeClient, broadcast, registerClientUser } from "../reminders/sseStore.js";
import { createReminder } from "../reminders/reminderManager.js";
import { validateSession } from "../auth/sessionAuth.js";

const router: IRouter = Router();

// ── In-memory deduplication cache for /reminders/due ─────────────────────────
// Multiple devices polling the same endpoint within a short window return the
// cached result so only one real DB query fires per 10-second window.
let dueCache: { data: unknown[]; expiry: number } | null = null;
const DUE_CACHE_TTL_MS = 10_000;

// ── SSE stream ────────────────────────────────────────────────────────────────
router.get("/reminders/stream", async (req: Request, res: Response) => {
  const clientId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`: connected\n\n`);
  addClient(clientId, res);

  // Identify the connected user so we can route user-specific events (e.g. chat_sync).
  // The token is passed as a query param because EventSource doesn't support custom headers.
  const token = req.query.token as string | undefined;
  if (token) {
    try {
      const session = await validateSession(token);
      if (session?.userName) registerClientUser(clientId, session.userName);
    } catch { /* non-fatal — user just won't get user-scoped events */ }
  }

  // Send a keepalive ping every 30 s as an SSE comment.
  // This resets the production proxy's idle timeout, preventing the
  // connection from being killed at the proxy's 5-minute hard limit.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
      // Explicit flush to push the ping through proxies immediately.
      // Required for Replit's nginx proxy which buffers SSE by default.
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000); // 25s — safely under any 30s proxy idle timeout

  req.on("close", () => { clearInterval(heartbeat); removeClient(clientId); });
});

// ── GET /api/reminders — all reminders (for settings/display) ─────────────────
router.get("/reminders", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, recurring, recurring_time,
            timezone, status, last_fired_at, created_at
       FROM reminders
      ORDER BY fire_at ASC`
  );
  res.json(rows);
});

// ── GET /api/reminders/list — alias used by some frontend callers ─────────────
router.get("/reminders/list", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, recurring, recurring_time,
            timezone, status, last_fired_at, created_at
       FROM reminders
      WHERE status = 'pending'
      ORDER BY fire_at ASC`
  );
  res.json(rows);
});

// ── GET /api/reminders/due ────────────────────────────────────────────────────
// Returns reminders that fired in the last 10 minutes (status = 'fired').
// The frontend polls this every 30 s as a reliable fallback for when the SSE
// stream drops on mobile — it speaks any reminder it hasn't already spoken
// (tracked client-side by reminder ID).
// No-cache headers ensure the browser always fetches fresh data.
router.get("/reminders/due", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  // Return cached result if a query fired within the last 10 seconds.
  // This prevents multiple devices polling simultaneously from each
  // triggering a separate DB round-trip.
  if (dueCache && Date.now() < dueCache.expiry) {
    res.json(dueCache.data);
    return;
  }

  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, status, last_fired_at
       FROM reminders
      WHERE status = 'fired'
        AND last_fired_at > NOW() - INTERVAL '10 minutes'
      ORDER BY last_fired_at DESC`
  );
  dueCache = { data: rows, expiry: Date.now() + DUE_CACHE_TTL_MS };
  res.json(rows);
});

// ── POST /api/reminders — create a reminder ───────────────────────────────────
router.post("/reminders", async (req: Request, res: Response) => {
  const { userName, reminderText, fireAt, recurring, recurringTime, timezone } = req.body;

  if (!reminderText || !fireAt) {
    res.status(400).json({ error: "reminderText and fireAt are required" });
    return;
  }

  // createReminder handles duplicate guard + insert + SSE broadcast
  const reminder = await createReminder({ userName, reminderText, fireAt, recurring, recurringTime, timezone });
  res.json(reminder);
});

// ── DELETE /api/reminders/:id — cancel a reminder by ID ──────────────────────
router.delete("/reminders/:id", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  await query(`DELETE FROM reminders WHERE id = $1`, [id]);
  res.json({ success: true });
  broadcast("reminder_sync", { action: "deleted", id });
});

// ── DELETE /api/reminders/delete — body-based delete (alternate form) ─────────
router.delete("/reminders/delete", async (req: Request, res: Response) => {
  const id = req.body?.id ?? req.query?.id;
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  await query(`DELETE FROM reminders WHERE id = $1`, [id]);
  res.json({ success: true });
  broadcast("reminder_sync", { action: "deleted", id: parseInt(String(id), 10) });
});

// ── POST /api/reminders/:id/snooze — delay a fired reminder by N minutes ─────
router.post("/reminders/:id/snooze", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid reminder ID" }); return; }

  const minutes = typeof req.body?.minutes === "number" ? req.body.minutes : 10;
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000);

  await query(
    `UPDATE reminders
        SET fire_at = $1, status = 'pending', last_fired_at = NULL
      WHERE id = $2`,
    [snoozeUntil, id]
  );
  res.json({ success: true, snoozedUntil: snoozeUntil });
});

// ── POST /api/reminders/:id/acknowledge — mark a reminder as completed ────────
// Called by the frontend after the companion speaks the reminder so it won't be
// returned by /api/reminders/due on subsequent polls from other devices.
// Handles both numeric DB IDs and synthetic string IDs (e.g. med-init-*, briefing-*)
// that have no row in the reminders table — those are acknowledged with 200 immediately.
router.post("/reminders/:id/acknowledge", async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const numId = parseInt(rawId, 10);

  // Non-numeric ID — synthetic reminder (medication init, briefing, etc.) with no DB row.
  // Nothing to update; just return 200 so the frontend can clear it cleanly.
  if (isNaN(numId) || rawId !== String(numId)) {
    res.json({ success: true, synthetic: true });
    return;
  }

  try {
    const result = await query(
      `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status = 'fired'`,
      [numId]
    );
    console.log(`[ACKNOWLEDGE] id=${numId} rowsAffected=${result.rowCount}`);
  } catch (err) {
    console.error(`[ACKNOWLEDGE] Failed to update id=${numId}:`, err);
    res.status(500).json({ error: "acknowledge failed", detail: String(err) });
    return;
  }
  res.json({ success: true });
  // Tell all open panels to remove this reminder
  broadcast("reminder_sync", { action: "completed", id: numId });
});

// ── POST /api/reminders/:id/complete — dismiss from panel (mark completed) ────
// Called when the user taps the dismiss (✓) button in the upcoming reminders panel.
// Also handles synthetic string IDs gracefully.
router.post("/reminders/:id/complete", async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const numId = parseInt(rawId, 10);

  // Non-numeric ID — synthetic reminder with no DB row; return 200 immediately.
  if (isNaN(numId) || rawId !== String(numId)) {
    res.json({ success: true, synthetic: true });
    return;
  }

  await query(
    `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status IN ('pending', 'fired')`,
    [numId]
  );
  res.json({ success: true });
  // Broadcast so all open panels on all devices remove this reminder immediately
  broadcast("reminder_sync", { action: "completed", id: numId });
});

export default router;
