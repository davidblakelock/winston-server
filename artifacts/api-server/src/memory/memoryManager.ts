import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

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
}

// Generate a memory summary from conversation history using Claude
export async function generateMemorySummary(
  history: Array<{ role: string; content: string }>
): Promise<string | null> {
  if (history.length < 4) return null; // Too short to be worth remembering

  const formatted = history
    .map((m) => `${m.role === "user" ? "David" : "Emma"}: ${m.content}`)
    .join("\n\n");

  const prompt =
    `Review this conversation between David Blakelock and his AI companion Emma Peel. ` +
    `Write a memory note (80-120 words) capturing what's worth remembering for future conversations. ` +
    `Focus on:\n` +
    `- Physical health mentions (pain, energy, how activities like pickleball or running went)\n` +
    `- Family and relationship updates (Olivia, Susan, etc.)\n` +
    `- Plans David mentioned (things he said he'd do, try, call, or visit)\n` +
    `- Mood, feelings, or things weighing on him\n` +
    `- New experiences (restaurants tried, things done for the first time, events attended)\n` +
    `- Anything else a close friend would naturally follow up on next time\n\n` +
    `Write in concise third-person notes. Be specific with names and details. ` +
    `If the conversation was only about setting reminders, managing lists, or checking the weather ` +
    `with no personal substance worth remembering, return exactly the word: SKIP\n\n` +
    `Conversation:\n${formatted}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      response.content[0].type === "text" ? response.content[0].text.trim() : "";
    if (!text || text === "SKIP") return null;
    return text;
  } catch (err) {
    logger.warn({ err }, "Memory summary generation failed");
    return null;
  }
}

// Save or update today's memory with the new summary
export async function saveMemory(
  history: Array<{ role: string; content: string }>
): Promise<boolean> {
  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  const summary = await generateMemorySummary(history);
  if (!summary) return false;

  await query(
    `INSERT INTO conversation_memories (conversation_date, summary, message_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_date)
     DO UPDATE SET
       summary = EXCLUDED.summary,
       message_count = EXCLUDED.message_count,
       updated_at = NOW()
     RETURNING id`,
    [today, summary, history.length]
  );

  logger.info({ date: today, words: summary.split(" ").length }, "Memory saved");
  return true;
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
// Emma can and should ask natural follow-up questions about them.
// Memories older than 72 hours are included as background context only —
// Emma knows them but must NOT proactively ask follow-up questions about them
// unless David brings the topic up first. This prevents stale check-ins about
// events from last week (knee injuries, dinners, trips that are long past).
export function formatMemoriesForContext(memories: ConversationMemory[]): string {
  if (memories.length === 0) return "";

  const tz = "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });

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

  let result = `\n\n[Conversation Memory — what you remember from recent conversations with David]\n`;

  if (recent.length > 0) {
    result +=
      `[Recent — last 5 days — active follow-up appropriate for general topics]\n` +
      recent.join("\n\n") +
      `\n\nFor these recent memories, use them naturally — the way a close friend would. ` +
      `Reference them when relevant (e.g., "Did you end up calling Olivia?"). ` +
      `Don't recite them robotically or all at once. Let them inform how you engage, not dominate it.\n` +
      `HEALTH RULE: NEVER proactively ask about a health complaint, pain, injury, or soreness ` +
      `(knee pain, back pain, feeling sick, etc.) mentioned more than 5 days ago unless David brings it up himself. ` +
      `This includes the knee — do not ask "How's your knee?" unless David mentions it first today.\n`;
  }

  if (older.length > 0) {
    result +=
      `\n[Background context — older than 5 days — DO NOT use for proactive follow-up]\n` +
      older.join("\n\n") +
      `\n\nIMPORTANT: These older memories inform your understanding of David's life and history, ` +
      `but you must NOT proactively ask follow-up questions about them. ` +
      `Only reference older context if David brings up the topic himself ` +
      `or if it is directly relevant to what he is currently discussing. ` +
      `NEVER ask about old health complaints, injuries, or minor issues from this section.\n`;
  }

  return result;
}
