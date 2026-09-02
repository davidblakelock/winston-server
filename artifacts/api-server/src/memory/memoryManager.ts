import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { addRestaurant } from "../profile/profileManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { getProfile } from "../onboarding/onboardingManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ConversationMemory {
  id: number;
  conversationDate: string;
  summary: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function ensureMemoryTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS conversation_memories (
      id serial PRIMARY KEY,
      conversation_date date NOT NULL UNIQUE,
      summary text NOT NULL,
      message_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // The UNIQUE inline above only ever applies the first time this statement
  // actually creates the table — CREATE TABLE IF NOT EXISTS is a full no-op
  // once the table exists, constraint included, regardless of whether that
  // existing table matches this definition. Confirmed live: the deployed
  // table had no unique constraint on conversation_date at all (only the
  // id primary key), meaning it predates this column definition being
  // written — every saveMemory() call has been failing on ON CONFLICT
  // (conversation_date) ever since, silently (saveMemory swallows the error
  // and just returns/logs, never surfaced as a user-visible failure). A
  // unique index is added separately here, idempotently, since Postgres
  // has no ADD CONSTRAINT IF NOT EXISTS — ON CONFLICT works against a
  // unique index the same as an inline constraint.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_memories_date_uidx
      ON conversation_memories (conversation_date)
  `).catch((err) => logger.warn({ err }, "[MemoryManager] conversation_memories unique index init failed"));
}

// ── Durable facts extracted from a conversation, alongside the narrative summary ──
export interface ExtractedFacts {
  hobbies?: string[];
  favoriteArtists?: string[];
  restaurants?: string[];
  sportsTeams?: string[];
}

interface MemoryAnalysis {
  summary: string | null;
  facts: ExtractedFacts | null;
  chatFact: string | null;
}

// Generate a memory summary AND extract durable profile facts from conversation
// history in a single Claude call — no separate pass, no regex pre-filter.
export async function generateMemorySummary(
  history: Array<{ role: string; content: string }>,
  companionName?: string | null,
  userName?: string | null
): Promise<MemoryAnalysis> {
  if (history.length < 4) return { summary: null, facts: null, chatFact: null }; // Too short to be worth remembering

  const companion = companionName ?? "the AI companion";
  const user = userName ?? "the user";

  const formatted = history
    .map((m) => `${m.role === "user" ? user : companion}: ${m.content}`)
    .join("\n\n");

  const prompt =
    `Review this conversation between ${user} and their AI companion ${companion}. ` +
    `IMPORTANT: only extract facts from what ${user} themselves actually said, never from ${companion}'s ` +
    `own replies — even a confident, detailed ${companion} statement is not evidence of anything real. ` +
    `Confirmed live: a one-off speculative line in a ${companion} reply ("developing an interest in wine, ` +
    `with potential future travel to Europe" — ${user} never said "Europe") got extracted as a fact here, ` +
    `which then appeared in a future ${companion} reply as established context, which got extracted again, ` +
    `more confidently each time, escalating over a week into a fully invented "actively researching Burgundy ` +
    `ahead of an upcoming Europe trip" storyline with zero basis in anything ${user} ever said. ${companion}'s ` +
    `own past turns (including generated content like a Morning Run Down or Evening Wind Down message) must ` +
    `be read only as context for understanding ${user}'s turns, never mined as a source of facts about ${user}.\n\n` +
    `Write a memory note capturing what's worth remembering for future conversations. ` +
    `Focus on:\n` +
    `- Physical health mentions (pain, energy, how physical activities or hobbies went)\n` +
    `- Family and relationship updates (people they mentioned by name)\n` +
    `- Plans ${user} mentioned (things they said they'd do, try, call, or visit)\n` +
    `- Mood, feelings, or things weighing on them\n` +
    `- New experiences (restaurants tried, things done for the first time, events attended)\n` +
    `- Anything else a close friend would naturally follow up on next time\n\n` +
    `Write the memory note in concise third-person notes. Be specific with names and details. ` +
    `If the conversation was only about setting reminders, managing lists, or checking the weather ` +
    `with no personal substance worth remembering, use the literal string "SKIP" as the summary.\n\n` +
    `Also identify any DURABLE facts ${user} mentioned about themselves in this conversation — lasting ` +
    `preferences ${user} actually stated, not one-off events, and not anything only ${companion} said. Use ` +
    `the same judgment as the SKIP rule above: only include something if it's genuinely durable.\n` +
    `- hobbies: any new hobby or interest mentioned\n` +
    `- favoriteArtists: any new artist or musician mentioned as one they like\n` +
    `- restaurants: any new restaurant mentioned as a favorite or one they enjoyed\n` +
    `- sportsTeams: any new sports team mentioned as one they follow\n\n` +
    `Also, separately: did ${user} themselves reveal a broader durable interest or context in THIS ` +
    `conversation — something ${user} actually said, not something ${companion} said or already assumed — ` +
    `that doesn't fit any of the structured fields above, and is NOT a task, plan, or intention (those ` +
    `already have their own destinations — a reminder, a to-do, a goal — and must never be duplicated here)? ` +
    `This is for something that would help a future conversation feel like it remembers ${user} — an ` +
    `exploration of a topic, a stated curiosity, general context about their life — not an event that ` +
    `already happened (that's the summary above) and not something they intend to do (that's a task, ` +
    `elsewhere). Do not restate, rephrase, or "confirm" a prior chatFact just because it's mentioned again ` +
    `by ${companion} somewhere in this history — only a genuinely new statement from ${user} counts. Write ` +
    `it as ONE plain third-person sentence, e.g. "${user} explored a new music genre and some local venues." ` +
    `Use null if nothing like this came up — most conversations won't have one; don't force it.\n\n` +
    `Return ONLY valid JSON in exactly this shape — no explanation, no markdown code fences:\n` +
    `{\n` +
    `  "summary": "<the memory note, or the literal string SKIP>",\n` +
    `  "facts": {\n` +
    `    "hobbies": ["..."],\n` +
    `    "favoriteArtists": ["..."],\n` +
    `    "restaurants": ["..."],\n` +
    `    "sportsTeams": ["..."]\n` +
    `  },\n` +
    `  "chatFact": "<one durable-context sentence, or null>"\n` +
    `}\n` +
    `Omit any key/array that has nothing new. Omit "facts" entirely if nothing durable came up. Use null ` +
    `for "chatFact" if nothing like that came up.\n\n` +
    `Conversation:\n${formatted}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400, // raised from 250 to fit the facts JSON alongside the summary
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      response.content[0].type === "text" ? response.content[0].text.trim() : "";
    if (!text) return { summary: null, facts: null, chatFact: null };

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { summary: null, facts: null, chatFact: null };

    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; facts?: ExtractedFacts; chatFact?: string | null };
    const summary = parsed.summary && parsed.summary !== "SKIP" ? parsed.summary : null;
    const facts = parsed.facts && Object.keys(parsed.facts).length > 0 ? parsed.facts : null;
    const chatFact = parsed.chatFact && parsed.chatFact.trim().length > 0 ? parsed.chatFact.trim() : null;

    return { summary, facts, chatFact };
  } catch (err) {
    logger.warn({ err }, "Memory summary generation failed");
    return { summary: null, facts: null, chatFact: null };
  }
}

// .catch() added after a confirmed live crash caused by the same unguarded-IIFE
// pattern in listManager.ts (see its comment) — an uncaught rejection here at
// module-load time would crash the whole Node process, not just this table's init.
const _chatFactsTableInit = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS chat_facts (
      id         serial PRIMARY KEY,
      user_name  text NOT NULL,
      content    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS chat_facts_user_created_idx ON chat_facts (user_name, created_at DESC)`);
})().catch((err) => logger.error({ err }, "[MemoryManager] chat_facts table init failed"));

export interface ChatFact {
  id:         number;
  user_name:  string;
  content:    string;
  created_at: string;
}

async function saveChatFact(userName: string, content: string): Promise<void> {
  await _chatFactsTableInit;
  await query(`INSERT INTO chat_facts (user_name, content) VALUES ($1, $2)`, [userName, content]);
  logger.info({ userName, chars: content.length }, "[Memory] Chat fact saved");
}

// Read side — wrapped by memorySourceAdapters.ts's chatFactAdapter.
export async function getRecentChatFacts(userName: string, days = 30): Promise<ChatFact[]> {
  await _chatFactsTableInit;
  const { rows } = await query<ChatFact>(
    `SELECT * FROM chat_facts
     WHERE user_name = $1 AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

const CHAT_FACT_RETENTION_DAYS = 180; // generous — these feed durable-
// context reasoning, not a UI a person manages directly, so err toward
// keeping them rather than aggressive cleanup. No confirm step: nothing
// ever displays these to a person for review, so there's nothing to ask
// permission for — this is housekeeping, not a user-facing deletion.

export async function pruneOldChatFacts(): Promise<number> {
  await _chatFactsTableInit;
  const { rows } = await query<{ id: number }>(
    `DELETE FROM chat_facts WHERE created_at < now() - interval '${CHAT_FACT_RETENTION_DAYS} days' RETURNING id`
  );
  if (rows.length > 0) {
    logger.info({ count: rows.length }, "[Memory] Pruned old chat_facts");
  }
  return rows.length;
}

// Save or update today's memory with the new summary, and save any durable
// profile facts extracted in the same pass. Fact-saving is independent of
// whether the narrative summary was worth keeping (SKIP) — a conversation can
// mention a new hobby without having a memorable narrative, or vice versa.
export async function saveMemory(
  history: Array<{ role: string; content: string }>,
  companionName?: string | null,
  userName?: string | null
): Promise<boolean> {
  const { timezone: tz } = userName ? await getUserLocationContext(userName) : { timezone: "UTC" };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  const { summary, facts, chatFact } = await generateMemorySummary(history, companionName, userName);

  if (facts && userName) {
    await saveExtractedFacts(facts, userName).catch((err) => {
      logger.warn({ err, userName }, "Failed to save extracted profile facts (non-fatal)");
    });
  }

  // Independent of whether the narrative summary was worth keeping (SKIP) —
  // same reasoning as facts above: a conversation can reveal durable context
  // without having a memorable narrative, or vice versa.
  if (chatFact && userName) {
    await saveChatFact(userName, chatFact).catch((err) => {
      logger.warn({ err, userName }, "Failed to save extracted chat fact (non-fatal)");
    });
  }

  if (!summary) return false;

  await query(
    `INSERT INTO conversation_memories (conversation_date, summary, message_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_date)
     DO UPDATE SET
       summary = EXCLUDED.summary,
       message_count = EXCLUDED.message_count,
       updated_at = NOW()
     RETURNING conversation_date`,
    [today, summary, history.length]
  );

  logger.info({ date: today, words: summary.split(" ").length }, "Memory saved");
  return true;
}

// ── Save durable facts into their real structured homes ───────────────────────
// hobbies / favoriteArtists: jsonb array columns on user_profiles — merge new,
//   non-duplicate entries into the existing array.
// sportsTeams: a single comma-separated text column on user_profiles (NOT an
//   array) — append new teams to the existing string.
// restaurants: NOT a user_profiles column — the dedicated restaurants table
//   (routes/lists.ts / profileManager.ts's addRestaurant) is the real live
//   home for restaurants, so route through the existing addRestaurant(),
//   which already handles dedup + URL lookup.
async function saveExtractedFacts(facts: ExtractedFacts, userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  if (!profile) return;

  await mergeJsonbArrayFact(userName, "hobbies", profile.hobbies, facts.hobbies);
  await mergeJsonbArrayFact(userName, "favorite_artists", profile.favoriteArtists, facts.favoriteArtists);

  if (facts.sportsTeams?.length) {
    await mergeSportsTeams(userName, profile.sportsTeams, facts.sportsTeams);
  }

  if (facts.restaurants?.length) {
    for (const name of facts.restaurants) {
      const cleanName = name?.trim();
      if (!cleanName) continue;
      await addRestaurant(cleanName, null, userName).catch((err) => {
        logger.warn({ err, userName, name: cleanName }, "Failed to save extracted restaurant fact (non-fatal)");
      });
    }
  }
}

// Write-through for a single accepted cross-domain profile-fact suggestion
// (Phase 4b). Reuses the exact same merge/dedup logic saveExtractedFacts
// already uses for chat's own extraction — this is not a second, divergent
// write path, just a second caller of the same one.
export async function applyProfileFact(
  userName: string,
  category: keyof ExtractedFacts,
  value: string
): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  if (!profile) return;

  switch (category) {
    case "hobbies":
      await mergeJsonbArrayFact(userName, "hobbies", profile.hobbies, [value]);
      break;
    case "favoriteArtists":
      await mergeJsonbArrayFact(userName, "favorite_artists", profile.favoriteArtists, [value]);
      break;
    case "sportsTeams":
      await mergeSportsTeams(userName, profile.sportsTeams, [value]);
      break;
    case "restaurants": {
      const cleanName = value?.trim();
      if (cleanName) {
        await addRestaurant(cleanName, null, userName).catch((err) => {
          logger.warn({ err, userName, name: cleanName }, "Failed to apply accepted restaurant profile fact (non-fatal)");
        });
      }
      break;
    }
  }
}

async function mergeJsonbArrayFact(
  userName: string,
  column: "hobbies" | "favorite_artists",
  existing: string[],
  newFacts: string[] | undefined
): Promise<void> {
  if (!newFacts?.length) return;

  const existingLower = new Set(existing.map((v) => v.toLowerCase().trim()));
  const additions = newFacts
    .map((v) => v?.trim())
    .filter((v): v is string => !!v && !existingLower.has(v.toLowerCase()));
  if (additions.length === 0) return;

  const merged = [...existing, ...additions];
  await query(
    `UPDATE user_profiles SET ${column} = $1::jsonb WHERE user_name = $2`,
    [JSON.stringify(merged), userName]
  );
  logger.info({ userName, column, additions }, "[Memory] Extracted fact merged into user_profiles");
}

async function mergeSportsTeams(
  userName: string,
  existing: string | null,
  newTeams: string[]
): Promise<void> {
  const existingStr = existing ?? "";
  const existingLower = existingStr.toLowerCase();
  const additions = newTeams
    .map((t) => t?.trim())
    .filter((t): t is string => !!t && !existingLower.includes(t.toLowerCase()));
  if (additions.length === 0) return;

  const merged = [existingStr, ...additions].filter(Boolean).join(", ");
  await query(
    `UPDATE user_profiles SET sports_teams = $1 WHERE user_name = $2`,
    [merged, userName]
  );
  logger.info({ userName, additions }, "[Memory] Extracted sports team merged into user_profiles");
}

// Retrieve memories from the last N days
export async function getRecentMemories(days = 7): Promise<ConversationMemory[]> {
  const { rows } = await query<{
    id: number;
    conversation_date: string;
    summary: string;
    message_count: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, conversation_date::text, summary, message_count, created_at, updated_at
     FROM conversation_memories
     WHERE conversation_date >= CURRENT_DATE - $1::interval
     ORDER BY conversation_date DESC`,
    [`${days} days`]
  );

  return rows.map((r) => ({
    id: r.id,
    conversationDate: r.conversation_date,
    summary: r.summary,
    messageCount: r.message_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// Format memories for injection into the system prompt.
// Memories from the last 72 hours (3 days) are marked as active follow-up context —
// the companion can and should ask natural follow-up questions about them.
// Memories older than 72 hours are included as background context only —
// the companion knows them but must NOT proactively ask follow-up questions about them
// unless David brings the topic up first. This prevents stale check-ins about
// events from last week (knee injuries, dinners, trips that are long past).
export function formatMemoriesForContext(memories: ConversationMemory[]): string {
  if (memories.length === 0) return "";

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });

  const FOLLOWUP_CUTOFF_DAYS = 5; // 120 hours

  const recent: string[] = [];  // ≤5 days — active follow-up allowed
  const older: string[] = [];   // >5 days — background context only

  for (const m of memories) {
    const date = new Date(`${m.conversationDate}T12:00:00`);
    const diffDays = Math.round(
      (new Date(`${today}T12:00:00`).getTime() - date.getTime()) /
        (1000 * 60 * 60 * 24)
    );

    let label: string;
    if (diffDays === 0) label = "Earlier today";
    else if (diffDays === 1) label = "Yesterday";
    else if (diffDays <= 6) {
      label = date.toLocaleDateString("en-US", { weekday: "long" });
    } else {
      label = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    }

    const line = `${label}: ${m.summary}`;

    if (diffDays <= FOLLOWUP_CUTOFF_DAYS) {
      recent.push(line);
    } else {
      older.push(line);
    }
  }

  let result = `\n\n[Conversation Memory — what you remember from recent conversations with the user]\n`;

  if (recent.length > 0) {
    result +=
      `[Recent — last 5 days — active follow-up appropriate for general topics]\n` +
      recent.join("\n\n") +
      `\n\nFor these recent memories, use them naturally — the way a close friend would. ` +
      `Reference them when relevant (e.g., "Did you end up making that call you mentioned?"). ` +
      `Don't recite them robotically or all at once. Let them inform how you engage, not dominate it.\n` +
      `HEALTH RULE: NEVER proactively ask about a health complaint, pain, injury, or soreness ` +
      `(knee pain, back pain, feeling sick, etc.) mentioned more than 5 days ago unless the user brings it up themselves. ` +
      `Do not ask follow-up health questions unless the user mentions it first today.\n`;
  }

  if (older.length > 0) {
    result +=
      `\n[Background context — older than 5 days — DO NOT use for proactive follow-up]\n` +
      older.join("\n\n") +
      `\n\nIMPORTANT: These older memories inform your understanding of the user's life and history, ` +
      `but you must NOT proactively ask follow-up questions about them. ` +
      `Only reference older context if the user brings up the topic themselves ` +
      `or if it is directly relevant to what they are currently discussing. ` +
      `NEVER ask about old health complaints, injuries, or minor issues from this section.\n`;
  }

  return result;
}

// ── Layer 2: Transcript search ────────────────────────────────────────────────
// Searches chat_messages for past conversations matching a keyword.
// Returns matching excerpts — never auto-loaded into Claude's context.
// Only surfaced when David explicitly asks "what did I say about X".

export interface TranscriptHit {
  date: string;
  role: string;
  excerpt: string;
}

export async function searchTranscripts(
  userName: string,
  searchQuery: string,
  days = 90
): Promise<TranscriptHit[]> {
  if (!searchQuery || searchQuery.length < 2) return [];

  try {
    const { rows } = await query<{
      role: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE user_name = $1
         AND created_at >= NOW() - ($2 || ' days')::interval
         AND content ILIKE '%' || $3 || '%'
       ORDER BY created_at DESC
       LIMIT 8`,
      [userName, days.toString(), searchQuery]
    );

    return rows.map((r) => ({
      date: r.created_at.toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
      }),
      role: r.role,
      excerpt: r.content.slice(0, 350) + (r.content.length > 350 ? "…" : ""),
    }));
  } catch (err) {
    logger.warn({ err }, "Transcript search failed");
    return [];
  }
}
