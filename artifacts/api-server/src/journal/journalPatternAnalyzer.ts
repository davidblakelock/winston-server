// ── Journal Pattern Analyzer ──────────────────────────────────────────────────
// Runs a weekly Claude analysis of the user's journal entries to detect
// patterns: stress, loneliness, boredom, health concerns.
// Stores the result in journal_insights and exposes helpers for morning/evening injection.

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { getRecentJournalEntries, formatJournalForPrompt } from "./journalManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";

const NATIVE_USER = process.env.NATIVE_USER ?? "davidblakelock";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Table setup ───────────────────────────────────────────────────────────────

export async function ensureJournalInsightsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS journal_insights (
      id           SERIAL PRIMARY KEY,
      user_name    VARCHAR(100) NOT NULL,
      insight      TEXT NOT NULL,
      pattern_tags TEXT,
      analysis_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS journal_insights_user_date_idx
    ON journal_insights (user_name, analysis_date DESC)
  `);
  logger.info("[JOURNAL INSIGHTS] Table ready");
}

// ── Analysis ──────────────────────────────────────────────────────────────────

async function analyzeJournalForUser(userName: string): Promise<void> {
  const entries = await getRecentJournalEntries(7);
  if (entries.length === 0) {
    logger.info({ userName }, "[JOURNAL INSIGHTS] No journal entries this week — skipping analysis");
    return;
  }

  const formatted = formatJournalForPrompt(entries);

  const prompt =
    `You are a caring, perceptive companion reviewing someone's private journal entries from the past week. ` +
    `Look for genuine patterns — not just isolated moments, but recurring themes that suggest something worth gently noting.\n\n` +
    `JOURNAL ENTRIES:\n${formatted}\n\n` +
    `Identify any meaningful patterns from this list:\n` +
    `- STRESS: mentions of pressure, overwhelm, frustration, busyness, anxiety\n` +
    `- LONELINESS: isolation, missing people, lack of connection, feeling unseen\n` +
    `- BOREDOM: repetition, restlessness, lack of engagement\n` +
    `- HEALTH: physical complaints, sleep issues, fatigue, body concerns\n` +
    `- POSITIVE: warmth, gratitude, joy, good moments\n\n` +
    `RESPONSE FORMAT (JSON only — no markdown):\n` +
    `{\n` +
    `  "patterns": ["stress", "loneliness"],\n` +
    `  "insight": "One or two sentences, written as if a caring friend noticed this naturally. ` +
    `Not clinical. Not preachy. Warm and specific. Example: ` +
    `'You've seemed stretched thin this week — when did you last get an afternoon just to yourself?' ` +
    `or 'There\\'s been a quiet thread of missing people in your writing this week. When did you last reach out to someone who matters?'\n` +
    `  If no notable pattern: use null.\n` +
    `"}\n\n` +
    `If the entries are too short, too few, or too varied to identify a real pattern, return: {"patterns": [], "insight": null}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content[0];
    if (block.type !== "text") return;

    const raw = block.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(raw) as { patterns: string[]; insight: string | null };

    if (!parsed.insight) {
      logger.info({ userName }, "[JOURNAL INSIGHTS] No meaningful pattern detected this week");
      return;
    }

    await query(
      `INSERT INTO journal_insights (user_name, insight, pattern_tags, analysis_date)
       VALUES ($1, $2, $3, CURRENT_DATE)
       RETURNING user_name`,
      [userName, parsed.insight, parsed.patterns.join(",")]
    );

    logger.info({ userName, patterns: parsed.patterns, chars: parsed.insight.length }, "[JOURNAL INSIGHTS] Insight saved");
  } catch (err) {
    logger.warn({ err }, "[JOURNAL INSIGHTS] Analysis failed");
  }
}

// ── Scheduler (Sunday at 6 AM CT) ────────────────────────────────────────────

export function startJournalPatternScheduler(): void {
  // Runs every Sunday at 6:00 AM Central Time
  cron.schedule("0 6 * * 0", async () => {
    logger.info("[JOURNAL INSIGHTS] Weekly journal analysis starting");
    try {
      const users = await getActiveUsers().catch(() => [{ userName: NATIVE_USER }]);
      for (const u of users) {
        await analyzeJournalForUser(u.userName);
      }
    } catch (err) {
      logger.error({ err }, "[JOURNAL INSIGHTS] Weekly scheduler error");
    }
  }, { timezone: "America/Chicago" });

  logger.info("[JOURNAL INSIGHTS] Weekly scheduler started (Sundays 6 AM CT)");
}

// ── Retrieval — for injection into morning briefing and evening wind-down ──────

export async function getLatestJournalInsight(userName: string): Promise<string | null> {
  const { rows } = await query<{ insight: string; analysis_date: string }>(
    `SELECT insight, analysis_date FROM journal_insights
     WHERE user_name = $1
       AND analysis_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY created_at DESC LIMIT 1`,
    [userName]
  );
  return rows.length > 0 ? rows[0].insight : null;
}
