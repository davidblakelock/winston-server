import OpenAI from "openai";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { getProfile, type CollectedData } from "../onboarding/onboardingManager.js";

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
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName = NATIVE_STORED_NAME
): Promise<BreakdownResult> {
  const userProfile = await getProfile(userName).catch(() => null);
  let profileContext = "";
  if (userProfile) {
    const raw = (userProfile.rawData ?? {}) as CollectedData;
    const displayName = userProfile.name ?? userName;
    const city = userProfile.city ?? (raw.city as string | undefined) ?? "";
    const people = (raw.people ?? []) as Array<{ name: string; relationship: string; city?: string; details?: string }>;
    const music  = (raw.music  ?? raw.musicTaste ?? "") as string;
    const hobbies = (raw.hobbies ?? raw.interests ?? "") as string;

    const lines: string[] = [`The user's name is ${displayName}.`];
    if (city)    lines.push(`They live in ${city}.`);
    if (music)   lines.push(`Their existing music taste: ${music}.`);
    if (hobbies) lines.push(`Their hobbies/interests: ${hobbies}.`);
    if (people.length > 0) {
      lines.push("Key people in their life:");
      for (const p of people) {
        let entry = `- ${p.name} (${p.relationship})`;
        if (p.city) entry += `, lives in ${p.city}`;
        if (p.details) entry += ` — ${p.details}`;
        lines.push(entry);
      }
    }
    profileContext = lines.join("\n");
  }

  const systemPrompt = `You are a knowledgeable, deeply personal advisor — like a brilliant friend who knows this person well and gives real, rich, personalized guidance.${profileContext ? `\n\n${profileContext}` : ""}

Your job is to give a thorough, thoughtful response to any goal — not a generic numbered checklist, but a genuinely useful, engaging guide written specifically for THIS person.

RESPONSE STYLE:
- Write in rich markdown with headers, sections, and sub-sections where appropriate.
- Be specific and real: name actual albums, tracks, books, apps, podcasts, venues, websites, communities. Never say "find a resource" — say exactly which one.
- Build context before jumping to steps: explain the landscape, the approach, what to expect. Make them feel informed, not just instructed.
- Use a warm, direct, intelligent tone — like a trusted advisor who genuinely wants them to succeed.
- Length: as long as it needs to be to be genuinely useful. Don't truncate or summarize. Give the full picture.
- For learning goals (music, language, skills): use a clear historical or progressive structure — show the path from beginner to deeper understanding era by era or level by level.
- For each stage of a learning path: name the key figures, specific recommended works (album/book/track titles), and what to listen/look for. Don't just list names — explain what makes each one important and how it connects to the next.

HOW TO USE THE PROFILE:
- City/location: use it to recommend specific local venues, schools, events, or communities in their area.
- Existing music taste: this is gold for music goals — use it to build a BRIDGE. If the user likes country and wants to learn jazz, point out that country and jazz share Blues roots, and which jazz artists/albums will feel most familiar to them. This is far more useful than a generic path.
- People in their life: mention them only when it's a natural, genuinely helpful suggestion (e.g. "you could invite [name] to a live show"). Never force it.
- Hobbies/interests: use them when they genuinely connect (e.g. if they play guitar and want to learn jazz, reference guitar-specific jazz learning resources).
- TV shows, sports teams: treat these as invisible background. Never manufacture connections to them.
- When in doubt: include the reference only if it adds real, specific value.

ONLY ask a clarifying question if the goal is so vague that you literally cannot write one useful sentence (e.g. "I want to get better" — better at what?). This is rare. If you have enough to go on, give the full response. You may end with ONE optional follow-up question if it would meaningfully deepen the personalization (e.g. "Do you want to eventually play, or just deeply understand and appreciate jazz?").

If there is conversation history, use it to refine, continue, or go deeper. Answer follow-up questions directly and thoroughly.

OUTPUT FORMAT — respond with valid JSON only, no markdown fences:
{
  "type": "steps",
  "content": "<full rich markdown response as a single JSON string — use \\n for newlines>",
  "steps": ["<concise actionable item 1>", "<concise actionable item 2>", ...]
}

The "steps" array must contain 5–10 short, actionable phrases extracted from your response (e.g. "Listen to Kind of Blue by Miles Davis", "Watch 'Jazz' by Ken Burns", "Visit The Balcony Club for a live show", "Buy 'The History of Jazz' by Ted Gioia"). These are used so the user can save individual items to their calendar or to-do list.

For a clarifying question, respond with:
{"type":"question","content":"<your single sharp question>","steps":[]}`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> =
    conversationHistory.length === 0
      ? [{ role: "user", content: goal }]
      : [...conversationHistory, { role: "user", content: goal }];

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 4000,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";

  if (!raw) {
    logger.warn("[Goals] breakdown: GPT-4o returned empty response");
    return { type: "question", content: "What's the single biggest obstacle you've hit on this before?", steps: [] };
  }

  // Parse JSON response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn({ rawLen: raw.length }, "[Goals] breakdown: no JSON found, returning raw as content");
    return { type: "steps", content: raw, steps: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { type?: string; content?: string; steps?: string[] };
    if (parsed.type === "question") {
      return { type: "question", content: parsed.content ?? raw };
    }
    return {
      type: "steps",
      content: parsed.content ?? raw,
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    };
  } catch {
    logger.warn({ rawLen: raw.length }, "[Goals] breakdown: JSON parse failed, returning raw as content");
    return { type: "steps", content: raw, steps: [] };
  }
}
