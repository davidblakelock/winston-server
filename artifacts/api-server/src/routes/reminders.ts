import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import { randomUUID } from "crypto";
import { query } from "../db.js";
import { addClient, removeClient, broadcast, registerClientUser } from "../reminders/sseStore.js";
import { createReminder, markReminderDone } from "../reminders/reminderManager.js";
import { validateSession } from "../auth/sessionAuth.js";
import { authenticate, NATIVE_USER } from "../auth/middleware.js";
import { getProfile } from "../onboarding/onboardingManager.js";

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
router.get("/reminders", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, recurring, recurring_time, timezone, status, created_at
       FROM reminders
      WHERE user_name = $1
        AND status = 'pending'
        AND fire_at IS NULL
      ORDER BY created_at ASC`,
    [userName]
  );
  res.json(rows);
});

// ── GET /api/reminders/list — alias used by some frontend callers ─────────────
// Only returns reminders that are still pending AND have not yet passed their
// fire_at time.  Past-due pending rows (scheduler was down during their window)
// are excluded — they will be fired the moment the scheduler next runs, which
// sends the push/SSE immediately, so there is no value showing them in the pill.
router.get("/reminders/list", async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, recurring, recurring_time,
            timezone, status, last_fired_at, created_at
       FROM reminders
      WHERE status = 'pending'
        AND (fire_at > NOW() OR fire_at IS NULL)
      ORDER BY fire_at ASC`
  );
  res.json(rows);
});

// ── GET /api/reminders/todos — returns plain to-do items (no fire_at) ─────────
router.get("/reminders/todos", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { rows } = await query(
    `SELECT id, user_name, reminder_text, fire_at, status, created_at
     FROM reminders
     WHERE user_name = $1
       AND status = 'pending'
       AND fire_at IS NULL
     ORDER BY created_at ASC`,
    [userName]
  );
  res.json({ todos: rows });
});

// ── GET /api/reminders/due ────────────────────────────────────────────────────
// Returns reminders completed in the last 10 minutes (status = 'completed').
// The frontend polls this every 20 s as a reliable fallback for when the SSE
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
      WHERE status = 'completed'
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
  const id = parseInt(String(req.params.id), 10);
  await query(`DELETE FROM reminders WHERE id = $1 RETURNING id`, [id]);
  res.json({ success: true });
  broadcast("reminder_sync", { action: "deleted", id });
});

// ── DELETE /api/reminders/delete — body-based delete (alternate form) ─────────
router.delete("/reminders/delete", async (req: Request, res: Response) => {
  const id = req.body?.id ?? req.query?.id;
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  await query(`DELETE FROM reminders WHERE id = $1 RETURNING id`, [id]);
  res.json({ success: true });
  broadcast("reminder_sync", { action: "deleted", id: parseInt(String(id), 10) });
});

// ── POST /api/reminders/:id/snooze — delay a fired reminder by N minutes ─────
router.post("/reminders/:id/snooze", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid reminder ID" }); return; }

  const minutes = typeof req.body?.minutes === "number" ? req.body.minutes : 10;
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000);

  await query(
    `UPDATE reminders
        SET fire_at = $1, status = 'pending', last_fired_at = NULL
      WHERE id = $2
      RETURNING id`,
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
  const numId = parseInt(typeof req.params.id === 'string' ? req.params.id : req.params.id[0], 10);

  // Non-numeric ID — synthetic reminder (medication init, briefing, etc.) with no DB row.
  // Nothing to update; just return 200 so the frontend can clear it cleanly.
  if (isNaN(numId) || rawId !== String(numId)) {
    res.json({ success: true, synthetic: true });
    return;
  }

  try {
    // Accept both 'fired' (legacy rows from before direct-complete) and 'completed'
    // (rows already finalised by the scheduler).  Idempotent either way.
    const result = await query(
      `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status IN ('fired', 'completed') RETURNING id`,
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
  const numId = parseInt(typeof req.params.id === 'string' ? req.params.id : req.params.id[0], 10);

  // Non-numeric ID — synthetic reminder with no DB row; return 200 immediately.
  if (isNaN(numId) || rawId !== String(numId)) {
    res.json({ success: true, synthetic: true });
    return;
  }

  await query(
    `UPDATE reminders SET status = 'completed' WHERE id = $1 AND status IN ('pending', 'fired') RETURNING id`,
    [numId]
  );
  res.json({ success: true });
  // Broadcast so all open panels on all devices remove this reminder immediately
  broadcast("reminder_sync", { action: "completed", id: numId });
});

// ── POST /api/reminders/mark-done — background action from push notification ──
// Called by the native app when the user taps the "Done ✓" action button on a
// reminder notification. This runs in the background — the app does not open.
// Accepts reminderId in the body (Expo sends the data payload fields).
router.post("/reminders/mark-done", async (req: Request, res: Response) => {
  const reminderId = req.body?.reminderId ?? req.body?.id;
  if (!reminderId) {
    res.status(400).json({ error: "reminderId required" });
    return;
  }
  const id = parseInt(String(reminderId), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "reminderId must be numeric" });
    return;
  }
  const found = await markReminderDone(id);
  res.json({ success: true, found });
});

// ── POST /api/reminders/done — alias for /reminders/mark-done ─────────────────
// Called by the native app notification action button ("Done ✓" on reminder).
// Accepts reminderId either directly or nested inside notificationData.
// Runs in the background — the app does not need to open.
router.post("/reminders/done", async (req: Request, res: Response) => {
  // reminderId may be top-level or inside the Expo notificationData envelope
  const body = req.body ?? {};
  const raw =
    body.reminderId ??
    body.id ??
    body.notificationData?.reminderId ??
    body.notificationData?.data?.reminderId;

  if (!raw) {
    res.status(400).json({ error: "reminderId required" });
    return;
  }
  const id = parseInt(String(raw), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "reminderId must be numeric" });
    return;
  }
  const found = await markReminderDone(id);
  console.log(`[REMINDERS/DONE] id=${id} found=${found}`);
  res.json({ success: true, found });
  if (found) broadcast("reminder_sync", { action: "completed", id });
});

// ── POST /api/reminders/snooze — body-based snooze from notification action ───
// Called by the native app when the user taps "Snooze" on a reminder push,
// or "Remind Tomorrow" on a bill push (which has billId but no reminderId).
// Body: { reminderId?, id?, minutes?, notificationData? }
// Bill case: { minutes: 1440, notificationData: { billId, companionMessage, ... } }
router.post("/reminders/snooze", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const notifData = body.notificationData ?? {};

  // ── Bill case: REMIND_TOMORROW sends billId but no reminderId ────────────────
  // Parse companionMessage for bill name/amount, then schedule for 8 AM tomorrow CT.
  const billId =
    body.billId ??
    notifData.billId ??
    (notifData.data as { billId?: number } | undefined)?.billId;

  if (billId) {
    const userProfile = await getProfile(NATIVE_USER);
    let billName = `Bill #${billId}`;
    let amount = "";
    try {
      const cm = notifData.companionMessage ?? body.companionMessage;
      if (cm) {
        const parsed = JSON.parse(typeof cm === "string" ? cm : JSON.stringify(cm)) as {
          billName?: string;
          amount?: string;
        };
        if (parsed.billName) billName = parsed.billName;
        if (parsed.amount) amount = parsed.amount;
      }
    } catch { /* ignore parse errors — fall back to Bill #id */ }

    const amtPart = amount ? ` of ${amount}` : "";
    const tomorrowStr = new Date(Date.now() + 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: userProfile?.timezone ?? "UTC" });
    // fireAt: resolve 8 AM user-local → correct UTC instant (handles DST)
    const approxUtc = new Date(`${tomorrowStr}T08:00:00.000Z`);
    const ctHour = parseInt(
      approxUtc.toLocaleTimeString("en-US", { timeZone: userProfile?.timezone ?? "UTC", hour: "2-digit", hour12: false }),
      10
    );
    const fireAt = new Date(approxUtc.getTime() + (8 - ctHour) * 3_600_000);

    const reminder = await createReminder({
      userName: NATIVE_USER,
      reminderText: `Your ${billName}${amtPart} payment — have you paid it yet?`,
      fireAt,
      timezone: userProfile?.timezone ?? "UTC",
      pushCategoryId: "bill-action",
      pushData: {
        billId,
        billName,
        amount,
        actionTaken: "/api/bills/paid",
        actionSnooze: "/api/bills/remind-tomorrow",
        categoryIdentifier: "bill-action",
        companionMessage: {
          billId,
          billName,
          amount,
          actionTaken: "/api/bills/paid",
          actionSnooze: "/api/bills/remind-tomorrow",
        },
      },
    });
    req.log?.info?.({ billId, billName, fireAt, reminderId: reminder.id }, "[REMINDERS/SNOOZE] Bill remind-tomorrow created");
    res.json({ success: true, reminderId: reminder.id, scheduledFor: fireAt });
    return;
  }

  // ── Standard reminder snooze ─────────────────────────────────────────────────
  const raw =
    body.reminderId ??
    body.id ??
    notifData.reminderId ??
    (notifData.data as { reminderId?: number } | undefined)?.reminderId;

  if (!raw) {
    res.status(400).json({ error: "reminderId required" });
    return;
  }
  const id = parseInt(String(raw), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "reminderId must be numeric" });
    return;
  }

  const minutes = typeof body.minutes === "number" ? body.minutes : 10;
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000);

  await query(
    `UPDATE reminders
        SET fire_at = $1, status = 'pending', last_fired_at = NULL
      WHERE id = $2
      RETURNING id`,
    [snoozeUntil, id]
  );
  req.log?.info?.({ id, minutes, snoozeUntil }, "[REMINDERS/SNOOZE] Reminder snoozed");
  res.json({ success: true, snoozedUntil: snoozeUntil });
});

export default router;
