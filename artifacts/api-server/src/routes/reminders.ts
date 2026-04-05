import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { query } from "../db.js";
import { addClient, removeClient, broadcast } from "../reminders/sseStore.js";

const router: IRouter = Router();

// ── SSE stream ────────────────────────────────────────────────────────────────
router.get("/reminders/stream", (req: Request, res: Response) => {
  const clientId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`: connected\n\n`);
  addClient(clientId, res);

  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { clearInterval(heartbeat); }
  }, 25000);

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
// Returns reminders that fired in the last 3 minutes (status = 'fired').
// The frontend polls this every 30 s as a reliable fallback for when the SSE
// stream drops on mobile — it speaks any reminder it hasn't already spoken
// (tracked client-side by reminder ID).
router.get("/reminders/due", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, status, last_fired_at
       FROM reminders
      WHERE status = 'fired'
        AND last_fired_at > NOW() - INTERVAL '3 minutes'
      ORDER BY last_fired_at DESC`
  );
  res.json(rows);
});

// ── POST /api/reminders — create a reminder ───────────────────────────────────
router.post("/reminders", async (req: Request, res: Response) => {
  const { userName, reminderText, fireAt, recurring, recurringTime, timezone } = req.body;

  if (!reminderText || !fireAt) {
    res.status(400).json({ error: "reminderText and fireAt are required" });
    return;
  }

  const resolvedUser = userName ?? "David";

  // ── Duplicate guard: don't insert if same text + fire_at already pending ──
  const { rows: existing } = await query(
    `SELECT id FROM reminders
      WHERE user_name = $1
        AND reminder_text = $2
        AND fire_at = $3
        AND status = 'pending'
      LIMIT 1`,
    [resolvedUser, reminderText, fireAt]
  );
  if (existing.length > 0) {
    res.json(existing[0]); // return the existing row — idempotent
    return;
  }

  const { rows } = await query(
    `INSERT INTO reminders
       (user_name, reminder_text, fire_at, recurring, recurring_time, timezone, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
    [
      resolvedUser,
      reminderText,
      fireAt,
      recurring ?? null,
      recurringTime ?? null,
      timezone ?? "America/Chicago",
    ]
  );

  const newReminder = rows[0];
  res.json(newReminder);

  // Broadcast to all open tabs so their reminders lists update immediately
  broadcast("reminder_sync", { action: "created", reminder: newReminder });
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
// Called by the frontend after Emma speaks the reminder so it won't be returned
// by /api/reminders/due on subsequent polls from other devices.
router.post("/reminders/:id/acknowledge", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid reminder ID" }); return; }

  await query(
    `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status = 'fired'`,
    [id]
  );
  res.json({ success: true });
  // Tell all open panels to remove this reminder
  broadcast("reminder_sync", { action: "completed", id });
});

// ── POST /api/reminders/:id/complete — dismiss from panel (mark completed) ────
// Called when the user taps the dismiss (✓) button in the upcoming reminders panel.
router.post("/reminders/:id/complete", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid reminder ID" }); return; }

  await query(
    `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status IN ('pending', 'fired')`,
    [id]
  );
  res.json({ success: true });
  // Broadcast so all open panels on all devices remove this reminder immediately
  broadcast("reminder_sync", { action: "completed", id });
});

export default router;
