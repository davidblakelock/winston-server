import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { query } from "../db.js";
import { addClient, removeClient } from "../reminders/sseStore.js";

const router: IRouter = Router();

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
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(clientId);
  });
});

router.get("/reminders", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, recurring, recurring_time, timezone, last_fired_at, created_at
     FROM reminders ORDER BY fire_at ASC`
  );
  res.json(rows);
});

router.post("/reminders", async (req: Request, res: Response) => {
  const { userName, reminderText, fireAt, recurring, recurringTime, timezone } = req.body;

  if (!reminderText || !fireAt) {
    res.status(400).json({ error: "reminderText and fireAt are required" });
    return;
  }

  const { rows } = await query(
    `INSERT INTO reminders (user_name, reminder_text, fire_at, recurring, recurring_time, timezone)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      userName ?? "David",
      reminderText,
      fireAt,
      recurring ?? null,
      recurringTime ?? null,
      timezone ?? "America/Chicago",
    ]
  );

  res.json(rows[0]);
});

router.delete("/reminders/:id", async (req: Request, res: Response) => {
  await query(`DELETE FROM reminders WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

// Snooze a reminder by resetting fire_at to now + N minutes
router.post("/reminders/:id/snooze", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid reminder ID" });
    return;
  }
  const minutes = typeof req.body?.minutes === "number" ? req.body.minutes : 10;
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000);
  await query(
    `UPDATE reminders SET fire_at = $1, last_fired_at = NULL WHERE id = $2`,
    [snoozeUntil, id]
  );
  res.json({ success: true, snoozedUntil: snoozeUntil });
});

export default router;
