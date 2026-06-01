import { Router } from "express";
import express from "express";
import { randomUUID } from "crypto";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import {
  createGoal,
  getGoals,
  getGoalById,
  addStep,
  updateStep,
  deleteGoal,
  breakdownGoal,
  goalsFreeformChat,
  formatContentForSharing,
  type ShareFormat,
} from "../goals/goalsManager.js";

const router = Router();

// ── GET /api/goals ─────────────────────────────────────────────────────────────
// Returns all goals for the user with their steps and completion status.
router.get("/goals", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const goals = await getGoals(userName);
    res.json({ goals });
  } catch (err) {
    req.log.error({ err }, "[Goals] GET /goals error");
    res.status(500).json({ error: "Failed to fetch goals" });
  }
});

// ── POST /api/goals ────────────────────────────────────────────────────────────
// Creates a new goal. Body: { title, description? }
// Returns: { id, title, description, steps: [] }
router.post("/goals", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { title, description } = req.body as { title?: string; description?: string };
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  try {
    const goal = await createGoal(userName, title.trim(), description ?? null);
    req.log.info({ goalId: goal.id, title: goal.title }, "[Goals] Goal created");
    res.status(201).json(goal);
  } catch (err) {
    req.log.error({ err }, "[Goals] POST /goals error");
    res.status(500).json({ error: "Failed to create goal" });
  }
});

// ── POST /api/goals/breakdown ──────────────────────────────────────────────────
// AI endpoint. Body: { goal, conversation_history?, auto_save?, goal_title?, goal_id? }
// Returns: { type: 'question' | 'steps', content: string, steps?: string[], goalId?: number }
//
// auto_save: true  → automatically creates/updates the goal in the DB and saves steps.
//                    Returns goalId so subsequent calls can pass it back to update steps
//                    instead of creating a new goal each time.
// goal_title:      → preferred title when creating the goal. Falls back to the goal text.
// goal_id:         → pass back the goalId from a previous response to update existing
//                    goal steps (replaces old steps with the new response's steps).
//
// Note: this route must be declared before /goals/:id to avoid param capture.
router.post("/goals/breakdown", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { goal, conversation_history, auto_save, goal_title, goal_id } = req.body as {
    goal?: string;
    conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
    auto_save?: boolean;
    goal_title?: string;
    goal_id?: number;
  };
  if (!goal || typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  try {
    const result = await breakdownGoal(goal.trim(), conversation_history ?? [], userName, {
      autoSave: auto_save === true,
      goalTitle: goal_title,
      goalId: typeof goal_id === "number" ? goal_id : undefined,
    });
    req.log.info({ type: result.type, goalId: result.goalId, autoSave: auto_save }, "[Goals] Breakdown generated");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "[Goals] POST /goals/breakdown error");
    res.status(500).json({ error: "Failed to generate goal breakdown" });
  }
});

// ── POST /api/goals/:id/steps ──────────────────────────────────────────────────
// Adds a step to a goal. Body: { step_text, order? }
router.post("/goals/:id/steps", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const goalId = parseInt(req.params.id, 10);
  if (isNaN(goalId)) {
    res.status(400).json({ error: "Invalid goal id" });
    return;
  }
  const { step_text, order } = req.body as { step_text?: string; order?: number };
  if (!step_text || typeof step_text !== "string" || !step_text.trim()) {
    res.status(400).json({ error: "step_text is required" });
    return;
  }
  try {
    const step = await addStep(goalId, userName, step_text.trim(), order ?? 0);
    if (!step) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    req.log.info({ goalId, stepId: step.id }, "[Goals] Step added");
    res.status(201).json(step);
  } catch (err) {
    req.log.error({ err }, "[Goals] POST /goals/:id/steps error");
    res.status(500).json({ error: "Failed to add step" });
  }
});

// ── PATCH /api/goals/:id/steps/:stepId ────────────────────────────────────────
// Marks a step complete or incomplete. Body: { completed: boolean }
router.patch("/goals/:id/steps/:stepId", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const goalId = parseInt(req.params.id, 10);
  const stepId = parseInt(req.params.stepId, 10);
  if (isNaN(goalId) || isNaN(stepId)) {
    res.status(400).json({ error: "Invalid goal or step id" });
    return;
  }
  const { completed } = req.body as { completed?: boolean };
  if (typeof completed !== "boolean") {
    res.status(400).json({ error: "completed (boolean) is required" });
    return;
  }
  try {
    const step = await updateStep(stepId, goalId, userName, completed);
    if (!step) {
      res.status(404).json({ error: "Step not found" });
      return;
    }
    req.log.info({ goalId, stepId, completed }, "[Goals] Step updated");
    res.json(step);
  } catch (err) {
    req.log.error({ err }, "[Goals] PATCH /goals/:id/steps/:stepId error");
    res.status(500).json({ error: "Failed to update step" });
  }
});

// ── POST /api/goals/share ──────────────────────────────────────────────────────
// Formats AI-generated goal content for clipboard copy or OS share sheet.
// Body: { content: string, format?: "playlist"|"checklist"|"summary"|"plain", title?: string }
// Returns: { ok: true, text: string } — clean plain text ready to copy or share
router.post("/goals/share", express.json({ limit: "2mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { content, format, title } = req.body as {
    content?: string;
    format?: string;
    title?: string;
  };
  if (!content || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  const safeFormat = (["playlist", "checklist", "summary", "plain"] as const).includes(
    format as ShareFormat
  )
    ? (format as ShareFormat)
    : "plain";
  try {
    const text = await formatContentForSharing(content.trim(), safeFormat, title ?? "");
    req.log.info({ format: safeFormat, inputLen: content.length, outputLen: text.length }, "[Goals] POST /goals/share");
    res.json({ ok: true, text });
  } catch (err) {
    req.log.error({ err }, "[Goals] POST /goals/share error");
    res.status(500).json({ error: "Failed to format content for sharing" });
  }
});

// ── POST /api/goals/chat ───────────────────────────────────────────────────────
// Free-form conversational AI response for the Goals screen.
// Unlike /goals/breakdown this does NOT force a structured step output —
// it's a genuine back-and-forth conversation that can go anywhere.
// Saves the exchange to chat_messages so history persists across app restarts.
// Body: { message: string, conversation_history?: [{role, content}] }
// Returns: { response: string }
router.post("/goals/chat", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { message, conversation_history } = req.body as {
    message?: string;
    conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
  };
  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  try {
    const response = await goalsFreeformChat(message.trim(), conversation_history ?? [], userName);
    // Persist exchange fire-and-forget so response is immediate
    const msgId = randomUUID();
    query(
      `INSERT INTO chat_messages (user_name, role, content, message_id)
       VALUES ($1, 'user', $2, $3)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [userName, message.trim().slice(0, 8000), `goals:${msgId}:user`]
    ).then(() => req.log.info("[Goals] User message saved"))
     .catch(() => {});
    if (response) {
      query(
        `INSERT INTO chat_messages (user_name, role, content, message_id)
         VALUES ($1, 'assistant', $2, $3)
         ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
        [userName, response.slice(0, 8000), `goals:${msgId}:assistant`]
      ).then(() => req.log.info("[Goals] Assistant message saved"))
       .catch(() => {});
    }
    req.log.info({ responseLen: response.length }, "[Goals] POST /goals/chat completed");
    res.json({ response });
  } catch (err) {
    req.log.error({ err }, "[Goals] POST /goals/chat error");
    res.status(500).json({ error: "Failed to generate response" });
  }
});

// ── DELETE /api/goals/:id ──────────────────────────────────────────────────────
// Deletes a goal and all its steps.
router.delete("/goals/:id", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const goalId = parseInt(req.params.id, 10);
  if (isNaN(goalId)) {
    res.status(400).json({ error: "Invalid goal id" });
    return;
  }
  try {
    const deleted = await deleteGoal(goalId, userName);
    if (!deleted) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    req.log.info({ goalId }, "[Goals] Goal deleted");
    res.json({ ok: true, deleted: true });
  } catch (err) {
    req.log.error({ err }, "[Goals] DELETE /goals/:id error");
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

export default router;
