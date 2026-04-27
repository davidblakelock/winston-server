import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface Story {
  id: number;
  question_id?: number;
  category?: string;
  prompt_question: string;
  response: string;
  captured_at: Date;
}

export interface StoryQuestion {
  id: number;
  question: string;
  category: string;
}

// ── Ensure story_state row exists ─────────────────────────────────────────────

export async function ensureStoryState(): Promise<void> {
  await query(`
    INSERT INTO story_state (id, current_cycle)
    VALUES (1, 1)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
}

// ── Get total question count ──────────────────────────────────────────────────

async function getTotalQuestionCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM story_questions"
  );
  return parseInt(rows[0].count, 10);
}

// ── Get current cycle number ──────────────────────────────────────────────────

async function getCurrentCycle(): Promise<number> {
  const { rows } = await query<{ current_cycle: number }>(
    "SELECT current_cycle FROM story_state WHERE id = 1"
  );
  return rows[0]?.current_cycle ?? 1;
}

// ── Generate a new randomized cycle in story_queue ────────────────────────────
// Called when the current cycle is exhausted (all questions asked).

async function generateNewCycle(cycleNum: number): Promise<void> {
  const { rows: questions } = await query<{ id: number }>(
    "SELECT id FROM story_questions ORDER BY RANDOM()"
  );

  if (questions.length === 0) return;

  const values = questions
    .map((q, i) => `(${q.id}, ${cycleNum}, ${i + 1})`)
    .join(", ");

  await query(
    `INSERT INTO story_queue (question_id, cycle_num, position) VALUES ${values} RETURNING id`
  );

  logger.info({ cycleNum, count: questions.length }, "[STORY] New question cycle generated");
}

// ── Get next unasked question for the current cycle ───────────────────────────

export async function getNextStoryQuestion(): Promise<StoryQuestion | null> {
  await ensureStoryState();

  const totalCount = await getTotalQuestionCount();
  if (totalCount === 0) return null;

  const currentCycle = await getCurrentCycle();

  // Find next unasked question in current cycle
  const { rows } = await query<{ queue_id: number; question_id: number; question: string; category: string }>(
    `SELECT sq.id AS queue_id, sq.question_id, sqq.question, sqq.category
     FROM story_queue sq
     JOIN story_questions sqq ON sqq.id = sq.question_id
     WHERE sq.cycle_num = $1 AND sq.asked_at IS NULL
     ORDER BY sq.position ASC
     LIMIT 1`,
    [currentCycle]
  );

  if (rows.length > 0) {
    return {
      id: rows[0].question_id,
      question: rows[0].question,
      category: rows[0].category,
    };
  }

  // Current cycle exhausted — start a new one
  const nextCycle = currentCycle + 1;
  logger.info({ currentCycle, nextCycle }, "[STORY] Cycle exhausted, generating new cycle");

  await query(
    "UPDATE story_state SET current_cycle = $1 WHERE id = 1 RETURNING id",
    [nextCycle]
  );
  await generateNewCycle(nextCycle);

  // Return first question from the new cycle
  const { rows: newRows } = await query<{ question_id: number; question: string; category: string }>(
    `SELECT sq.question_id, sqq.question, sqq.category
     FROM story_queue sq
     JOIN story_questions sqq ON sqq.id = sq.question_id
     WHERE sq.cycle_num = $1 AND sq.asked_at IS NULL
     ORDER BY sq.position ASC
     LIMIT 1`,
    [nextCycle]
  );

  if (newRows.length === 0) return null;

  return {
    id: newRows[0].question_id,
    question: newRows[0].question,
    category: newRows[0].category,
  };
}

// ── Mark a question as asked in the current cycle ────────────────────────────

export async function markQuestionAsked(questionId: number): Promise<void> {
  const currentCycle = await getCurrentCycle();
  await query(
    `UPDATE story_queue
     SET asked_at = NOW()
     WHERE question_id = $1 AND cycle_num = $2 AND asked_at IS NULL
     RETURNING question_id`,
    [questionId, currentCycle]
  );
  logger.info({ questionId, currentCycle }, "[STORY] Question marked as asked");
}

// ── story_state: pending prompt ───────────────────────────────────────────────

interface StoryStateRow {
  pending_prompt: string | null;
  prompt_sent_at: Date | null;
  pending_question_id: number | null;
}

export async function getPendingPrompt(): Promise<string | null> {
  await ensureStoryState();
  const { rows } = await query<StoryStateRow>(
    "SELECT pending_prompt, prompt_sent_at, pending_question_id FROM story_state WHERE id = 1"
  );
  if (rows.length === 0 || !rows[0].pending_prompt) return null;

  const sentAt = rows[0].prompt_sent_at;
  if (sentAt) {
    const ageMinutes = (Date.now() - new Date(sentAt).getTime()) / 60000;
    if (ageMinutes > 90) {
      await clearPendingPrompt();
      return null;
    }
  }
  return rows[0].pending_prompt;
}

export async function getPendingQuestionId(): Promise<number | null> {
  await ensureStoryState();
  const { rows } = await query<{ pending_question_id: number | null }>(
    "SELECT pending_question_id FROM story_state WHERE id = 1"
  );
  return rows[0]?.pending_question_id ?? null;
}

export async function setPendingQuestion(questionId: number, questionText: string): Promise<void> {
  await ensureStoryState();
  await query(
    "UPDATE story_state SET pending_prompt = $1, prompt_sent_at = NOW(), pending_question_id = $2 WHERE id = 1 RETURNING id",
    [questionText, questionId]
  );
}

export async function clearPendingPrompt(): Promise<void> {
  await ensureStoryState();
  await query(
    "UPDATE story_state SET pending_prompt = NULL, prompt_sent_at = NULL, pending_question_id = NULL WHERE id = 1 RETURNING id"
  );
}

// ── Legacy alias for existing callers ────────────────────────────────────────

export async function getRandomPrompt(): Promise<string> {
  const q = await getNextStoryQuestion();
  return q?.question ?? "Tell me about a memory that means a lot to you — something you'd want Olivia to know.";
}

export async function setPendingPrompt(prompt: string): Promise<void> {
  await ensureStoryState();
  await query(
    "UPDATE story_state SET pending_prompt = $1, prompt_sent_at = NOW() WHERE id = 1 RETURNING id",
    [prompt]
  );
}

// ── Save a story ──────────────────────────────────────────────────────────────

export async function saveStory(
  promptQuestion: string,
  response: string,
  questionId?: number | null,
  category?: string | null
): Promise<Story> {
  const { rows } = await query<Story>(
    `INSERT INTO stories (prompt_question, response, question_id, category)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [promptQuestion, response, questionId ?? null, category ?? null]
  );

  if (questionId) {
    await markQuestionAsked(questionId).catch((err) =>
      logger.warn({ err, questionId }, "[STORY] Failed to mark question as asked")
    );
  }

  return rows[0];
}

// ── Story retrieval ───────────────────────────────────────────────────────────

export async function getStories(): Promise<Story[]> {
  const { rows } = await query<Story>(
    "SELECT * FROM stories ORDER BY captured_at DESC"
  );
  return rows;
}

export async function getStoryCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM stories"
  );
  return parseInt(rows[0].count, 10);
}

export async function getRecentStoryCount(days: number): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM stories
     WHERE captured_at >= NOW() - INTERVAL '${days} days'`
  );
  return parseInt(rows[0].count, 10);
}

export async function hasStoryCapturedTonight(): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM stories WHERE captured_at >= NOW() - INTERVAL '3 hours'"
  );
  return parseInt(rows[0].count, 10) > 0;
}

export function formatStoriesForPrompt(stories: Story[]): string {
  if (stories.length === 0) return "No stories captured yet.";
  return stories
    .map((s, i) => {
      const date = new Date(s.captured_at).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const cat = s.category ? ` [${s.category}]` : "";
      return `Story ${i + 1} — ${date}${cat}\nPrompt: ${s.prompt_question}\n${s.response}`;
    })
    .join("\n\n---\n\n");
}

// ── Progress stats ────────────────────────────────────────────────────────────

export async function getQueueProgress(): Promise<{ cycleNum: number; askedThisCycle: number; totalQuestions: number }> {
  const cycleNum = await getCurrentCycle();
  const total = await getTotalQuestionCount();
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM story_queue WHERE cycle_num = $1 AND asked_at IS NOT NULL",
    [cycleNum]
  );
  const askedThisCycle = parseInt(rows[0]?.count ?? "0", 10);
  return { cycleNum, askedThisCycle, totalQuestions: total };
}
