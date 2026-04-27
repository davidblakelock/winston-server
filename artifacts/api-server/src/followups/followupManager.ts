import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ConversationFollowup {
  id: number;
  topic: string;
  detail: string;
  followUpDate: string;
}

export async function ensureFollowupsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS conversation_followups (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      topic TEXT NOT NULL,
      detail TEXT NOT NULL,
      follow_up_date DATE NOT NULL,
      resolved BOOLEAN DEFAULT FALSE,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function extractAndSaveFollowups(
  history: Array<{ role: string; content: string }>,
  userName: string
): Promise<void> {
  const recent = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.substring(0, 400)}`)
    .join("\n");

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content:
            `Review this conversation and identify any time-sensitive items the user mentioned that are worth following up on in 2-3 days. Look for: upcoming events they're attending, family milestones (exams, interviews, appointments, competitions), things they're actively trying or waiting to hear back on, outcomes they're anticipating.\n\nReturn JSON only: {"followups": [{"topic": "short label", "detail": "natural follow-up question to ask later, first person as the AI companion", "days": 2}]}\nReturn {"followups": []} if nothing genuinely time-sensitive was mentioned. Do not extract vague or recurring habits.\n\nConversation:\n${recent}`,
        },
      ],
    });

    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;

    const parsed = JSON.parse(match[0]) as {
      followups: Array<{ topic: string; detail: string; days: number }>;
    };

    for (const f of parsed.followups) {
      const days = Math.min(Math.max(Number(f.days) || 2, 2), 3);
      await query(
        `INSERT INTO conversation_followups (user_name, topic, detail, follow_up_date)
         VALUES ($1, $2, $3, CURRENT_DATE + ($4 || ' days')::interval)
         RETURNING id`,
        [userName, f.topic.substring(0, 100), f.detail.substring(0, 300), String(days)]
      );
    }

    if (parsed.followups.length > 0) {
      logger.info(
        { userName, count: parsed.followups.length },
        "[Followups] Time-sensitive items saved"
      );
    }
  } catch (err) {
    logger.warn({ err }, "[Followups] Extraction failed");
  }
}

export async function getPendingPersonalFollowups(
  userName: string
): Promise<ConversationFollowup[]> {
  const { rows } = await query<{
    id: number;
    topic: string;
    detail: string;
    follow_up_date: string;
  }>(
    `SELECT id, topic, detail, follow_up_date::text
     FROM conversation_followups
     WHERE user_name = $1
       AND resolved = FALSE
       AND follow_up_date <= CURRENT_DATE
     ORDER BY follow_up_date ASC
     LIMIT 2`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    detail: r.detail,
    followUpDate: r.follow_up_date,
  }));
}

export async function markFollowupResolved(id: number): Promise<void> {
  await query(
    `UPDATE conversation_followups
     SET resolved = TRUE, resolved_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id]
  );
}

export function buildPersonalFollowupsBlock(
  followups: ConversationFollowup[]
): string {
  if (!followups.length) return "";
  const items = followups
    .map((f) => `• [id:${f.id}] ${f.detail}`)
    .join("\n");
  return (
    `\n\n[Personal Follow-Ups — from earlier conversations]\n` +
    `Weave ONE of these naturally into today's morning check-in if the conversation allows. ` +
    `After mentioning it, mark it done — do not repeat it tomorrow.\n${items}\n`
  );
}
