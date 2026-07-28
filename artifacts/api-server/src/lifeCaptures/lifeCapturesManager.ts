/**
 * Life Captures Manager
 *
 * Stores the user's own words from morning intention and evening reflection
 * prompts. Runs pattern observation (Socratic mirror), weekly gift, and
 * annual letter generation.
 *
 * Tables:
 *   life_captures      — id, user_name, captured_at, content, context, acted_on
 *   life_suggestions   — id, user_name, suggestion, created_at, surfaced  (dot-connector / actionable)
 *   life_observations  — id, user_name, observation, created_at, surfaced (Socratic mirror patterns)
 *   life_annual_letters — id, user_name, year, letter, generated_at
 */

import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
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
      acted_on    boolean NOT NULL DEFAULT false,
      stoic_phase integer
    )
  `).catch((err) => logger.error({ err }, "[LifeCaptures] Table init failed"));
  // Idempotent — the table above already existed in production before this column.
  await query(`ALTER TABLE life_captures ADD COLUMN IF NOT EXISTS stoic_phase integer`)
    .catch((err) => logger.error({ err }, "[LifeCaptures] stoic_phase column migration failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS life_suggestions (
      id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name   text NOT NULL,
      suggestion  text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      surfaced    boolean NOT NULL DEFAULT false
    )
  `).catch((err) => logger.error({ err }, "[LifeSuggestions] Table init failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS life_observations (
      id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name    text NOT NULL,
      observation  text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      surfaced     boolean NOT NULL DEFAULT false
    )
  `).catch((err) => logger.error({ err }, "[LifeObservations] Table init failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS life_annual_letters (
      id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name    text NOT NULL,
      year         integer NOT NULL,
      letter       text NOT NULL,
      generated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_name, year)
    )
  `).catch((err) => logger.error({ err }, "[LifeAnnualLetters] Table init failed"));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LifeCapture {
  id:          number;
  user_name:   string;
  captured_at: string;
  content:     string;
  context:     "morning" | "evening" | "goal" | "observation";
  acted_on:    boolean;
  stoic_phase: number | null;
}

export interface LifeSuggestion {
  id:         number;
  user_name:  string;
  suggestion: string;
  created_at: string;
  surfaced:   boolean;
}

export interface LifeObservation {
  id:          number;
  user_name:   string;
  observation: string;
  created_at:  string;
  surfaced:    boolean;
}

export interface LifeAnnualLetter {
  id:           number;
  user_name:    string;
  year:         number;
  letter:       string;
  generated_at: string;
}

// ── Save a capture ────────────────────────────────────────────────────────────

/**
 * Store the user's exact words — never paraphrased or interpreted.
 * context: "morning" | "evening" | "goal" | "observation"
 * Returns null if an identical capture for this user was already stored in the
 * last 60 seconds — guards against duplicate deliveries (client retries, races
 * upstream) since this is the only write path into life_captures, including
 * the direct POST /api/life route.
 */
export async function saveLifeCapture(
  userName:   string,
  content:    string,
  context:    "morning" | "evening" | "goal" | "observation" = "morning",
  stoicPhase: number | null = null,
): Promise<LifeCapture | null> {
  await _tableInit;
  const trimmed = content.trim();

  const { rows: dupe } = await query<{ id: number }>(
    `SELECT id FROM life_captures
     WHERE user_name = $1 AND content = $2
       AND captured_at >= now() - interval '60 seconds'`,
    [userName, trimmed]
  );
  if (dupe.length > 0) {
    logger.info({ userName }, "[LifeCaptures] Duplicate capture within 60s window — skipped");
    return null;
  }

  const { rows } = await query<LifeCapture>(
    `INSERT INTO life_captures (user_name, content, context, stoic_phase)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userName, trimmed, context, stoicPhase]
  );
  logger.info({ userName, context, chars: content.length, stoicPhase }, "[LifeCaptures] Capture saved");
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

// ── Dot-connector (actionable suggestions) ───────────────────────────────────

/**
 * After each capture, run Claude Haiku on the last 30 days of captures.
 * Ask: is there a concrete action Winston could take right now?
 * If yes, store it as a pending suggestion. Only ONE kept at a time.
 * Called fire-and-forget from chat.ts after saving a capture.
 */
export async function runDotConnector(userName: string): Promise<void> {
  await _tableInit;

  const captures = await getRecentCaptures(userName, 30);
  if (captures.length < 4) return; // need enough data for meaningful patterns

  // Rate-limit: at most once every 3 days (same as Socratic Mirror)
  const { rows: dcRateRows } = await query<{ id: number }>(
    `SELECT id FROM life_suggestions WHERE user_name = $1 AND created_at >= now() - interval '3 days'`,
    [userName]
  );
  if (dcRateRows.length > 0) return;

  const profile = await getProfile(userName).catch(() => null);
  const { timezone: lcTz, city: lcCity } = await getUserLocationContext(userName);
  const city    = profile?.city ?? lcCity ?? "";
  const raw     = (profile?.rawData ?? {}) as Record<string, unknown>;
  const interests = (raw["interests"] as string[] | undefined) ?? [];
  const firstName = (profile?.name ?? userName).split(" ")[0];

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
        timeZone: lcTz, month: "short", day: "numeric",
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

// ── Pending suggestion (dot-connector) ───────────────────────────────────────

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

// ── Socratic mirror — pattern observation ────────────────────────────────────

/**
 * After each capture, look for genuine behavioural patterns across the last
 * 30 days. If a real pattern exists, store ONE observation. Never manufacture.
 * Called fire-and-forget. Stored in life_observations, surfaced once.
 */
export async function runPatternObservation(userName: string): Promise<void> {
  await _tableInit;

  const captures = await getRecentCaptures(userName, 30);
  if (captures.length < 4) return; // need enough data to find patterns

  const profile   = await getProfile(userName).catch(() => null);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  // Check if we already stored an observation in the last 3 days (rate-limit)
  const { rows: recent } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM life_observations
     WHERE user_name = $1 AND created_at >= now() - interval '3 days'`,
    [userName]
  );
  if (parseInt(recent[0]?.count ?? "0", 10) > 0) {
    logger.info({ userName }, "[PatternObservation] Rate-limited — observation already stored recently");
    return;
  }

  const captureLines = captures
    .slice(0, 30)
    .map((c) => {
      const date = new Date(c.captured_at).toLocaleDateString("en-US", {
        timeZone: profile?.timezone ?? "UTC", month: "short", day: "numeric",
      });
      return `• [${date}, ${c.context}] ${c.content}`;
    })
    .join("\n");

  const prompt =
    `${firstName}'s personal reflections and intentions from the last 30 days:\n${captureLines}\n\n` +
    `Read these carefully. You are a wise, observant friend — not a therapist, not a coach. ` +
    `Look for a genuine recurring pattern: something ${firstName} has mentioned 3 or more times, ` +
    `or a clear trend in their energy, mood, goals, or relationships.\n\n` +
    `STRICT RULES:\n` +
    `• Only surface a pattern that is genuinely there in the text above — never invent or interpolate.\n` +
    `• It must be specific — not "you've been busy" or "you seem stressed".\n` +
    `• It must be delivered as one warm, curious conversational observation — under 35 words.\n` +
    `• Frame it as a question or gentle observation, never a diagnosis or advice.\n` +
    `• Examples of the RIGHT tone:\n` +
    `  - "You've mentioned feeling stuck three times this month — always after a heavy week. What would unstuck look like for you?"\n` +
    `  - "You've said you feel most alive after time outdoors. You have a clear afternoon today."\n` +
    `  - "You've brought up calling Olivia three times and haven't yet. What's in the way?"\n` +
    `• If anything concerning emerges — anxiety, persistent sadness, isolation — acknowledge it warmly and gently suggest talking to someone. Do NOT diagnose.\n` +
    `• If there is no genuine pattern: return exactly the word null.\n\n` +
    `If a real pattern exists: return ONLY the observation sentence.\n` +
    `If not: return exactly the word null.`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^null$/i.test(text)) {
      logger.info({ userName }, "[PatternObservation] No genuine pattern found");
      return;
    }

    // Replace any existing unsurfaced observation
    await query(
      `DELETE FROM life_observations WHERE user_name = $1 AND surfaced = false`,
      [userName]
    );
    await query(
      `INSERT INTO life_observations (user_name, observation) VALUES ($1, $2)`,
      [userName, text]
    );
    logger.info({ userName, obs: text.slice(0, 80) }, "[PatternObservation] Observation stored");
  } catch (err) {
    logger.warn({ err, userName }, "[PatternObservation] Claude call failed");
  }
}

export async function getPendingObservation(
  userName: string,
): Promise<LifeObservation | null> {
  await _tableInit;
  const { rows } = await query<LifeObservation>(
    `SELECT * FROM life_observations
     WHERE user_name = $1 AND surfaced = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [userName]
  );
  return rows[0] ?? null;
}

export async function markObservationSurfaced(
  userName:      string,
  observationId: number,
): Promise<void> {
  await _tableInit;
  await query(
    `UPDATE life_observations SET surfaced = true WHERE id = $1 AND user_name = $2`,
    [observationId, userName]
  );
  logger.info({ userName, observationId }, "[PatternObservation] Observation marked surfaced");
}

// ── Weekly gift (Sunday morning) ─────────────────────────────────────────────

/**
 * Reads the last 7 days of life_captures and generates one warm, personal
 * paragraph — not a summary, a genuine observation from a thoughtful friend.
 * Called during Sunday morning briefing pre-generation. Returns null if < 2
 * captures exist (not enough to say anything meaningful).
 */
export async function getWeeklyGift(userName: string): Promise<string | null> {
  await _tableInit;

  const captures = await getRecentCaptures(userName, 7);
  if (captures.length < 2) {
    logger.info({ userName }, "[WeeklyGift] Fewer than 2 captures — skipping");
    return null;
  }

  const profile   = await getProfile(userName).catch(() => null);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const captureLines = captures
    .map((c) => {
      const date = new Date(c.captured_at).toLocaleDateString("en-US", {
        timeZone: profile?.timezone ?? "UTC", weekday: "short", month: "short", day: "numeric",
      });
      return `• [${date}, ${c.context}] ${c.content}`;
    })
    .join("\n");

  const prompt =
    `${firstName}'s reflections and intentions from the past 7 days:\n${captureLines}\n\n` +
    `You are a wise, warm friend who has been listening all week. Write ONE paragraph — ` +
    `3–5 sentences — that offers a genuine insight from what you noticed. ` +
    `This is not a summary. This is not a report. It is a gift — the kind of thing a ` +
    `thoughtful friend says when they've been paying attention.\n\n` +
    `Rules:\n` +
    `• Draw only from what was actually shared — never invent or assume.\n` +
    `• Be specific. Name things. Be warm but not sentimental.\n` +
    `• Never use the words "journey," "growth," "chapter," "impactful," "meaningful," or "moving forward."\n` +
    `• No bullet points. No headers. One flowing paragraph.\n` +
    `• Example register: "Before the week starts — something worth noting from last week. You set out to ` +
    `have a difficult conversation and you had it. You mentioned feeling more settled than you have in months. ` +
    `And you said twice that you're exactly where you want to be. That's worth carrying into this week."\n` +
    `• Start with a phrase like "Before the week starts —" or "Something worth noting from this week —"\n` +
    `Write the paragraph now.`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text) return null;
    logger.info({ userName, chars: text.length }, "[WeeklyGift] Generated");
    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[WeeklyGift] Generation failed");
    return null;
  }
}

// ── Annual letter ─────────────────────────────────────────────────────────────

/**
 * Generates and stores a personal annual letter from all life_captures in the
 * past year. Called once per year on the user's configured annual letter date
 * (default Jan 1). Idempotent — won't regenerate if a letter already exists
 * for the current year.
 */
export async function generateAndStoreAnnualLetter(userName: string): Promise<string | null> {
  await _tableInit;

  const currentYear = new Date().getFullYear();

  // Check if already generated for this year
  const { rows: existing } = await query<LifeAnnualLetter>(
    `SELECT * FROM life_annual_letters WHERE user_name = $1 AND year = $2`,
    [userName, currentYear]
  );
  if (existing.length > 0) {
    logger.info({ userName, year: currentYear }, "[AnnualLetter] Already exists for this year");
    return existing[0]!.letter;
  }

  // Fetch all captures from the past year
  const yearCaptures = await getRecentCaptures(userName, 365);
  if (yearCaptures.length < 5) {
    logger.info({ userName }, "[AnnualLetter] Too few captures for annual letter — skipping");
    return null;
  }

  const profile   = await getProfile(userName).catch(() => null);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const captureLines = yearCaptures
    .map((c) => {
      const date = new Date(c.captured_at).toLocaleDateString("en-US", {
        timeZone: profile?.timezone ?? "UTC", month: "long", day: "numeric",
      });
      return `• [${date}, ${c.context}] ${c.content}`;
    })
    .join("\n");

  const prompt =
    `${firstName}'s reflections, intentions, and goals from the past year:\n${captureLines}\n\n` +
    `Write a personal letter to ${firstName} — from the voice of a companion who has ` +
    `been paying close attention all year. This letter is about the year: what they went through, ` +
    `what they learned, who they're becoming.\n\n` +
    `Rules:\n` +
    `• Draw only from what was actually shared — never invent.\n` +
    `• Write in warm, human language — like a letter from a trusted friend, not a report.\n` +
    `• 4–6 paragraphs. Cover themes that genuinely emerged — relationships, goals, patterns, growth.\n` +
    `• Be specific. Name things. Be honest but gentle.\n` +
    `• Never use "journey," "chapter," "growth mindset," "moving forward," or corporate language.\n` +
    `• Start with "Dear ${firstName}," and end with something warm and forward-looking.\n` +
    `Write the letter now.`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1200,
      messages:   [{ role: "user", content: prompt }],
    });
    const letter = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!letter) return null;

    await query(
      `INSERT INTO life_annual_letters (user_name, year, letter)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_name, year) DO UPDATE SET letter = EXCLUDED.letter, generated_at = now()`,
      [userName, currentYear, letter]
    );
    logger.info({ userName, year: currentYear, chars: letter.length }, "[AnnualLetter] Generated and stored");
    return letter;
  } catch (err) {
    logger.warn({ err, userName }, "[AnnualLetter] Generation failed");
    return null;
  }
}

export async function getStoredAnnualLetter(
  userName: string,
  year?: number,
): Promise<LifeAnnualLetter | null> {
  await _tableInit;
  const targetYear = year ?? new Date().getFullYear();
  const { rows } = await query<LifeAnnualLetter>(
    `SELECT * FROM life_annual_letters WHERE user_name = $1 AND year = $2`,
    [userName, targetYear]
  );
  return rows[0] ?? null;
}
