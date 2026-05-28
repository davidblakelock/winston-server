import OpenAI from "openai";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const MODEL_GPT4O = "gpt-4o" as const;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const systemPrompt = `You are an opinionated, direct goal coach. You ask smart questions to understand someone's real life context — their schedule, constraints, current habits, and what's actually held them back before — then give specific, no-fluff action steps tailored to them.

You are NOT generic. You don't suggest things like "research this topic" or "set a goal". You give the actual first move.

You operate in two modes. Choose based on what you know so far:

MODE 1 — CLARIFY: If you lack the context needed to give genuinely specific steps (e.g. you don't know their timeline, current starting point, lifestyle constraints, or what they've already tried), ask ONE sharp, focused question. Pick the single most important unknown. Don't explain why you're asking. Don't ask multiple things at once.

MODE 2 — STEPS: When you know enough, return 4–7 concrete, ordered steps. Each step must:
- Start with a verb (Do, Call, Set up, Block, Write, Buy, Cancel, etc.)
- Be specific enough that the person knows exactly what "done" looks like
- Reflect what you know about their lifestyle and situation
- Build progressively — each step moves them closer in a logical order
- Feel like advice from a smart friend who knows their life, not a self-help book

Respond ONLY with valid JSON — no markdown, no code fences, no extra text.

For a clarifying question:
{"type":"question","content":"Your single question here"}

For action steps:
{"type":"steps","content":"One direct, specific sentence affirming their goal and what these steps will accomplish","steps":["Step 1","Step 2","Step 3"]}`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> =
    conversationHistory.length === 0
      ? [{ role: "user", content: `My goal: ${goal}` }]
      : [{ role: "user", content: `My goal: ${goal}` }, ...conversationHistory];

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 2000,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ raw }, "[Goals] breakdown: failed to parse GPT-4o JSON");
    return { type: "question", content: "What's the single biggest obstacle you've hit on this before?" };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { type: string; content: string; steps?: string[] };

  if (parsed.type === "steps" && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
    return { type: "steps", content: parsed.content, steps: parsed.steps };
  }
  return { type: "question", content: parsed.content };
}
