import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type RecommendationType = "restaurant" | "show" | "place" | "activity" | "book" | "other";

export interface Recommendation {
  id: number;
  type: RecommendationType;
  name: string;
  context: string | null;
  dateRecommended: string;
  followedUp: boolean;
  followedUpDate: string | null;
}

export async function getPendingFollowUps(minDays = 2, maxDays = 21, userName = NATIVE_STORED_NAME): Promise<Recommendation[]> {
  const { rows } = await query<{
    id: number; type: string; name: string; context: string | null;
    date_recommended: string; followed_up: boolean; followed_up_date: string | null;
  }>(
    `SELECT id, type, name, context, date_recommended, followed_up, followed_up_date
     FROM recommendations
     WHERE user_name = $1
       AND followed_up = false
       AND dismissed = false
       AND date_recommended >= CURRENT_DATE - INTERVAL '${maxDays} days'
       AND date_recommended <= CURRENT_DATE - INTERVAL '${minDays} days'
     ORDER BY date_recommended ASC
     LIMIT 3`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type as RecommendationType,
    name: r.name,
    context: r.context,
    dateRecommended: r.date_recommended,
    followedUp: r.followed_up,
    followedUpDate: r.followed_up_date,
  }));
}

export async function markFollowedUp(id: number): Promise<void> {
  await query(
    `UPDATE recommendations SET followed_up = true, followed_up_date = CURRENT_DATE WHERE id = $1 RETURNING id`,
    [id]
  );
}

export async function dismissRecommendation(id: number): Promise<void> {
  await query(`UPDATE recommendations SET dismissed = true WHERE id = $1 RETURNING id`, [id]);
}

export async function saveRecommendations(recs: Array<{ type: RecommendationType; name: string; context: string }>, userName = NATIVE_STORED_NAME): Promise<void> {
  if (!recs.length) return;
  for (const r of recs) {
    await query(
      `INSERT INTO recommendations (user_name, type, name, context)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [userName, r.type, r.name, r.context]
    ).catch(() => {});
  }
}

// ── Extract recommendations from Emma's response ──────────────────────────────
export async function extractRecommendationsFromResponse(
  response: string
): Promise<Array<{ type: RecommendationType; name: string; context: string }>> {
  // Quick pre-check — only call Claude if response looks like it has recommendations
  if (!/(recommend|try|check out|you.d love|worth trying|you should|suggest|have you tried|perfect for|great for|you.ll love)/i.test(response)) {
    return [];
  }

  try {
    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: `Extract specific recommendations from this assistant response. Return ONLY valid JSON array.

Each item:
- type: "restaurant" | "show" | "place" | "activity" | "book" | "other"
- name: string (specific name of the thing recommended)
- context: string (brief reason / what Emma said about it, max 100 chars)

Return [] if no specific named recommendations are made.
Only extract NAMED specific things, not generic advice.`,
      messages: [{ role: "user", content: response }],
    });

    const text = result.content[0].type === "text" ? result.content[0].text.trim() : "[]";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as Array<{ type: string; name: string; context: string }>;
    return parsed.filter((r) => r.name && r.type).map((r) => ({
      type: r.type as RecommendationType,
      name: r.name,
      context: r.context ?? "",
    }));
  } catch (err) {
    logger.warn({ err }, "Recommendation extraction failed");
    return [];
  }
}

// ── Format follow-up context for Emma ─────────────────────────────────────────
export function buildRecommendationFollowUpBlock(recs: Recommendation[]): string {
  if (!recs.length) return "";

  const items = recs.map((r) => {
    const daysAgo = daysSince(r.dateRecommended);
    const when = daysAgo === 1 ? "yesterday" : daysAgo === 2 ? "two days ago" : `${daysAgo} days ago`;
    return `• You recommended "${r.name}" (${r.type}) ${when}${r.context ? " — " + r.context : ""}`;
  }).join("\n");

  return `\n\n[Your Recent Recommendations — Pending Follow-Up]\n${items}\n\nNaturally and warmly follow up on ONE of these at an appropriate moment — e.g. "Did you ever make it to that Italian place I mentioned?" Only do this if it fits conversationally. Don't force it if the conversation is about something else. Mark the follow-up IDs: ${recs.map((r) => r.id).join(", ")}`;
}

function daysSince(dateStr: string): number {
  const now = new Date();
  const date = new Date(dateStr + "T12:00:00");
  return Math.round((now.getTime() - date.getTime()) / 86400000);
}

// ── Detect follow-up acknowledgment in user message ──────────────────────────
export function detectFollowUpAcknowledgment(message: string): boolean {
  return /\b(i (did|went|tried|saw|watched|visited|checked\s+out|made\s+it)|never (made it|went|tried)|haven.t (been|tried|seen)|finally (went|tried|saw|watched)|ended\s+up\s+(going|trying)|we went|i.ve (been|tried|seen|watched)|haven.t\s+(had\s+a\s+chance|gotten\s+around))\b/i.test(message);
}
