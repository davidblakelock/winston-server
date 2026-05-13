/**
 * Life Captures Manager
 *
 * Stores the user's own words (captured from morning thought prompt and evening
 * wind-down) and runs a Claude Haiku "dot-connector" to surface ONE concrete,
 * actionable suggestion per day that Winston can actually act on.
 *
 * Tables:
 *   life_captures   — id, user_name, captured_at, content, context, acted_on
 *   life_suggestions — id, user_name, suggestion, created_at, surfaced
 */

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";

const anthropic = new Anthropic();

// ── Table init ────────────────────────────────────────────────────────────────

const _tableInit = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS life_captures (
      id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name   text NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now(),
      content     text NOT NULL,
      context     text NOT NULL DEFAULT 'morning',
      acted_on    boolean NOT NULL DEFAULT false
    )
  `).catch((err) => logger.error({ err }, "[LifeCaptures] Table init failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS life_suggestions (
      id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name   text NOT NULL,
      suggestion  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      surfaced    boolean NOT NULL DEFAULT false
    )
  `).catch((err) => logger.error({ err }, "[LifeSuggestions] Table init failed"));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LifeCapture {
  id:          number;
  user_name:   string;
  captured_at: string;
  content:     string;
  context:     "morning" | "evening";
  acted_on:    boolean;
}

export interface LifeSuggestion {
  id:         number;
  user_name:  string;
  suggestion: string;
  created_at: string;
  surfaced:   boolean;
}

// ── Save a capture ────────────────────────────────────────────────────────────

/**
 * Store the user's exact words — never paraphrased or interpreted.
 * context: "morning" (from thought-of-day prompt) or "evening" (from wind-down).
 */
export async function saveLifeCapture(
  userName: string,
  content:  string,
  context:  "morning" | "evening" = "morning",
): Promise<LifeCapture> {
  await _tableInit;
  const { rows } = await query<LifeCapture>(
    `INSERT INTO life_captures (user_name, content, context)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userName, content.trim(), context]
  );
  logger.info({ userName, context, chars: content.length }, "[LifeCaptures] Capture saved");
  return rows[0]!;
}

// ── Query captures ────────────────────────────────────────────────────────────

export async function getRecentCaptures(
  userName: string,
  days      = 30,
): Promise<LifeCapture[]> {
  await _tableInit;
  const { rows } = await query<LifeCapture>(
    `SELECT * FROM life_captures
     WHERE user_name = $1
       AND captured_at >= now() - ($2 || ' days')::interval
     ORDER BY captured_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

export async function getAllCaptures(userName: string): Promise<LifeCapture[]> {
  await _tableInit;
  const { rows } = await query<LifeCapture>(
    `SELECT * FROM life_captures
     WHERE user_name = $1
     ORDER BY captured_at DESC`,
    [userName]
  );
  return rows;
}

// ── Dot-connector ─────────────────────────────────────────────────────────────

/**
 * After each capture, run Claude Haiku on the last 30 days of captures +
 * user's lists and profile. Ask one question: is there a concrete action
 * Winston could take right now? If yes, store it. If no, do nothing.
 *
 * Only ONE pending suggestion is kept at a time — a new one replaces the old.
 * Called fire-and-forget from chat.ts after saving a capture.
 */
export async function runDotConnector(userName: string): Promise<void> {
  await _tableInit;

  const captures = await getRecentCaptures(userName, 30);
  if (captures.length === 0) return;

  const profile = await getProfile(userName).catch(() => null);
  const city    = profile?.city ?? "Dallas";
  const raw     = (profile?.rawData ?? {}) as Record<string, unknown>;
  const interests = (raw["interests"] as string[] | undefined) ?? [];
  const firstName = (profile?.name ?? userName).split(" ")[0];

  // Fetch current list items (shopping + to-do)
  let listContext = "";
  try {
    const { rows: listRows } = await query<{ list_name: string; item_text: string }>(
      `SELECT list_name, item_text
       FROM list_items
       WHERE user_name = $1
         AND (completed IS NULL OR completed = false)
       ORDER BY list_name, created_at DESC
       LIMIT 40`,
      [userName]
    );
    if (listRows.length > 0) {
      const byList: Record<string, string[]> = {};
      for (const row of listRows) {
        (byList[row.list_name] ??= []).push(row.item_text);
      }
      listContext = `\nCurrent lists:\n` +
        Object.entries(byList).map(([name, items]) =>
          `  ${name}: ${items.slice(0, 10).join(", ")}`
        ).join("\n");
    }
  } catch { /* non-fatal */ }

  const captureLines = captures
    .slice(0, 30)
    .map((c) => {
      const date = new Date(c.captured_at).toLocaleDateString("en-US", {
        timeZone: "America/Chicago", month: "short", day: "numeric",
      });
      return `• [${date}, ${c.context}] ${c.content}`;
    })
    .join("\n");

  const prompt =
    `${firstName}'s personal reflections from the last 30 days:\n${captureLines}\n\n` +
    `Profile: lives in ${city}, interests include ${interests.slice(0, 6).join(", ") || "various things"}.` +
    listContext + `\n\n` +
    `One question: Is there anything in these reflections that Winston could take a concrete action on RIGHT NOW — ` +
    `specifically something involving: checking the calendar for an open week, making a reservation, ` +
    `researching travel options, or adding something to a list?\n\n` +
    `Rules:\n` +
    `• Only suggest something Winston can actually do — calendar gaps, reservations, travel research, list additions.\n` +
    `• No vague life advice ("you should prioritize rest", "consider reconnecting with family").\n` +
    `• No suggestions about things already in progress or recently acted on.\n` +
    `• The suggestion must be ONE natural conversational sentence Winston would say — under 25 words.\n` +
    `• Example format: "You mentioned wanting an exotic trip — you have a clear week in September. Want me to start looking at options?"\n\n` +
    `If there's a genuine actionable match: return ONLY the suggestion sentence.\n` +
    `If not: return exactly the word null.`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^null$/i.test(text)) {
      logger.info({ userName }, "[DotConnector] No actionable suggestion found");
      return;
    }

    // Store — replace any existing unsurfaced suggestion
    await query(
      `DELETE FROM life_suggestions WHERE user_name = $1 AND surfaced = false`,
      [userName]
    );
    await query(
      `INSERT INTO life_suggestions (user_name, suggestion) VALUES ($1, $2)`,
      [userName, text]
    );
    logger.info({ userName, suggestion: text.slice(0, 80) }, "[DotConnector] Suggestion stored");
  } catch (err) {
    logger.warn({ err, userName }, "[DotConnector] Claude call failed");
  }
}

// ── Pending suggestion ────────────────────────────────────────────────────────

/**
 * Returns the ONE pending (unsurfaced) suggestion, or null if none.
 * Call this in the morning briefing and evening check-in.
 */
export async function getPendingSuggestion(
  userName: string,
): Promise<LifeSuggestion | null> {
  await _tableInit;
  const { rows } = await query<LifeSuggestion>(
    `SELECT * FROM life_suggestions
     WHERE user_name = $1 AND surfaced = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [userName]
  );
  return rows[0] ?? null;
}

/**
 * Mark the suggestion as surfaced — it is NEVER shown again.
 * Call immediately after injecting it into a briefing or check-in.
 */
export async function markSuggestionSurfaced(
  userName:     string,
  suggestionId: number,
): Promise<void> {
  await _tableInit;
  await query(
    `UPDATE life_suggestions SET surfaced = true WHERE id = $1 AND user_name = $2`,
    [suggestionId, userName]
  );
  logger.info({ userName, suggestionId }, "[DotConnector] Suggestion marked surfaced");
}
