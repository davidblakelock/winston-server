import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import {
  createGoal,
  getGoals,
  getGoalById,
  addStep,
  updateStep,
  deleteGoal,
  breakdownGoal,
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
// AI endpoint. Body: { goal, conversation_history? }
// Returns: { type: 'question' | 'steps', content: string, steps?: string[] }
// Note: this route must be declared before /goals/:id to avoid param capture.
router.post("/goals/breakdown", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { goal, conversation_history } = req.body as {
    goal?: string;
    conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
  };
  if (!goal || typeof goal !== "string" || !goal.trim()) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  try {
    const result = await breakdownGoal(goal.trim(), conversation_history ?? []);
    req.log.info({ type: result.type }, "[Goals] Breakdown generated");
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
