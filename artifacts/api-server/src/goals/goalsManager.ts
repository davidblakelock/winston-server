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

export async function breakdownGoal(
  goal: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName = NATIVE_STORED_NAME,
  options: BreakdownOptions = {}
): Promise<BreakdownResult> {
  const userProfile = await getProfile(userName).catch(() => null);
  let profileContext = "";
  let userCity = "Dallas";

  if (userProfile) {
    const raw = (userProfile.rawData ?? {}) as CollectedData;
    const displayName = userProfile.name ?? userName;
    const city = userProfile.city ?? (raw.city as string | undefined) ?? "";
    if (city) userCity = city;
    const people = (raw.people ?? []) as Array<{ name: string; relationship: string; city?: string; details?: string }>;
    const rawAny = raw as Record<string, unknown>;
    const music  = ((rawAny.music ?? rawAny.musicTaste ?? "") as string);
    const hobbies = ((rawAny.hobbies ?? rawAny.interests ?? "") as string);

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

Your job is to give a thorough, thoughtful response to any goal or question — not a generic numbered checklist, but a genuinely useful, engaging guide written specifically for THIS person.

RESPONSE STYLE:
- Write in rich markdown with headers, sections, and sub-sections where appropriate.
- Be specific and real: name actual albums, tracks, books, apps, podcasts, venues, websites, communities. Never say "find a resource" — say exactly which one.
- Build context before jumping to steps: explain the landscape, the approach, what to expect. Make them feel informed, not just instructed.
- Use a warm, direct, intelligent tone — like a trusted advisor who genuinely wants them to succeed.
- Length: as long as it needs to be to be genuinely useful. Do NOT truncate, summarize, or cut off early. Give the complete picture.
- For learning goals (music, language, skills): use a clear historical or progressive structure — show the path from beginner to deeper understanding era by era or level by level.
- For each stage of a learning path: name the key figures, specific recommended works (album/book/track titles with artist names), and what to listen/look for. Don't just list names — explain what makes each one important.
- For event/venue questions: if you have real-time data (provided below), use it to give a complete, accurate picture of what's on, when, and how to get tickets. Include ALL the events from the search data.
- When listing music recommendations, always include BOTH the artist AND the album/track title. Format as: "**Artist Name** — *Album Title* (year)". Give 5–15 specific examples per section.

HOW TO USE THE PROFILE:
- City/location: use it to recommend specific local venues, schools, events, or communities in their area.
- Existing music taste: this is gold for music goals — use it to build a BRIDGE. If the user likes country and wants to learn jazz, point out that country and jazz share Blues roots, and which jazz artists/albums will feel most familiar to them.
- People in their life: mention them only when it's a natural, genuinely helpful suggestion (e.g. "you could invite [name] to a live show"). Never force it.
- Hobbies/interests: use them when they genuinely connect.

ONLY ask a clarifying question if the goal is so vague that you literally cannot write one useful sentence (e.g. "I want to get better" — better at what?). This is rare. If you have enough to go on, give the full response. You may end with ONE optional follow-up question if it would meaningfully deepen the personalization.

If there is conversation history, use it to refine, continue, or go deeper. Answer follow-up questions directly and thoroughly — treat this as a continuing conversation, not a fresh start.${webSearchContext ? `\n\nREAL-TIME DATA (use this to answer the question accurately):\n${webSearchContext}` : ""}

OUTPUT FORMAT — respond with valid JSON only, no markdown fences:
{
  "type": "steps",
  "content": "<full rich markdown response as a single JSON string — escape all quotes, use \\n for newlines, do not truncate>",
  "steps": ["<concise actionable item 1>", "<concise actionable item 2>", ...]
}

The "steps" array must contain 5–12 short, actionable phrases extracted from your response. These are used so the user can save individual items to their to-do list or calendar. Examples:
- "Listen to Kind of Blue by Miles Davis"
- "Watch 'Jazz' by Ken Burns on PBS"
- "Visit The Balcony Club on [specific night with event]"
- "Buy 'The History of Jazz' by Ted Gioia"
- "Download the Spotify Jazz playlist 'Blue Note Classics'"

For event listings: include one step per event (e.g. "See [Artist] at [Venue] on [Date]").

For a clarifying question, respond with:
{"type":"question","content":"<your single sharp question>","steps":[]}`;

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 16000,
    response_format: { type: "json_object" },
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

  let result: BreakdownResult;
  try {
    const parsed = JSON.parse(raw) as { type?: string; content?: string; steps?: string[] };
    if (parsed.type === "question") {
      result = { type: "question", content: parsed.content ?? raw };
    } else {
      result = {
        type: "steps",
        content: parsed.content ?? raw,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      };
    }
  } catch {
    // JSON parse failed — return raw text as content
    logger.warn({ rawLen: raw.length }, "[Goals] breakdown: JSON parse failed, returning raw as content");
    result = { type: "steps", content: raw, steps: [] };
  }

  // ── Auto-save goal and steps to DB ────────────────────────────────────────────
  if (options.autoSave && result.type === "steps" && result.steps.length > 0) {
    try {
      let savedGoalId = options.goalId;

      if (!savedGoalId) {
        const title = (options.goalTitle ?? goal).slice(0, 120);
        const newGoal = await createGoal(userName, title, null);
        savedGoalId = newGoal.id;
        logger.info({ goalId: savedGoalId, title }, "[Goals] Auto-saved goal from breakdown");
      } else {
        // Clear old steps before re-adding so follow-up conversations don't double-up
        await query(`DELETE FROM goal_steps WHERE goal_id = $1`, [savedGoalId]);
      }

      for (let i = 0; i < result.steps.length; i++) {
        await addStep(savedGoalId, userName, result.steps[i]!, i);
      }

      result = { type: "steps", content: result.content, steps: result.steps, goalId: savedGoalId };
    } catch (saveErr) {
      logger.warn({ saveErr }, "[Goals] Auto-save failed — returning result without goalId");
    }
  }

  return result;
}
