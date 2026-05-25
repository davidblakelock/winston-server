import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { MODEL_SONNET } from "../lib/models.js";

const anthropic = new Anthropic();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoalStep {
  id: number;
  goal_id: number;
  step_text: string;
  order: number;
  completed: boolean;
  completed_at: string | null;
}

export interface Goal {
  id: number;
  user_name: string;
  title: string;
  description: string | null;
  created_at: string;
  completed_at: string | null;
  steps: GoalStep[];
}

export type BreakdownResult =
  | { type: "question"; content: string }
  | { type: "steps"; content: string; steps: string[] };

// ── Startup migration ──────────────────────────────────────────────────────────

export async function ensureGoalsTables(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS goals (
        id          serial PRIMARY KEY,
        user_name   text NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
        title       text NOT NULL,
        description text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS goal_steps (
        id           serial PRIMARY KEY,
        goal_id      integer NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        step_text    text NOT NULL,
        "order"      integer NOT NULL DEFAULT 0,
        completed    boolean NOT NULL DEFAULT false,
        completed_at timestamptz
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS goal_steps_goal_id_idx ON goal_steps(goal_id)`);
    logger.info("[Goals] Tables ready");
  } catch (err) {
    logger.warn({ err }, "[Goals] Startup migration warning");
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createGoal(
  userName: string,
  title: string,
  description?: string | null
): Promise<Goal> {
  const { rows } = await query<Omit<Goal, "steps">>(
    `INSERT INTO goals (user_name, title, description)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userName, title, description ?? null]
  );
  const row = rows[0]!;
  return { ...row, steps: [] };
}

export async function getGoals(userName: string): Promise<Goal[]> {
  const { rows: goalRows } = await query<Omit<Goal, "steps">>(
    `SELECT * FROM goals WHERE user_name = $1 ORDER BY created_at DESC`,
    [userName]
  );
  if (goalRows.length === 0) return [];

  const goalIds = goalRows.map((g) => g.id);
  const { rows: stepRows } = await query<GoalStep>(
    `SELECT * FROM goal_steps WHERE goal_id = ANY($1) ORDER BY "order" ASC, id ASC`,
    [goalIds]
  );

  const stepsByGoal = new Map<number, GoalStep[]>();
  for (const step of stepRows) {
    const arr = stepsByGoal.get(step.goal_id) ?? [];
    arr.push(step);
    stepsByGoal.set(step.goal_id, arr);
  }

  return goalRows.map((g) => ({ ...g, steps: stepsByGoal.get(g.id) ?? [] }));
}

export async function getGoalById(
  goalId: number,
  userName: string
): Promise<Goal | null> {
  const { rows } = await query<Omit<Goal, "steps">>(
    `SELECT * FROM goals WHERE id = $1 AND user_name = $2`,
    [goalId, userName]
  );
  if (!rows[0]) return null;
  const { rows: steps } = await query<GoalStep>(
    `SELECT * FROM goal_steps WHERE goal_id = $1 ORDER BY "order" ASC, id ASC`,
    [goalId]
  );
  return { ...rows[0], steps };
}

export async function addStep(
  goalId: number,
  userName: string,
  stepText: string,
  order: number
): Promise<GoalStep | null> {
  const { rows: goalCheck } = await query(
    `SELECT id FROM goals WHERE id = $1 AND user_name = $2`,
    [goalId, userName]
  );
  if (!goalCheck[0]) return null;

  const { rows } = await query<GoalStep>(
    `INSERT INTO goal_steps (goal_id, step_text, "order")
     VALUES ($1, $2, $3)
     RETURNING *`,
    [goalId, stepText, order]
  );
  return rows[0] ?? null;
}

export async function updateStep(
  stepId: number,
  goalId: number,
  userName: string,
  completed: boolean
): Promise<GoalStep | null> {
  const { rows: goalCheck } = await query(
    `SELECT id FROM goals WHERE id = $1 AND user_name = $2`,
    [goalId, userName]
  );
  if (!goalCheck[0]) return null;

  const { rows } = await query<GoalStep>(
    `UPDATE goal_steps
     SET completed    = $3,
         completed_at = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1 AND goal_id = $2
     RETURNING *`,
    [stepId, goalId, completed]
  );
  return rows[0] ?? null;
}

export async function deleteGoal(
  goalId: number,
  userName: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM goals WHERE id = $1 AND user_name = $2 RETURNING id`,
    [goalId, userName]
  );
  return (rows.length ?? 0) > 0;
}

// ── AI goal breakdown ─────────────────────────────────────────────────────────

export async function breakdownGoal(
  goal: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>
): Promise<BreakdownResult> {
  const systemPrompt = `You help people break ambitious goals into concrete, achievable action steps. Apply Stoic principles: focus only on what is within the person's control, make steps concrete and observable, and build progressively from foundation to outcome.

You operate in two modes — decide which to use based on the conversation so far:

MODE 1 — CLARIFY: If you don't yet have enough information to generate truly useful, specific steps, ask exactly ONE short clarifying question. Do not list multiple questions. Do not explain why you're asking.

MODE 2 — STEPS: When you have enough context, return 3–7 ordered action steps. Each step must be:
- Something the person can DO, not something that will happen to them
- Concrete enough that they'd know when it's done
- In plain everyday language — no jargon
- Progressive: earlier steps build the foundation for later ones

Respond ONLY with valid JSON — no markdown, no extra text:

For a clarifying question:
{"type":"question","content":"Your single question here"}

For action steps:
{"type":"steps","content":"One encouraging sentence about their goal","steps":["Step 1 text","Step 2 text","Step 3 text"]}`;

  const messages: Anthropic.MessageParam[] = conversationHistory.length === 0
    ? [{ role: "user", content: `My goal: ${goal}` }]
    : [
        { role: "user", content: `My goal: ${goal}` },
        ...conversationHistory,
      ];

  const response = await anthropic.messages.create({
    model: MODEL_SONNET,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ raw }, "[Goals] breakdown: failed to parse Claude JSON");
    return { type: "question", content: "What's the main obstacle you expect to face with this goal?" };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { type: string; content: string; steps?: string[] };

  if (parsed.type === "steps" && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    return { type: "steps", content: parsed.content, steps: parsed.steps };
  }
  return { type: "question", content: parsed.content };
}
