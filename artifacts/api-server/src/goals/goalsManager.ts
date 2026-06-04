import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { getProfile, buildSystemPromptFromProfile, buildProfileContext } from "../onboarding/onboardingManager.js";
import { getPeople } from "../people/peopleManager.js";
import { MODEL_HAIKU } from "../lib/models.js";

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
  let userCity = "";

  if (userProfile) {
    const displayName     = userProfile.name ?? userName;
    const city            = userProfile.city ?? "";
    if (city) userCity    = city;
    const hobbies         = userProfile.hobbies ?? [];
    const musicGenres     = userProfile.musicGenres ?? [];
    const sportsTeams     = userProfile.sportsTeams ?? "";
    const favoriteArtists = userProfile.favoriteArtists ?? [];

    const people = await getPeople(userName).catch(() => [] as Array<{ name: string; relationship: string; city?: string | null; details?: string | null }>);

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
    return { type: "question", content: "What's the single biggest obstacle you've hit on this before?", steps: [] };
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
  // Note: steps[] is always empty since the ---STEPS--- delimiter was removed;
  // the full response is in content (markdown). We still save the goal row and
  // return goalId so the native app can track conversations against a goal.
  if (options.autoSave && result.type === "steps") {
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

  // Build a summary of the user's goals to pass to Claude
  const goals = await getGoals(userName);
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
// Used by /api/goals/chat — conversational AI response without forced step structure.
// The caller is responsible for persisting the exchange to chat_messages.
export async function goalsFreeformChat(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  userName: string
): Promise<string> {
  const userProfile = await getProfile(userName).catch(() => null);
  const name = userProfile?.name ?? userName;
  const city = userProfile?.city ?? "";

  // Prepend basic profile context to the first user turn — same pattern as travel screen.
  // No system prompt; GPT-4o responds naturally.
  const contextPrefix = city
    ? `[User: ${name}, based in ${city}]\n`
    : `[User: ${name}]\n`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...conversationHistory,
    { role: "user", content: contextPrefix + message },
  ];

  const response = await openai.chat.completions.create({
    model: MODEL_GPT4O,
    max_tokens: 2048,
    messages,
  });

  const reply = response.choices[0]?.message?.content?.trim() ?? "";
  if (!reply) {
    logger.warn({ userName }, "[Goals] goalsFreeformChat returned empty response");
    return "I didn't quite catch that — could you say a bit more?";
  }
  return reply;
}
