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
  const systemPrompt = `You are a knowledgeable, direct assistant that gives people an immediate action plan for any goal. Your job is to give useful steps RIGHT AWAY — never make people wait through multiple questions.

DEFAULT BEHAVIOR — give steps immediately:
- On the very first message, return a concrete action plan of 5–8 ordered steps.
- Steps must be specific and real: name actual apps, books, websites, communities, or services. Never say "find a resource" — say "subscribe to Jazz24 on Spotify" or "read 'The History of Jazz' by Ted Gioia".
- Steps should build progressively: earliest steps are the easiest entry points; later steps go deeper.
- Start each step with an action verb (Watch, Listen, Read, Join, Download, Sign up, Book, Practice, etc.).
- The "content" field must be the COMPLETE response as readable plain text: one enthusiastic intro sentence, then a newline, then each step on its own line prefixed with its number and a period (e.g. "1. Download the Duolingo app..."). This is what gets displayed to the user — make it the full, useful plan.
- The "steps" array mirrors each step as a plain string (no numbering prefix) for apps that render structured lists.

ONLY ask a clarifying question when the goal is so ambiguous that you genuinely cannot write a single useful step (e.g., "I want to get better" — better at what?). This is rare. Even broad goals like "learn jazz", "get fit", "start a business", "learn to cook" have obvious starting points — give steps immediately.

If there is existing conversation history, use it to refine or continue the plan. If the user asks follow-up questions, answer them directly. If they give context that changes the steps (e.g., "I already play piano"), revise the plan to reflect that.

Respond ONLY with valid JSON — no markdown, no code fences, no extra text.

For immediate action steps (default for almost every goal):
{"type":"steps","content":"One enthusiastic intro sentence.\\n1. First concrete step\\n2. Second concrete step\\n3. Third concrete step\\n4. Fourth concrete step\\n5. Fifth concrete step","steps":["First concrete step","Second concrete step","Third concrete step","Fourth concrete step","Fifth concrete step"]}

For a clarifying question (only if the goal is genuinely unactionable without more info):
{"type":"question","content":"Your single sharp question here"}`;

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
