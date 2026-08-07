import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { MODEL_HAIKU, MODEL_SONNET } from "../lib/models.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import type { SourceItem, UserCorrection } from "../connectionEngine/memorySourceAdapters.js";
import { fetchFromAdapters, getRecentCorrections, formatItemLines } from "../connectionEngine/memorySourceAdapters.js";
import { createReminder } from "../reminders/reminderManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoalStep {
  id: number;
  goal_id: number;
  step_text: string;
  order: number;
  completed: boolean;
  completed_at: string | null;
}

export type GoalStatus = "active" | "aspirational" | "completed";

export interface Goal {
  id: number;
  user_name: string;
  title: string;
  description: string | null;
  created_at: string;
  completed_at: string | null;
  status: GoalStatus;
  steps: GoalStep[];
  source_observation_id: number | null;
}

export type BreakdownResult =
  | { type: "question"; content: string; goalId?: number }
  | { type: "steps"; content: string; steps: string[]; goalId?: number };

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
    // Points at observations.id when a goal was created from a cluster
    // observation's goal-creation offer (build spec Part 3.4). No FK
    // constraint — connectionEngineManager.ts's table init runs from a
    // module-load-time IIFE with no guaranteed ordering relative to this
    // function, so a hard REFERENCES here would be a startup-timing risk
    // for no real benefit; a plain nullable column still joins fine.
    await query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS source_observation_id integer`)
      .catch((err) => logger.warn({ err }, "[Goals] source_observation_id migration warning"));
    // Real status model replacing completed_at-as-only-signal: 'active' is the
    // default for both chat-driven and pre-existing goals, 'aspirational' is
    // the default for cluster-suggested goals (an emerging interest Winston
    // noticed isn't the same as a commitment the user made), 'completed' is
    // set explicitly via updateGoalStatus. completed_at stays as a separate
    // timestamp column, populated only alongside a transition to 'completed'.
    await query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`)
      .catch((err) => logger.warn({ err }, "[Goals] status migration warning"));
    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT FROM pg_constraint WHERE conname = 'goals_status_check'
        ) THEN
          ALTER TABLE goals ADD CONSTRAINT goals_status_check
            CHECK (status IN ('active', 'aspirational', 'completed'));
        END IF;
      END $$
    `).catch((err) => logger.warn({ err }, "[Goals] status check constraint migration warning"));
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
    await query(`
      CREATE TABLE IF NOT EXISTS goals_recap_cache (
        user_name    text PRIMARY KEY,
        recap        text NOT NULL,
        generated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    logger.info("[Goals] Tables ready");
  } catch (err) {
    logger.warn({ err }, "[Goals] Startup migration warning");
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createGoal(
  userName: string,
  title: string,
  description?: string | null,
  status: GoalStatus = "active"
): Promise<Goal> {
  const { rows } = await query<Omit<Goal, "steps">>(
    `INSERT INTO goals (user_name, title, description, status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userName, title, description ?? null, status]
  );
  const row = rows[0]!;
  return { ...row, steps: [] };
}

export interface GoalUpdateFields {
  title?:       string;
  description?: string | null;
  status?:      GoalStatus;
}

// Partial update — only the fields actually present in `updates` are
// touched, so editing just the title (or just the description) never
// requires resending status alongside it. A goal can move between
// active/aspirational/completed as circumstances change; completed_at is
// still derived from the transition itself (set on entering 'completed',
// cleared on leaving it) whenever status is one of the provided fields,
// rather than being a second independent field the caller has to keep in
// sync.
export async function updateGoal(
  goalId:   number,
  userName: string,
  updates:  GoalUpdateFields
): Promise<Goal | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [goalId, userName];

  if (updates.title !== undefined) {
    params.push(updates.title);
    setClauses.push(`title = $${params.length}`);
  }
  if (updates.description !== undefined) {
    params.push(updates.description);
    setClauses.push(`description = $${params.length}`);
  }
  if (updates.status !== undefined) {
    params.push(updates.status);
    setClauses.push(`status = $${params.length}`);
    setClauses.push(`completed_at = CASE WHEN $${params.length} = 'completed' THEN now() ELSE NULL END`);
  }

  if (setClauses.length === 0) return getGoalById(goalId, userName);

  const { rows } = await query<Omit<Goal, "steps">>(
    `UPDATE goals SET ${setClauses.join(", ")} WHERE id = $1 AND user_name = $2 RETURNING *`,
    params
  );
  if (!rows[0]) return null;
  const { rows: steps } = await query<GoalStep>(
    `SELECT * FROM goal_steps WHERE goal_id = $1 ORDER BY "order" ASC, id ASC`,
    [goalId]
  );
  return { ...rows[0], steps };
}

// Links a goal back to the cluster observation it was created from (build
// spec Part 3.4's confirmation flow) — set once, right after createGoal.
export async function linkGoalToObservation(goalId: number, observationId: number): Promise<void> {
  await query(`UPDATE goals SET source_observation_id = $1 WHERE id = $2`, [observationId, goalId]);
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

// ── Shared profile context — used by both breakdownGoal and goalsFreeformChat
// so the free-form chat's personalization (hobbies, music taste, key people)
// is as rich as the structured breakdown's, not just name+city.

async function buildGoalsProfileContext(
  userName: string
): Promise<{ profileContext: string; userCity: string; displayName: string }> {
  const userProfile = await getProfile(userName).catch(() => null);
  if (!userProfile) return { profileContext: "", userCity: "", displayName: userName };

  const displayName     = userProfile.name ?? userName;
  const city            = userProfile.city ?? "";
  const hobbies         = userProfile.hobbies ?? [];
  const musicGenres     = userProfile.musicGenres ?? [];
  const sportsTeams     = userProfile.sportsTeams ?? "";
  const favoriteArtists = userProfile.favoriteArtists ?? [];

  const { timezone: tz } = await getUserLocationContext(userName).catch(() => ({ timezone: "UTC" }));

  const [people, existingGoals, sourceItems, corrections] = await Promise.all([
    getPeople(userName).catch(() => [] as Array<{ name: string; relationship: string; city?: string | null; details?: string | null }>),
    getGoals(userName).catch(() => [] as Goal[]),
    fetchFromAdapters(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 30).catch(() => [] as SourceItem[]),
    getRecentCorrections(userName, 30).catch(() => [] as UserCorrection[]),
  ]);

  const lines: string[] = [`The user's name is ${displayName}.`];
  if (city)                   lines.push(`They live in ${city}.`);
  if (hobbies.length)         lines.push(`Hobbies/interests: ${hobbies.join(", ")}.`);
  if (musicGenres.length)     lines.push(`Music taste: ${musicGenres.join(", ")}.`);
  if (favoriteArtists.length) lines.push(`Favorite artists: ${favoriteArtists.join(", ")}.`);
  if (sportsTeams)            lines.push(`Sports teams: ${sportsTeams}.`);
  if (people.length > 0) {
    lines.push("Key people in their life:");
    for (const p of people) {
      let entry = `- ${p.name} (${p.relationship})`;
      if ('city' in p && p.city) entry += `, lives in ${p.city}`;
      if ('details' in p && p.details) entry += ` — ${p.details}`;
      lines.push(entry);
    }
  }

  // Same shared knowledge the connection engine reasons over (attic items,
  // life captures, other goals, past correction feedback) — previously this
  // function only ever saw static profile fields, so a suggestion could land
  // right next to something they'd already saved to the Attic or a goal
  // they're already working, with no awareness it was there.
  const activeGoals = existingGoals.filter((g) => g.status !== "completed").slice(0, 8);
  if (activeGoals.length > 0) {
    lines.push("\nTheir other current goals (don't re-suggest these as if new; connect to them when it genuinely fits):");
    for (const g of activeGoals) {
      const done  = g.steps.filter((s) => s.completed).length;
      const total = g.steps.length;
      lines.push(`- "${g.title}"${g.description ? ` — ${g.description}` : ""} (${total > 0 ? `${done}/${total} steps done` : "no steps yet"})`);
    }
  }

  if (sourceItems.length > 0) {
    lines.push(`\nThings they've recently saved or jotted down (Attic items, journal-style captures) — use these for real personalization when relevant, don't just recite them back:\n${formatItemLines(sourceItems, tz, 20)}`);
  }

  if (corrections.length > 0) {
    lines.push("\nPast feedback they've given on suggestions like this — don't repeat something they've pushed back on for a similar reason:");
    for (const c of corrections.slice(0, 8)) {
      lines.push(`- "${c.natural_language_feedback}"`);
    }
  }

  return { profileContext: lines.join("\n"), userCity: city, displayName };
}

// ── AI goal breakdown ─────────────────────────────────────────────────────────

export interface BreakdownOptions {
  autoSave?: boolean;
  goalTitle?: string;
  goalId?: number;
}

// Light Haiku cleanup — used only when the caller doesn't already supply a
// goalTitle. Turns a raw stated goal ("hey i want to get into wine, know
// nothing about it") into a short, natural title ("Learn about wine")
// WITHOUT narrowing scope or picking a single action out of it — this is
// tidying phrasing for display, not the old crystallize-to-one-action
// behavior. Falls back to the raw text on any failure.
async function deriveCleanGoalTitle(rawGoal: string): Promise<string> {
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 30,
      messages: [{
        role: "user",
        content: `Turn this into a short goal title (under 8 words) — same scope and topic as stated, ` +
          `never narrowed to one specific action within it. Return ONLY the title, no quotes, no ` +
          `trailing punctuation.\n\n"${rawGoal}"`,
      }],
    });
    const title = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
    return title || rawGoal;
  } catch {
    return rawGoal;
  }
}

// Cheap pre-filter so extractStepsFromContent (an AI call) only runs on
// responses that plausibly contain a real plan — short answers, clarifying
// follow-ups, and pure prose never reach it.
function looksLikeRealPlan(content: string): boolean {
  if (content.length < 300) return false;
  const hasNumberedList = /^\s*\d+\.\s/m.test(content);
  const hasBulletList = /^\s*[-*]\s/m.test(content);
  const headerCount = (content.match(/^#{2,4}\s/gm) ?? []).length;
  return hasNumberedList || hasBulletList || headerCount >= 2;
}

// Extracts concrete, actionable steps from a breakdown's markdown content —
// reuses the same kind of extraction formatContentForSharing's "checklist"
// format already does, but returns structured data instead of a display
// string, and returns an empty array (not a fallback string) when the
// content is informational with no real plan to extract.
async function extractStepsFromContent(content: string): Promise<string[]> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content:
            `Extract the concrete milestone-level steps from the plan below — under 15 steps total, one per ` +
            `phase/week/major task, NOT a granular day-by-day or sub-task breakdown. Each step should read like ` +
            `a to-do checklist item (under 15 words), not a paragraph. Skip framing, context, and background ` +
            `explanation. If the text is informational/explanatory with no real actionable plan, return an ` +
            `empty array.\n\nReturn ONLY this JSON, no markdown: {"steps": ["step 1", "step 2", ...]}\n\n---\n${content.slice(0, 12000)}`,
        },
      ],
    });
    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) {
      logger.warn({ stopReason: response.stop_reason, rawLen: raw.length }, "[Goals] extractStepsFromContent: no JSON in response");
      return [];
    }
    const parsed = JSON.parse(m[0]) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) {
      logger.warn({ parsed }, "[Goals] extractStepsFromContent: steps was not an array");
      return [];
    }
    // Hard cap regardless of what the model returns — a goal's steps are a
    // checklist, not a day-by-day itinerary.
    return parsed.steps
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, 15);
  } catch (err) {
    logger.warn({ err }, "[Goals] extractStepsFromContent failed");
    return [];
  }
}

// User-initiated only — "give me a checklist for this" / "break this into
// steps I can track." Reuses the exact same extraction logic that used to
// run automatically on every save (extractStepsFromContent,
// looksLikeRealPlan) — only WHEN it runs has changed, not the underlying
// capability, which was already good.
export async function addGoalStepsFromContent(goalId: number, userName: string): Promise<number> {
  const goal = await getGoalById(goalId, userName);
  if (!goal || !goal.description) return 0;
  const steps = looksLikeRealPlan(goal.description)
    ? await extractStepsFromContent(goal.description)
    : [];
  await query(`DELETE FROM goal_steps WHERE goal_id = $1`, [goalId]);
  for (let i = 0; i < steps.length; i++) {
    await addStep(goalId, userName, steps[i]!, i);
  }
  return steps.length;
}

export async function breakdownGoal(
  goal: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName = NATIVE_STORED_NAME,
  options: BreakdownOptions = {}
): Promise<BreakdownResult> {
  const { profileContext, userCity } = await buildGoalsProfileContext(userName);

  const messages: Array<{ role: "user" | "assistant"; content: string }> =
    conversationHistory.length === 0
      ? [{ role: "user", content: goal }]
      : [...conversationHistory, { role: "user", content: goal }];

  const systemPrompt = `You are a knowledgeable, deeply personal advisor — like a brilliant friend who knows this person well and gives real, rich, personalized guidance.${profileContext ? `\n\n${profileContext}` : ""}

Your job is to open with ONE concrete, specific starting point for THIS person — the actual next thing to do, watch, read, listen to, or try, named exactly (a real track, album, book, class, app, route — never "find a good resource") — and briefly say why it fits them using what you know about them above. Then, since this is a full breakdown request, lay out the fuller path beneath that opening as concrete milestone-level stages so it can become a real step-by-step plan. Never open with generic background survey material before getting to something actionable — the concrete starting point always comes first.

RESPONSE STYLE:
- Lead with the one concrete thing. Everything else in the response supports or extends it.
- Be specific and real: name actual albums, tracks, books, apps, podcasts, venues, websites, communities. Never say "find a resource" — say exactly which one.
- Use a warm, direct, intelligent tone — like a trusted advisor who genuinely wants them to succeed.
- Length: as long as it needs to be to lay out a genuinely useful full plan beneath the opening — but the opening itself stays tight, not a preamble. Do NOT truncate, summarize, or cut off early once you're into the real plan.
- For learning goals (music, language, skills): after the concrete starting point, use a clear historical or progressive structure — show the path from beginner to deeper understanding era by era or level by level.
- For each stage of a learning path: name the key figures, specific recommended works (album/book/track titles with artist names), and what to listen/look for. Don't just list names — explain what makes each one important.
- For event/venue questions: search for what's genuinely on, when, and how to get tickets, and give a complete, accurate picture. Include everything relevant you find.
- When listing music recommendations, always include BOTH the artist AND the album/track title. Format as: "**Artist Name** — *Album Title* (year)". Give 5–15 specific examples per section.

HOW TO USE THE PROFILE:
- City/location: use it to recommend specific local venues, schools, events, or communities in their area.
- Existing music taste: this is gold for music goals — use it to build a BRIDGE. If the user likes country and wants to learn jazz, point out that country and jazz share Blues roots, and which jazz artists/albums will feel most familiar to them.
- People in their life: mention them only when it's a natural, genuinely helpful suggestion (e.g. "you could invite [name] to a live show"). Never force it.
- Hobbies/interests: use them when they genuinely connect.

ONLY ask a clarifying question if the goal is so vague that you literally cannot name one concrete starting point (e.g. "I want to get better" — better at what?). This is rare. If you have enough to go on, give the full response.

If there is conversation history, use it to refine, continue, or go deeper. Answer follow-up questions directly and thoroughly — treat this as a continuing conversation, not a fresh start.

When something needs current, specific, real-world detail — venue hours, addresses, current class schedules, whether a place is still open, current recommendations — search for it directly rather than relying on what you already know; don't guess or go stale on specifics you can just look up.

If you need to ask a clarifying question instead of giving a full response, write exactly:
---QUESTION---
Your single sharp question here.`;

  const response = await anthropic.messages.create({
    model:      MODEL_SONNET,
    // Deliberately generous, NOT copied from main chat's 1024 — a full
    // milestone-structured plan needs real room. The old GPT-4o call used
    // 16383; 8192 is Claude's practical ceiling for a single response.
    max_tokens: 8192,
    system:     systemPrompt,
    tools:      [{ type: "web_search_20250305" as const, name: "web_search" }],
    messages,
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();

  if (!raw) {
    logger.warn("[Goals] breakdown: Claude returned empty response");
    return { type: "question", content: "What's the single biggest obstacle you've hit on this before?" };
  }

  let result: BreakdownResult;

  // Check for clarifying question
  const questionDelimIdx = raw.indexOf("---QUESTION---");
  if (questionDelimIdx !== -1) {
    const questionText = raw.slice(questionDelimIdx + "---QUESTION---".length).trim();
    result = { type: "question", content: questionText || raw };
  } else {
    result = { type: "steps", content: raw, steps: [] };
  }

  // ── Auto-save goal to DB ──────────────────────────────────────────────────────
  // steps[] starts empty (the ---STEPS--- delimiter was removed; the full
  // response is in content/markdown) — only populated below when the content
  // actually looks like a real plan, not for every response that gets saved.
  if (options.autoSave && result.type === "steps") {
    try {
      let savedGoalId = options.goalId;
      // The goal IS the full substantive response now — not an extracted
      // opening paragraph (that was part of the old crystallize-to-one-
      // thing model). Capped generously, not truncated to a summary, since
      // this is meant to be a living document the person actually returns
      // to and reads, not a blurb.
      const description = result.content.length > 8000
        ? result.content.slice(0, 7997) + "…"
        : result.content;

      if (!savedGoalId) {
        const title = (options.goalTitle ?? await deriveCleanGoalTitle(goal)).slice(0, 120);
        const newGoal = await createGoal(userName, title, description);
        savedGoalId = newGoal.id;
        logger.info({ goalId: savedGoalId, title, descriptionLength: description.length }, "[Goals] Auto-saved goal from breakdown");
      } else {
        // A follow-up within the same breakdown conversation updating the
        // goal's content — replace the description with the latest full
        // response. No longer touches goal_steps here at all; steps are
        // user-initiated now (see addGoalStepsFromContent below), not tied
        // to every content update.
        await updateGoal(savedGoalId, userName, { description });
      }

      // steps is always empty in the return value now — no auto-generated
      // checklist to show. `type: "steps"` here is the existing response-
      // shape name (a full answer, vs. a clarifying question) — not a
      // literal claim about step content.
      result = { type: "steps", content: result.content, steps: [], goalId: savedGoalId };
    } catch (saveErr) {
      logger.warn({ saveErr }, "[Goals] Auto-save failed — returning result without goalId");
    }
  }

  return result;
}

// ── Share / copy formatting ───────────────────────────────────────────────────
// Takes the AI-generated markdown content and a format hint, then returns a
// clean plain-text version suitable for clipboard copy or OS share sheet.
// format options:
//   "playlist"  — extracts song/album/artist lines as a numbered list
//   "checklist" — extracts action items / steps as a plain checklist
//   "summary"   — short paragraph summary of the key points
//   "plain"     — strips markdown formatting, returns clean prose

export type ShareFormat = "playlist" | "checklist" | "summary" | "plain";

export async function formatContentForSharing(
  content: string,
  format: ShareFormat = "plain",
  title = ""
): Promise<string> {
  const formatInstructions: Record<ShareFormat, string> = {
    playlist: `Extract every song, album, or artist recommendation from the text and format them as a clean numbered playlist. Each line: "1. Song Title — Artist Name". Include the album name in parentheses if mentioned. No markdown. Return ONLY the numbered list, nothing else. Start with the title "${title || "Playlist"}" on the first line.`,
    checklist: `Extract every actionable item or step from the text and format as a plain checklist. Each line: "☐ Action item". No markdown. Return ONLY the checklist lines, nothing else.`,
    summary: `Write a concise 3–5 sentence plain-text summary of the key points and recommendations. No markdown, no bullet points, no headers. Just clear prose.`,
    plain: `Convert the following markdown text to clean plain text. Remove all markdown formatting (**, *, #, -, etc.) but preserve the content and structure. Use plain paragraph breaks.`,
  };

  const prompt = formatInstructions[format];

  try {
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n---\n${content.slice(0, 12000)}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    return text.trim();
  } catch (err) {
    logger.warn({ err, format }, "[Goals] formatContentForSharing failed");
    // Fallback: strip basic markdown manually
    return content
      .replace(/#{1,6}\s+/g, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/^[-*]\s+/gm, "• ")
      .slice(0, 4000)
      .trim();
  }
}

// ── Goals recap (daily cached summary) ───────────────────────────────────────
// Returns a Claude-generated short recap of the user's goal progress.
// Cached in the DB and only regenerated once per 24 hours.

export interface GoalsRecap {
  recap: string;
  generated_at: string;
  from_cache: boolean;
}

export async function generateGoalsRecap(userName: string): Promise<GoalsRecap> {
  // Check for a fresh cache entry (less than 24h old)
  const { rows: cached } = await query<{ recap: string; generated_at: string }>(
    `SELECT recap, generated_at::text
       FROM goals_recap_cache
      WHERE user_name = $1
        AND generated_at > now() - INTERVAL '24 hours'`,
    [userName]
  );
  if (cached[0]) {
    return { recap: cached[0].recap, generated_at: cached[0].generated_at, from_cache: true };
  }

  // Build a summary of the user's goals to pass to Claude. Completed goals
  // are excluded from the recap's "active goals" framing now that status is
  // a real signal — previously completed_at never fired, so every goal was
  // counted as active by default; that's no longer true once completion is
  // real.
  const goals = (await getGoals(userName)).filter((g) => g.status !== "completed");
  if (goals.length === 0) {
    const fallback = "You haven't set any goals yet — but you're here, which counts for something.";
    await query(
      `INSERT INTO goals_recap_cache (user_name, recap)
       VALUES ($1, $2)
       ON CONFLICT (user_name) DO UPDATE SET recap = EXCLUDED.recap, generated_at = now()`,
      [userName, fallback]
    );
    const { rows: saved } = await query<{ generated_at: string }>(
      `SELECT generated_at::text FROM goals_recap_cache WHERE user_name = $1`,
      [userName]
    );
    return { recap: fallback, generated_at: saved[0]?.generated_at ?? new Date().toISOString(), from_cache: false };
  }

  // Calculate stats
  const totalGoals = goals.length;
  const totalSteps = goals.reduce((n, g) => n + g.steps.length, 0);
  const completedSteps = goals.reduce((n, g) => n + g.steps.filter((s) => s.completed).length, 0);

  // Steps completed this week
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stepsThisWeek = goals.reduce(
    (n, g) =>
      n +
      g.steps.filter(
        (s) => s.completed && s.completed_at && new Date(s.completed_at) >= weekAgo
      ).length,
    0
  );

  // Nearest incomplete step (first incomplete step across goals, ordered by goal creation date)
  let nearestIncomplete: { goalTitle: string; stepText: string } | null = null;
  for (const g of goals) {
    const incomplete = g.steps.filter((s) => !s.completed).sort((a, b) => a.order - b.order);
    if (incomplete[0]) {
      nearestIncomplete = { goalTitle: g.title, stepText: incomplete[0].step_text };
      break;
    }
  }

  // Build a brief goal list for Claude
  const goalSummaries = goals
    .slice(0, 8)
    .map((g) => {
      const done = g.steps.filter((s) => s.completed).length;
      const total = g.steps.length;
      return `• "${g.title}" — ${total > 0 ? `${done}/${total} steps done` : "no steps yet"}`;
    })
    .join("\n");

  const userProfile = await getProfile(userName).catch(() => null);
  const displayName = userProfile?.name ?? userName;

  const prompt =
    `You are Winston, a warm and direct personal advisor. ` +
    `Write a 2–3 sentence progress recap for ${displayName} to read when they return to their Goals screen. ` +
    `Be encouraging but honest. Reference specific numbers and, if there's a next step, name it. ` +
    `Keep it under 60 words. No markdown, no headers — just plain conversational prose.\n\n` +
    `Stats:\n` +
    `- ${totalGoals} active goal${totalGoals !== 1 ? "s" : ""}\n` +
    `- ${completedSteps} of ${totalSteps} steps complete\n` +
    `- ${stepsThisWeek} step${stepsThisWeek !== 1 ? "s" : ""} completed this week\n` +
    (nearestIncomplete
      ? `- Next up: "${nearestIncomplete.stepText}" (goal: ${nearestIncomplete.goalTitle})\n`
      : "") +
    `\nGoals:\n${goalSummaries}`;

  let recap: string;
  try {
    const response = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    recap =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : `You have ${completedSteps} of ${totalSteps} steps done across ${totalGoals} goals. Keep going.`;
  } catch (err) {
    logger.warn({ err }, "[Goals] generateGoalsRecap AI failed — using fallback");
    recap = `You have ${completedSteps} of ${totalSteps} steps done across ${totalGoals} goal${totalGoals !== 1 ? "s" : ""}.${nearestIncomplete ? ` Next up: "${nearestIncomplete.stepText}".` : ""}`;
  }

  // Save to cache
  await query(
    `INSERT INTO goals_recap_cache (user_name, recap)
     VALUES ($1, $2)
     ON CONFLICT (user_name) DO UPDATE SET recap = EXCLUDED.recap, generated_at = now()`,
    [userName, recap]
  ).catch((err) => logger.warn({ err }, "[Goals] Failed to cache recap"));

  const { rows: saved } = await query<{ generated_at: string }>(
    `SELECT generated_at::text FROM goals_recap_cache WHERE user_name = $1`,
    [userName]
  );

  return { recap, generated_at: saved[0]?.generated_at ?? new Date().toISOString(), from_cache: false };
}

// ── Goals chat history ────────────────────────────────────────────────────────
// Returns the last N goals-chat messages for the user, ordered oldest→newest.
// Messages are identified by the `goals:` prefix on message_id.
// limit: max messages to return (default 40 = ~20 exchanges).
export async function getGoalsChatHistory(
  userName: string,
  limit = 40
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  // Select the newest `limit` rows (DESC), then re-order oldest→newest (ASC)
  // so the client receives messages in chronological conversation order.
  const { rows } = await query<{ role: string; content: string }>(
    `SELECT role, content
       FROM (
         SELECT id, role, content
           FROM chat_messages
          WHERE user_name = $1
            AND message_id LIKE 'goals:%'
          ORDER BY id DESC
          LIMIT $2
       ) sub
      ORDER BY id ASC`,
    [userName, limit]
  );
  const validRoles = new Set(["user", "assistant"]);
  return rows
    .filter((r) => validRoles.has(r.role))
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
    }));
}

// ── Free-form goals conversation ───────────────────────────────────────────────
// Used by /api/goals/chat. Continues a conversation about a goal that
// ALREADY EXISTS — this no longer creates new goals or crystallizes
// anything down to one action to offer for saving (that was the old,
// now-rejected model; breakdownGoal creates goals now, saving the full
// first answer as-is — see its autoSave handling above). This function's
// job: answer questions naturally against the goal's saved content, and
// recognize when the person wants a concrete action taken.

export interface GoalsFreeformChatResult {
  reply:         string;
  actionTaken?:  "reminder_added" | "steps_added" | null;
  actionDetail?: string | null;
}

export async function goalsFreeformChat(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName: string,
  goalId?: number,
): Promise<GoalsFreeformChatResult> {
  const { profileContext, displayName, userCity } = await buildGoalsProfileContext(userName);
  const goal = goalId ? await getGoalById(goalId, userName) : null;

  const goalContextBlock = goal
    ? `\n\nThe goal you're discussing right now: "${goal.title}"${goal.description ? `\n\n${goal.description}` : ""}\n\n` +
      `This is a living document ${displayName} returns to over time — answer their questions about it ` +
      `naturally and specifically, suggest concrete next actions when it genuinely fits, and don't re-summarize ` +
      `the whole thing unless they ask for that.`
    : "";

  const systemPrompt =
    `You are a knowledgeable, deeply personal advisor continuing a conversation about a goal ${displayName} ` +
    `is already working on.${profileContext ? `\n\n${profileContext}` : ""}${goalContextBlock}\n\n` +
    `Answer what they actually asked, specifically and directly — real recommendations, real reasoning tied to ` +
    `what you know about them, matching the depth of the question (a quick question gets a quick answer, a ` +
    `bigger one gets real depth). Never invent generic filler just to seem thorough.\n\n` +
    `If what they're asking implies a concrete action you can actually take, take it:\n` +
    `- A reminder or to-do ("remind me to...", "add ... to my to-do list", "I should pick up...") → end your ` +
    `reply with [ACTION:add_reminder|task=<the task, in your own words>|time=<a specific time/date if one was ` +
    `implied, otherwise omit this parameter entirely>]. Never claim something was added unless you actually ` +
    `emitted this tag — a friendly sentence alone doesn't create anything.\n` +
    `- Nothing else is wired up as an action here yet. For anything else concrete they want tracked, talk it ` +
    `through naturally instead.\n\n` +
    `If ${displayName} EXPLICITLY asks for a checklist, steps, or something to check off — a real request for ` +
    `trackable steps, not just discussion — end your reply with [ACTION:add_goal_steps]. Only do this when ` +
    `they clearly ask; never offer or create a checklist unprompted, even for a naturally step-shaped topic.\n\n` +
    `When something needs current, specific, real-world detail — venue hours, addresses, current class ` +
    `schedules, whether a place is still open, current recommendations — search for it directly rather than ` +
    `relying on what you already know; don't guess or go stale on specifics you can just look up.`;

  const contextPrefix = userCity ? `[User: ${displayName}, based in ${userCity}]\n` : `[User: ${displayName}]\n`;

  // openGoalDiscussion (native client) seeds a resumed goal's thread with an
  // assistant-authored message (the goal's saved description) before any
  // user turn exists — fine for OpenAI, but Anthropic's Messages API rejects
  // any messages array that doesn't start with role "user". Strip a leading
  // assistant message rather than erroring: its content is already present
  // in goalContextBlock above, so nothing is lost by not resending it here.
  let historyForClaude = conversationHistory;
  while (historyForClaude.length && historyForClaude[0]!.role === "assistant") {
    historyForClaude = historyForClaude.slice(1);
  }

  const response = await anthropic.messages.create({
    model:      MODEL_SONNET,
    // Was 2048 for plain conversational replies — bumped for follow-ups
    // that now pull in live search results and may warrant real depth,
    // while staying well under breakdownGoal's ceiling (this function's
    // own prompt still instructs staying tight for narrow questions).
    max_tokens: 4096,
    system:     systemPrompt,
    tools:      [{ type: "web_search_20250305" as const, name: "web_search" }],
    messages:   [...historyForClaude, { role: "user", content: contextPrefix + message }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();
  if (!raw) {
    logger.warn({ userName, goalId }, "[Goals] goalsFreeformChat returned empty response");
    return { reply: "I didn't quite catch that — could you say a bit more?" };
  }

  // Same [ACTION:type|params] convention chatHandlerCore.ts uses —
  // deliberately reused rather than inventing a third tag syntax,
  // intentionally scoped to just the two action types relevant here.
  const tagMatch = raw.match(/\[ACTION:([^\]]+)\][\s]*$/);
  const reply = raw.replace(/\n?\[ACTION:[^\]]+\]/g, "").trim();

  if (!tagMatch) {
    return { reply };
  }

  const tagContent = tagMatch[1]!;
  const parts: Record<string, string> = {};
  tagContent.split("|").forEach((p) => {
    const eq = p.indexOf("=");
    if (eq === -1) parts["_type"] = p;
    else { parts["_type"] = parts["_type"] || p.slice(0, eq); parts[p.slice(0, eq)] = p.slice(eq + 1); }
  });

  if (parts["_type"] === "add_reminder" && parts.task) {
    try {
      const { timezone: tz } = await getUserLocationContext(userName).catch(() => ({ timezone: "UTC" }));
      let fireAt: Date | null = null;
      if (parts.time) {
        const parsedDate = new Date(parts.time);
        if (!isNaN(parsedDate.getTime())) fireAt = parsedDate;
      }
      await createReminder({ userName, reminderText: parts.task, fireAt: fireAt as any, timezone: tz });
      logger.info({ userName, goalId, task: parts.task }, "[Goals] Reminder added from goal chat");
      return { reply, actionTaken: "reminder_added", actionDetail: parts.task };
    } catch (err) {
      logger.warn({ err, userName, goalId }, "[Goals] add_reminder action failed");
      return { reply };
    }
  }

  if (parts["_type"] === "add_goal_steps" && goalId) {
    try {
      const count = await addGoalStepsFromContent(goalId, userName);
      logger.info({ userName, goalId, count }, "[Goals] Steps added from goal chat, on request");
      return { reply, actionTaken: count > 0 ? "steps_added" : null, actionDetail: count > 0 ? `${count} steps` : null };
    } catch (err) {
      logger.warn({ err, userName, goalId }, "[Goals] add_goal_steps action failed");
      return { reply };
    }
  }

  return { reply };
}
