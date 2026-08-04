import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { MODEL_HAIKU } from "../lib/models.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import type { SourceItem, UserCorrection } from "../connectionEngine/memorySourceAdapters.js";
import { fetchFromAdapters, getRecentCorrections, formatItemLines } from "../connectionEngine/memorySourceAdapters.js";

const MODEL_GPT4O = "gpt-4o" as const;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

// ── Pending goal offer (goals-chat screen only) ──────────────────────────────
// Mirrors listManager.ts's pendingSaveOffers: the moment the free-form
// goals-chat conversation lands on something concrete enough to be worth
// keeping, the model flags it (---GOAL_OFFER---) and the real title/content
// are captured right then, in goalsFreeformChat — a later "yes, save that"
// resolves from here instead of asking the model to retype content it
// already generated. Single slot per user, no TTL — overwritten by a newer
// offer, cleared on confirm, lost on restart, same tradeoffs as every other
// in-memory pending-state map in this codebase (pendingSaveOffers,
// pendingAtticCleanup, pendingListTypeConflict, mostRecentShownObservation).

export interface PendingGoalOffer {
  title:   string;
  content: string; // the offering turn's own reply text, before the delimiter
}

const _pendingGoalOfferMap = new Map<string, PendingGoalOffer>();

export function getPendingGoalOffer(userName: string): PendingGoalOffer | null {
  return _pendingGoalOfferMap.get(userName) ?? null;
}

export function setPendingGoalOffer(userName: string, offer: PendingGoalOffer | null): void {
  if (offer === null) {
    _pendingGoalOfferMap.delete(userName);
  } else {
    _pendingGoalOfferMap.set(userName, offer);
  }
}

// A lightweight text-based safety net for the confirm step only — mirrors
// the save-offer/notepad-conversion recovery nets in chatHandlerCore.ts.
// GPT-4o occasionally narrates a confident "saved!" without emitting the
// ---GOAL_CONFIRMED--- line despite explicit instruction; when a pending
// offer exists and the user's own message unambiguously said yes/save it,
// recover and save anyway rather than silently losing it. No equivalent net
// on the offer side — a missed offer just means the conversation continues
// normally, lower stakes than losing a confirmed save.
export function isUnambiguousGoalConfirmation(message: string): boolean {
  const t = message.trim();
  if (/^(yes|yeah|yep|yup|sure|ok(ay)?|absolutely|definitely|do it|go ahead|sounds good|please do)[.!]*$/i.test(t)) {
    return true;
  }
  if (/\b(save|add)\b[\s\S]{0,20}\b(it|that|this)\b/i.test(t) && !/\b(no|not|don'?t)\b/i.test(t)) {
    return true;
  }
  return false;
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
    fetchFromAdapters(userName, ["life_capture", "attic_item"], 30).catch(() => [] as SourceItem[]),
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

// ── SerpAPI web search ────────────────────────────────────────────────────────
// Used for real-time queries: venue events, concerts, current listings, etc.

function getSerpApiKey(): string {
  return (process.env.SERPAPI_KEY ?? "").trim();
}

const WEB_SEARCH_PATTERNS = [
  /playing at\s+\w/i,
  /who('?s| is) (playing|performing|on stage|headlining)/i,
  /events?\s+(at|this|tonight|this)\b/i,
  /\bthis (week|weekend|month|night)\b/i,
  /\btonight\b/i,
  /upcoming (shows?|concerts?|events?|gigs?)/i,
  /\blive (music|show|performance)\b/i,
  /what('?s| is) (on|happening|playing|showing)/i,
  /current (events?|shows?|exhibits?)/i,
  /\bschedule\b.*\b(venue|club|bar|hall)\b/i,
  /\btickets?\s+for\b/i,
  /(performing|playing|appearing)\s+(this|next)\s+(week|weekend|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
];

function detectWebSearchQuery(
  messages: Array<{ role: string; content: string }>
): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const recent = messages.slice(-4).map((m) => m.content).join(" ");
  const haystack = lastUser || recent;
  if (WEB_SEARCH_PATTERNS.some((p) => p.test(haystack))) {
    return lastUser.trim() || recent.slice(0, 200);
  }
  return null;
}

async function serpApiSearch(rawQuery: string, city: string): Promise<string> {
  const key = getSerpApiKey();
  if (!key) return "";

  try {
    // Append city if not already in query
    const cityHint = city && !rawQuery.toLowerCase().includes(city.toLowerCase())
      ? ` ${city}` : "";
    const q = `${rawQuery}${cityHint}`;

    // Try Google Events engine first — best for venue/concert queries
    const eventsUrl =
      `https://serpapi.com/search.json?engine=google_events` +
      `&q=${encodeURIComponent(q)}&hl=en&api_key=${encodeURIComponent(key)}`;
    const eventsRes = await fetch(eventsUrl, { signal: AbortSignal.timeout(8000) });
    if (eventsRes.ok) {
      const eventsData = await eventsRes.json() as {
        events_results?: Array<{
          title: string;
          date?: { start_date?: string; when?: string };
          address?: string[];
          description?: string;
          link?: string;
          ticket_info?: Array<{ link?: string; source?: string }>;
        }>;
      };
      const events = eventsData.events_results ?? [];
      if (events.length > 0) {
        const lines = events.slice(0, 12).map((e) => {
          const when = e.date?.when ?? e.date?.start_date ?? "";
          const where = (e.address ?? []).join(", ");
          const desc = e.description ? ` — ${e.description.slice(0, 150)}` : "";
          const ticket = e.ticket_info?.[0]?.link ? ` [Tickets: ${e.ticket_info[0].link}]` : "";
          return `• ${e.title}${when ? ` (${when})` : ""}${where ? ` @ ${where}` : ""}${desc}${ticket}`;
        });
        return `Real-time event search results for "${q}":\n${lines.join("\n")}`;
      }
    }

    // Fallback: regular Google search
    const webUrl =
      `https://serpapi.com/search.json?q=${encodeURIComponent(q)}` +
      `&num=8&api_key=${encodeURIComponent(key)}`;
    const webRes = await fetch(webUrl, { signal: AbortSignal.timeout(8000) });
    if (!webRes.ok) return "";
    const webData = await webRes.json() as {
      organic_results?: Array<{ title: string; snippet?: string; link?: string }>;
      knowledge_graph?: { description?: string; website?: string };
    };
    const parts: string[] = [];
    if (webData.knowledge_graph?.description) {
      parts.push(`Knowledge: ${webData.knowledge_graph.description}`);
    }
    const organics = (webData.organic_results ?? []).slice(0, 6);
    for (const r of organics) {
      parts.push(`• ${r.title}: ${r.snippet ?? ""}`.slice(0, 220));
    }
    if (!parts.length) return "";
    return `Web search results for "${q}":\n${parts.join("\n")}`;
  } catch (err) {
    logger.warn({ err }, "[Goals] SerpAPI search failed");
    return "";
  }
}

// ── AI goal breakdown ─────────────────────────────────────────────────────────

export interface BreakdownOptions {
  autoSave?: boolean;
  goalTitle?: string;
  goalId?: number;
}

// Pulls the opening paragraph out of a breakdown's markdown content to use as
// the goal's description — skips any leading headers (e.g. "# Learning Jazz")
// so it lands on the actual why-this-matters prose the system prompt asks
// GPT-4o to open with, not a title repeated back. Returns null if the content
// has no real opening paragraph to extract (e.g. it jumps straight into a
// list with no framing).
function deriveDescriptionFromContent(content: string): string | null {
  const paragraphLines: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(line);
  }
  const paragraph = paragraphLines.join(" ").trim()
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1");
  if (!paragraph) return null;
  return paragraph.length > 500 ? `${paragraph.slice(0, 497)}…` : paragraph;
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

export async function breakdownGoal(
  goal: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName = NATIVE_STORED_NAME,
  options: BreakdownOptions = {}
): Promise<BreakdownResult> {
  const { profileContext, userCity } = await buildGoalsProfileContext(userName);

  // Build messages array before web search so we can detect intent
  const messages: Array<{ role: "user" | "assistant"; content: string }> =
    conversationHistory.length === 0
      ? [{ role: "user", content: goal }]
      : [...conversationHistory, { role: "user", content: goal }];

  // ── Web search for real-time queries ─────────────────────────────────────────
  let webSearchContext = "";
  const searchQuery = detectWebSearchQuery(messages);
  if (searchQuery) {
    logger.info({ searchQuery }, "[Goals] Running SerpAPI web search");
    webSearchContext = await serpApiSearch(searchQuery, userCity);
    if (webSearchContext) {
      logger.info({ chars: webSearchContext.length }, "[Goals] Web search results injected");
    }
  }

  const systemPrompt = `You are a knowledgeable, deeply personal advisor — like a brilliant friend who knows this person well and gives real, rich, personalized guidance.${profileContext ? `\n\n${profileContext}` : ""}

Your job is to open with ONE concrete, specific starting point for THIS person — the actual next thing to do, watch, read, listen to, or try, named exactly (a real track, album, book, class, app, route — never "find a good resource") — and briefly say why it fits them using what you know about them above. Then, since this is a full breakdown request, lay out the fuller path beneath that opening as concrete milestone-level stages so it can become a real step-by-step plan. Never open with generic background survey material before getting to something actionable — the concrete starting point always comes first.

RESPONSE STYLE:
- Lead with the one concrete thing. Everything else in the response supports or extends it.
- Be specific and real: name actual albums, tracks, books, apps, podcasts, venues, websites, communities. Never say "find a resource" — say exactly which one.
- Use a warm, direct, intelligent tone — like a trusted advisor who genuinely wants them to succeed.
- Length: as long as it needs to be to lay out a genuinely useful full plan beneath the opening — but the opening itself stays tight, not a preamble. Do NOT truncate, summarize, or cut off early once you're into the real plan.
- For learning goals (music, language, skills): after the concrete starting point, use a clear historical or progressive structure — show the path from beginner to deeper understanding era by era or level by level.
- For each stage of a learning path: name the key figures, specific recommended works (album/book/track titles with artist names), and what to listen/look for. Don't just list names — explain what makes each one important.
- For event/venue questions: if you have real-time data (provided below), use it to give a complete, accurate picture of what's on, when, and how to get tickets. Include ALL the events from the search data.
- When listing music recommendations, always include BOTH the artist AND the album/track title. Format as: "**Artist Name** — *Album Title* (year)". Give 5–15 specific examples per section.

HOW TO USE THE PROFILE:
- City/location: use it to recommend specific local venues, schools, events, or communities in their area.
- Existing music taste: this is gold for music goals — use it to build a BRIDGE. If the user likes country and wants to learn jazz, point out that country and jazz share Blues roots, and which jazz artists/albums will feel most familiar to them.
- People in their life: mention them only when it's a natural, genuinely helpful suggestion (e.g. "you could invite [name] to a live show"). Never force it.
- Hobbies/interests: use them when they genuinely connect.

ONLY ask a clarifying question if the goal is so vague that you literally cannot name one concrete starting point (e.g. "I want to get better" — better at what?). This is rare. If you have enough to go on, give the full response.

If there is conversation history, use it to refine, continue, or go deeper. Answer follow-up questions directly and thoroughly — treat this as a continuing conversation, not a fresh start.${webSearchContext ? `\n\nREAL-TIME DATA (use this to answer the question accurately):\n${webSearchContext}` : ""}

If you need to ask a clarifying question instead of giving a full response, write exactly:
---QUESTION---
Your single sharp question here.`;

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 16383,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";

  if (!raw) {
    logger.warn("[Goals] breakdown: GPT-4o returned empty response");
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
      const steps = looksLikeRealPlan(result.content)
        ? await extractStepsFromContent(result.content)
        : [];

      if (!savedGoalId) {
        const title = (options.goalTitle ?? goal).slice(0, 120);
        // The system prompt already instructs GPT-4o to "build context before
        // jumping to steps" — the opening paragraph is real why-this-matters
        // framing the model already wrote, not a new AI call.
        const description = deriveDescriptionFromContent(result.content);
        const newGoal = await createGoal(userName, title, description);
        savedGoalId = newGoal.id;
        logger.info({ goalId: savedGoalId, title, hasDescription: !!description, stepCount: steps.length }, "[Goals] Auto-saved goal from breakdown");
      } else {
        // Clear old steps before re-adding so follow-up conversations don't double-up
        await query(`DELETE FROM goal_steps WHERE goal_id = $1`, [savedGoalId]);
      }

      for (let i = 0; i < steps.length; i++) {
        await addStep(savedGoalId, userName, steps[i]!, i);
      }

      result = { type: "steps", content: result.content, steps, goalId: savedGoalId };
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
// Used by /api/goals/chat — conversational AI response without forced step
// structure. Landing point (per the redesign): the conversation should reach
// ONE concrete, personally-relevant starting point, not a general-information
// dump, while staying open to real back-and-forth if the user wants to keep
// exploring. When the conversation lands somewhere concrete enough to be
// worth keeping, the model flags it with the ---GOAL_OFFER--- sentinel (same
// idiom as breakdownGoal's ---QUESTION--- delimiter) and the real content is
// captured into a per-user pending offer; a later natural confirmation
// resolves from that instead of asking the model to retype it. The caller is
// responsible for persisting the exchange to chat_messages.

export interface GoalsFreeformChatResult {
  reply: string;
  saved?: boolean;
  goalId?: number;
  goalTitle?: string;
}

const GOAL_OFFER_DELIM     = "---GOAL_OFFER---";
const GOAL_CONFIRMED_DELIM = "---GOAL_CONFIRMED---";

export async function goalsFreeformChat(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName: string
): Promise<GoalsFreeformChatResult> {
  const { profileContext, displayName, userCity } = await buildGoalsProfileContext(userName);
  const pendingOffer = getPendingGoalOffer(userName);

  const pendingOfferBlock = pendingOffer
    ? `\n\n[Pending Goal Offer — you just offered to save this as "${pendingOffer.title}"]\n` +
      `If their latest message confirms saving it (yes, save it, do it, sounds good, etc.), reply with a brief warm confirmation in your own words and end your reply with exactly this, on its own line:\n` +
      `${GOAL_CONFIRMED_DELIM}\n` +
      `This is not optional — telling them it's saved without emitting this exact line means nothing is actually written to their goals list. If they decline, change the subject, or ask something unrelated, just respond naturally and do NOT emit that line.`
    : "";

  const systemPrompt =
    `You are a knowledgeable, deeply personal advisor — like a brilliant friend who knows this person well.${profileContext ? `\n\n${profileContext}` : ""}\n\n` +
    `Your job in this conversation is to help them land on something concrete, personally-relevant, and real to actually do, watch, read, listen to, or try — not a survey of background information. Name actual things (a real track, album, book, class, app, route — never "find a good resource").\n\n` +
    `MATCH YOUR DEPTH TO WHAT WAS ACTUALLY ASKED — this matters as much as personalization does. Read the shape of their question before answering:\n` +
    `- A narrow, specific ask ("just give me one thing to start with," "what's the single best album") gets a tight answer: one concrete thing, real personalized reasoning, done.\n` +
    `- A broad or multi-part ask — naming several distinct facets at once (e.g. "styles, types, places to go"), or a genuinely open "tell me about X" — deserves real breadth. Address EVERY distinct part they named, not just the first or easiest one. If they asked about styles AND places, your reply covers styles AND places, each with specific personalized picks, not one part answered and the rest silently dropped. Covering that much ground does NOT let you off the hook for landing on one thing at the end — see the mandatory-offer rule below, which applies exactly the same regardless of how much breadth came before it.\n` +
    `- Never compress a multi-part question into a single generic item just to keep the reply short. A short reply that only answers one-third of what was asked is a worse answer than a longer one that actually covers it — length should come from how much ground the question covers, not from a fixed target.\n\n` +
    `PERSONALIZATION IS MANDATORY, NOT OPTIONAL — at every depth: a bare name with no reasoning ("attend a wine tasting") is a label, not a recommendation, and is never acceptable, whether it's the one thing in a tight answer or one item among many in a broad one. Every concrete thing you name must come with a real, specific reason tied to something you actually know about this person above — their hobbies, another goal, something they've saved or mentioned, someone in their life, their music/artist taste, where they live, or something they said earlier in this conversation. A real one reads like "Try [specific thing] — since you're into [specific fact about them], this fits because [specific reason]," never just the name of the thing. When covering several facets of a broad question, each facet gets its own specific, personalized pick — don't personalize the first one and list the rest generically. If you genuinely don't have anything specific yet to hang the reasoning on, ask one question to get something concrete rather than naming something generic with no connection to them.\n\n` +
    `Within whatever depth is actually called for, stay tight — no padding, no generic background survey material, no essay when a paragraph will do. But never sacrifice covering what was actually asked, or the personalized reasoning behind each pick, just to hit a shorter length. If they want to go deeper, ask follow-ups, or want a fuller plan, keep going naturally; this is a real conversation, not a scripted flow.\n\n` +
    `EVERY REPLY THAT NAMES SOMETHING CONCRETE MUST END BY OFFERING TO SAVE IT — MANDATORY, NOT CONDITIONAL ON DEPTH: if your reply named ANY specific thing(s) to do/watch/read/listen to/try, it must end by crystallizing down to the SINGLE best concrete starting point — even if you covered five facets with a personalized pick under each — and explicitly asking if they want to save THAT ONE THING, in your own words (e.g. "Want me to add [that specific thing] as a goal?"). A rich, multi-part answer is never an exemption from this — if anything it needs this landing step MORE, since without it they're left with a pile of options and no clear next action. Pick the single most compelling one (never "pick any of the above," never a vague wrapper title describing the whole topic), name it specifically, and ask. The delimiter alone with no visible ask leaves them with no way to know there's anything to confirm. Then end your reply with exactly this, on its own line:\n` +
    `${GOAL_OFFER_DELIM}\n` +
    `A short, specific title (under 8 words) naming the ONE thing you just crystallized to — never a title describing the whole broad topic you covered\n` +
    `The only exemption is a reply that named nothing concrete at all — purely informational or clarifying, no real recommendation in it anywhere. Never more than one offer per turn. ` +
    `${GOAL_OFFER_DELIM} and ${GOAL_CONFIRMED_DELIM} must never both appear in the same reply — offering something is not the same as it being saved. Saving only ever happens in response to the user's own separate, later message actually confirming it. Never emit both delimiters in one turn, and never say or imply it's already saved unless you are emitting ${GOAL_CONFIRMED_DELIM} in direct response to that separate confirmation.` +
    pendingOfferBlock;

  // Prepend basic profile context to the first user turn — same pattern as travel screen.
  const contextPrefix = userCity
    ? `[User: ${displayName}, based in ${userCity}]\n`
    : `[User: ${displayName}]\n`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: contextPrefix + message },
  ];

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 2048,
    messages,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) {
    logger.warn({ userName }, "[Goals] goalsFreeformChat returned empty response");
    return { reply: "I didn't quite catch that — could you say a bit more?" };
  }

  let reply = raw;

  // ── Parse a new goal offer, if this turn made one ──────────────────────────
  const offerIdx = raw.indexOf(GOAL_OFFER_DELIM);
  let madeNewOffer = false;
  if (offerIdx !== -1) {
    const before = raw.slice(0, offerIdx).trim();
    const titleLine = raw.slice(offerIdx + GOAL_OFFER_DELIM.length).trim().split("\n")[0]?.trim();
    reply = before || raw; // never show the raw sentinel to the user
    if (titleLine) {
      setPendingGoalOffer(userName, { title: titleLine.slice(0, 120), content: before || raw });
      madeNewOffer = true;
      logger.info({ userName, title: titleLine }, "[Goals] Goal offer cached from chat");
    }
  }

  // ── Resolve a confirmation against the offer that was pending BEFORE this
  // call — only relevant when this turn didn't just make a brand-new offer
  // of its own (that would supersede, not confirm, the old one). ─────────────
  let confirmedViaTag = false;
  if (!madeNewOffer && pendingOffer) {
    const confirmIdx = reply.indexOf(GOAL_CONFIRMED_DELIM);
    if (confirmIdx !== -1) {
      reply = reply.slice(0, confirmIdx).trim();
      confirmedViaTag = true;
    }
  }
  const shouldConfirm =
    !madeNewOffer && !!pendingOffer &&
    (confirmedViaTag || isUnambiguousGoalConfirmation(message));

  // ── Safety net: an unambiguous "save it" with nothing actually pending ──────
  // Defense-in-depth for the real failure this was built to catch: a reply can
  // name real, specific things without ever crystallizing to one and asking to
  // save it (the prompt above is the actual fix for that) — when it doesn't,
  // "save it" lands with pendingOffer null and shouldConfirm false, and would
  // otherwise fall through to whatever GPT-4o happened to say, silently doing
  // nothing with no signal anything went wrong. Override with an explicit,
  // deterministic ask instead of trusting the model noticed the mismatch.
  if (!madeNewOffer && !pendingOffer && isUnambiguousGoalConfirmation(message)) {
    logger.info({ userName }, "[Goals] Unambiguous save confirmation with no pending offer — asking what to save instead of silent no-op");
    return { reply: "What would you like me to save as a goal? Let's land on something concrete first." };
  }

  if (!shouldConfirm) {
    return { reply };
  }

  // ── Save: reuse the description/step-extraction logic already built for
  // breakdownGoal's autoSave path (deriveDescriptionFromContent,
  // looksLikeRealPlan/extractStepsFromContent) against the offer's own
  // captured content — never a second AI call to regenerate it. ─────────────
  try {
    const description = deriveDescriptionFromContent(pendingOffer!.content);
    const goal = await createGoal(userName, pendingOffer!.title, description);
    const steps = looksLikeRealPlan(pendingOffer!.content)
      ? await extractStepsFromContent(pendingOffer!.content)
      : [];
    for (let i = 0; i < steps.length; i++) {
      await addStep(goal.id, userName, steps[i]!, i);
    }
    setPendingGoalOffer(userName, null);
    logger.info(
      { userName, goalId: goal.id, title: goal.title, hasDescription: !!description, stepCount: steps.length, viaTag: confirmedViaTag },
      "[Goals] Goal saved from chat confirmation"
    );
    return { reply, saved: true, goalId: goal.id, goalTitle: goal.title };
  } catch (err) {
    logger.warn({ err, userName }, "[Goals] Failed to save goal from chat confirmation");
    return { reply };
  }
}
