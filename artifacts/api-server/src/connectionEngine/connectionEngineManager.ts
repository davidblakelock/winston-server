/**
 * Connection Engine
 *
 * Generalizes the four reasoning passes that used to live only in
 * lifeCapturesManager.ts (runDotConnector, runPatternObservation,
 * getWeeklyGift) plus a new cluster pass, so they can read across more than
 * one source table. life_captures and attic_items are the two sources wired
 * up for v1 — journal_entries and goals join later (see build spec Part 3
 * sequencing), once this closed loop is proven.
 *
 * This module owns the shared output tables. Sources keep their own storage
 * (life_captures, attic_items, ...) — nothing here migrates or duplicates
 * that data, it only reads it.
 *
 * Tables:
 *   connections       — structural links between two items (e.g. attic-item
 *                        to attic-item, found by the cluster pass)
 *   observations      — the user-facing surfaced insight, one row per
 *                        dot-connector suggestion / pattern / cluster / weekly
 *                        gift
 *   user_corrections  — natural-language feedback rows (Phase 5 — table only
 *                        for now, no read/write helpers yet)
 *
 * life_suggestions and life_observations (the old per-feature tables this
 * replaces) are left in place, empty going forward — standing no-DROP policy,
 * same treatment as profile_items. No migration of old pending rows.
 */

import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU, MODEL_SONNET } from "../lib/models.js";
import { getUserLocationContext } from "../lib/userTimezone.js";
import { getProfile, getActiveUsers } from "../onboarding/onboardingManager.js";
import { getRecentCaptures } from "../lifeCaptures/lifeCapturesManager.js";
import { getRecentAtticItems } from "../attic/atticItemsManager.js";
import { getGoals, type Goal } from "../goals/goalsManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic();

// Starting number, not a rule standing in for judgment — tune from real score
// distributions once cluster data exists (build spec Part 1.6, Phase 4 note).
const CLUSTER_CONFIDENCE_THRESHOLD = 80;

// ── Table init ────────────────────────────────────────────────────────────────

const _tableInit = (async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS connections (
      id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name         text NOT NULL,
      source_type       text NOT NULL,
      source_id         integer NOT NULL,
      target_type       text NOT NULL,
      target_id         text NOT NULL,
      connection_reason text NOT NULL,
      confidence_score  integer NOT NULL DEFAULT 90,
      status            text NOT NULL DEFAULT 'suggested',
      created_at        timestamptz NOT NULL DEFAULT now()
    )
  `).catch((err) => logger.error({ err }, "[ConnectionEngine] connections table init failed"));

  await query(`
    CREATE INDEX IF NOT EXISTS connections_user_source_idx ON connections (user_name, source_type, source_id)
  `).catch((err) => logger.error({ err }, "[ConnectionEngine] connections index init failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS observations (
      id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name             text NOT NULL,
      observation_type      text NOT NULL,
      message               text NOT NULL,
      supporting_item_ids   integer[] NOT NULL DEFAULT '{}',
      confidence_score      integer NOT NULL DEFAULT 90,
      urgency               text NOT NULL DEFAULT 'low',
      should_interrupt_user boolean NOT NULL DEFAULT false,
      suggested_action      text,
      status                text NOT NULL DEFAULT 'pending',
      created_at            timestamptz NOT NULL DEFAULT now(),
      shown_at              timestamptz
    )
  `).catch((err) => logger.error({ err }, "[ConnectionEngine] observations table init failed"));

  await query(`
    CREATE INDEX IF NOT EXISTS observations_user_pending_idx ON observations (user_name, observation_type, status)
  `).catch((err) => logger.error({ err }, "[ConnectionEngine] observations index init failed"));

  await query(`
    CREATE TABLE IF NOT EXISTS user_corrections (
      id                        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name                 text NOT NULL,
      correction_type           text NOT NULL,
      affected_item_ids         integer[] NOT NULL DEFAULT '{}',
      natural_language_feedback text NOT NULL,
      created_at                timestamptz NOT NULL DEFAULT now()
    )
  `).catch((err) => logger.error({ err }, "[ConnectionEngine] user_corrections table init failed"));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionEngineTrigger = "capture" | "batch_daily" | "weekly" | "annual";

export type SourceType = "life_capture" | "attic_item";

export interface SourceItem {
  sourceType: SourceType;
  sourceId:   number;
  content:    string;
  context:    string;
  occurredAt: string;
}

export interface Connection {
  id:                number;
  user_name:         string;
  source_type:       string;
  source_id:         number;
  target_type:       string;
  target_id:         string;
  connection_reason: string;
  confidence_score:  number;
  status:            "suggested" | "accepted" | "dismissed" | "rejected";
  created_at:        string;
}

export type ObservationType = "dot_connector" | "pattern" | "cluster" | "weekly_gift";

export interface Observation {
  id:                    number;
  user_name:             string;
  observation_type:      ObservationType;
  message:               string;
  supporting_item_ids:   number[];
  confidence_score:      number;
  urgency:               "low" | "medium" | "high";
  should_interrupt_user: boolean;
  suggested_action:      string | null;
  status:                "pending" | "shown" | "dismissed" | "accepted";
  created_at:            string;
  shown_at:              string | null;
}

// ── Surfacing ─────────────────────────────────────────────────────────────────
// For consumers (e.g. Evening Wind Down) that want to weave in the single
// best pending observation, regardless of which pass produced it.

export async function getTopPendingObservation(userName: string): Promise<Observation | null> {
  await _tableInit;
  const { rows } = await query<Observation>(
    `SELECT * FROM observations
     WHERE user_name = $1 AND status = 'pending'
     ORDER BY confidence_score DESC, created_at DESC
     LIMIT 1`,
    [userName]
  );
  return rows[0] ?? null;
}

export async function markObservationShown(id: number): Promise<void> {
  await query(
    `UPDATE observations SET status = 'shown', shown_at = now() WHERE id = $1`,
    [id]
  );
}

// ── Corrections (Phase 5) ─────────────────────────────────────────────────────
// Simple version: raw feedback text fed back into future passes as one more
// prompt ingredient, same shape as every other context block those passes
// already build. No item-level exclusion filtering, no embeddings — not
// proven necessary yet. connections is untouched — nothing writes to it today,
// so there's nothing for a correction to target there.

export type CorrectionType = "dismiss" | "reject" | "elevate" | "forget";

export interface UserCorrection {
  id:                        number;
  user_name:                 string;
  correction_type:           CorrectionType;
  affected_item_ids:         number[];
  natural_language_feedback: string;
  created_at:                string;
}

// dismiss/reject/forget all close the observation out the same way — the
// distinction between them lives in correction_type/feedback for future
// passes to read, not as separate observation states.
const CORRECTION_TO_STATUS: Record<CorrectionType, "dismissed" | "accepted"> = {
  dismiss: "dismissed",
  reject:  "dismissed",
  forget:  "dismissed",
  elevate: "accepted",
};

// Targets the most-recently-shown observation for this user — same pattern
// as getPendingEmailReply/getPendingText: no ID travels through the action
// tag, the server resolves "the thing currently in context" itself.
export async function getMostRecentShownObservation(userName: string): Promise<Observation | null> {
  await _tableInit;
  const { rows } = await query<Observation>(
    `SELECT * FROM observations
     WHERE user_name = $1 AND status = 'shown'
     ORDER BY shown_at DESC
     LIMIT 1`,
    [userName]
  );
  return rows[0] ?? null;
}

export async function applyObservationCorrection(
  userName:       string,
  correctionType: CorrectionType,
  feedback:       string,
): Promise<{ observationId: number } | null> {
  await _tableInit;
  const target = await getMostRecentShownObservation(userName);
  if (!target) return null;

  await query(
    `UPDATE observations SET status = $1 WHERE id = $2`,
    [CORRECTION_TO_STATUS[correctionType], target.id]
  );
  await query(
    `INSERT INTO user_corrections (user_name, correction_type, affected_item_ids, natural_language_feedback)
     VALUES ($1, $2, $3, $4)`,
    [userName, correctionType, [target.id], feedback]
  );
  logger.info({ userName, correctionType, observationId: target.id }, "[ConnectionEngine] Correction applied");
  return { observationId: target.id };
}

export async function getRecentCorrections(
  userName: string,
  days      = 30,
): Promise<UserCorrection[]> {
  await _tableInit;
  const { rows } = await query<UserCorrection>(
    `SELECT * FROM user_corrections
     WHERE user_name = $1 AND created_at >= now() - ($2 || ' days')::interval
     ORDER BY created_at DESC`,
    [userName, days.toString()]
  );
  return rows;
}

function formatCorrectionContext(corrections: UserCorrection[]): string {
  if (corrections.length === 0) return "";
  const lines = corrections
    .slice(0, 10)
    .map((c) => `  - "${c.natural_language_feedback}"`)
    .join("\n");
  return `\nPast feedback from the user on suggestions/observations like this — take it into account, ` +
    `don't repeat something they've dismissed for a similar reason, and weigh things they've marked ` +
    `important more heavily:\n${lines}\n`;
}

// A second context source alongside life_capture/attic_item — not merged into
// SourceItem[] since goals aren't a recency-sorted stream of things that
// happened, they're standing context to check saved items against. Active
// goals only, capped at 8 (same cap generateGoalsRecap uses). No goal-creation
// logic here — this only lets the passes notice a connection to what already
// exists.
async function fetchGoalContext(userName: string): Promise<string> {
  const goals = await getGoals(userName).catch(() => [] as Goal[]);
  const active = goals.filter((g) => !g.completed_at).slice(0, 8);
  if (active.length === 0) return "";
  const lines = active
    .map((g) => {
      const done  = g.steps.filter((s) => s.completed).length;
      const total = g.steps.length;
      return `  - "${g.title}"${g.description ? ` — ${g.description}` : ""} (${total > 0 ? `${done}/${total} steps done` : "no steps yet"})`;
    })
    .join("\n");
  return `\nCurrent goals — surface a connection here only if a saved item genuinely relates to one of these, ` +
    `don't force it:\n${lines}\n`;
}

// ── Source adapter ────────────────────────────────────────────────────────────
// Normalizes across source tables so the passes below can read a mixed pool
// of items without knowing which table each one came from. Sources keep their
// own storage — this only fetches and reshapes.

export async function fetchSourceItems(
  userName:    string,
  sourceTypes: SourceType[],
  days:        number,
): Promise<SourceItem[]> {
  const items: SourceItem[] = [];

  if (sourceTypes.includes("life_capture")) {
    const captures = await getRecentCaptures(userName, days);
    for (const c of captures) {
      items.push({
        sourceType: "life_capture",
        sourceId:   c.id,
        content:    c.content,
        context:    c.context,
        occurredAt: c.captured_at,
      });
    }
  }

  if (sourceTypes.includes("attic_item")) {
    const atticItems = await getRecentAtticItems(userName, days);
    for (const it of atticItems) {
      items.push({
        sourceType: "attic_item",
        sourceId:   it.id,
        content:    it.raw_content,
        context:    it.source_type,
        occurredAt: it.created_at,
      });
    }
  }

  items.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  return items;
}

function formatItemLines(items: SourceItem[], tz: string, limit: number): string {
  return items
    .slice(0, limit)
    .map((it) => {
      const date = new Date(it.occurredAt).toLocaleDateString("en-US", {
        timeZone: tz, month: "short", day: "numeric",
      });
      return `• [${date}, ${it.context}] ${it.content}`;
    })
    .join("\n");
}

// ── Dot-connector (actionable suggestions) ───────────────────────────────────
// Generalized runDotConnector (lifeCapturesManager.ts) — same prompt, same
// binary null-or-sentence style, same "one kept at a time" / 3-day rate limit,
// now reading life_capture + attic_item instead of life_captures alone, and
// writing to observations (observation_type='dot_connector') instead of the
// old life_suggestions table.

export async function dotConnectorPass(userName: string): Promise<void> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item"], 30);
  if (items.length < 4) return; // need enough data for meaningful patterns

  const { rows: rateRows } = await query<{ id: number }>(
    `SELECT id FROM observations
     WHERE user_name = $1 AND observation_type = 'dot_connector' AND created_at >= now() - interval '3 days'`,
    [userName]
  );
  if (rateRows.length > 0) return;

  const profile = await getProfile(userName).catch(() => null);
  const { timezone: tz, city: lcCity } = await getUserLocationContext(userName);
  const city      = profile?.city ?? lcCity ?? "";
  const raw       = (profile?.rawData ?? {}) as Record<string, unknown>;
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
        Object.entries(byList).map(([name, its]) =>
          `  ${name}: ${its.slice(0, 10).join(", ")}`
        ).join("\n");
    }
  } catch { /* non-fatal */ }

  const itemLines = formatItemLines(items, tz, 100);
  const corrections = await getRecentCorrections(userName, 30);
  const goalContext = await fetchGoalContext(userName);

  const prompt =
    `${firstName}'s personal reflections and saved items from the last 30 days:\n${itemLines}\n\n` +
    `Profile: lives in ${city}, interests include ${interests.slice(0, 6).join(", ") || "various things"}.` +
    listContext + formatCorrectionContext(corrections) + goalContext + `\n\n` +
    `One question: Is there anything in the above that Winston could take a concrete action on RIGHT NOW — ` +
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
      model:      MODEL_HAIKU,
      max_tokens: 80,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^null$/i.test(text)) {
      logger.info({ userName }, "[ConnectionEngine] DotConnector: no actionable suggestion found");
      return;
    }

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'dot_connector' AND status = 'pending'`,
      [userName]
    );
    await query(
      `INSERT INTO observations (user_name, observation_type, message, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'dot_connector', $2, 90, 'low', false)`,
      [userName, text]
    );
    logger.info({ userName, suggestion: text.slice(0, 80) }, "[ConnectionEngine] DotConnector: suggestion stored");
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] DotConnector: Claude call failed");
  }
}

// ── Socratic mirror — pattern observation ────────────────────────────────────
// Generalized runPatternObservation (lifeCapturesManager.ts) — same prompt and
// rate-limit, now reading life_capture + attic_item, writing to observations
// (observation_type='pattern') instead of the old life_observations table.

export async function patternObservationPass(userName: string): Promise<void> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item"], 30);
  if (items.length < 4) return; // need enough data to find patterns

  const { rows: recent } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM observations
     WHERE user_name = $1 AND observation_type = 'pattern' AND created_at >= now() - interval '3 days'`,
    [userName]
  );
  if (parseInt(recent[0]?.count ?? "0", 10) > 0) {
    logger.info({ userName }, "[ConnectionEngine] PatternObservation: rate-limited");
    return;
  }

  const profile   = await getProfile(userName).catch(() => null);
  const { timezone: tz } = await getUserLocationContext(userName);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const itemLines = formatItemLines(items, tz, 100);
  const corrections = await getRecentCorrections(userName, 30);
  const goalContext = await fetchGoalContext(userName);

  const prompt =
    `${firstName}'s personal reflections and saved items from the last 30 days:\n${itemLines}\n` +
    formatCorrectionContext(corrections) + goalContext + `\n` +
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
      model:      MODEL_HAIKU,
      max_tokens: 100,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text || /^null$/i.test(text)) {
      logger.info({ userName }, "[ConnectionEngine] PatternObservation: no genuine pattern found");
      return;
    }

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'pattern' AND status = 'pending'`,
      [userName]
    );
    await query(
      `INSERT INTO observations (user_name, observation_type, message, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'pattern', $2, 90, 'low', false)`,
      [userName, text]
    );
    logger.info({ userName, obs: text.slice(0, 80) }, "[ConnectionEngine] PatternObservation: observation stored");
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] PatternObservation: Claude call failed");
  }
}

// ── Cluster pass — Attic-to-Attic ────────────────────────────────────────────
// New: no reference function does this today. Unlike the two passes above,
// clustering needs an actual graded confidence (several candidate clusters of
// varying strength, not one yes/no), so this is the one pass that asks Claude
// for a numeric score and thresholds on it in code.
//
// This is a direct Claude reasoning pass over the raw attic_item text, not
// embedding-similarity candidate generation — pgvector isn't wired into any
// code path yet (that's Phase 2 extraction work), and attic_items has no real
// data until Phase 1 capture ships anyway. Revisit once both exist.

export async function clusterPass(userName: string): Promise<void> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["attic_item"], 30);
  if (items.length < 4) return; // not enough saved items to find a genuine cluster

  const { rows: rateRows } = await query<{ id: number }>(
    `SELECT id FROM observations
     WHERE user_name = $1 AND observation_type = 'cluster' AND created_at >= now() - interval '1 day'`,
    [userName]
  );
  if (rateRows.length > 0) return; // guards overlapping runs; cadence itself is set by the batch_daily cron

  const profile = await getProfile(userName).catch(() => null);
  const { timezone: tz } = await getUserLocationContext(userName);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const itemLines = items
    .slice(0, 150)
    .map((it, i) => {
      const date = new Date(it.occurredAt).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
      return `[${i}] (${date}, ${it.context}) ${it.content}`;
    })
    .join("\n");
  const corrections = await getRecentCorrections(userName, 30);

  const prompt =
    `${firstName} has saved these items to their Attic over the last 30 days — things that caught their ` +
    `attention with no destination in mind:\n${itemLines}\n` +
    formatCorrectionContext(corrections) + `\n` +
    `Look for a genuine cluster: three or more separate items pointing at the same emerging interest or ` +
    `unstated intention that isn't already reflected anywhere else (e.g. several Europe-related saves ` +
    `suggesting a trip interest with nothing on the calendar yet). Do not force a cluster that isn't really ` +
    `there — most of the time there won't be one.\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"confidence": 0-100, "theme": "short theme name or null", "message": "one warm conversational sentence ` +
    `Winston would say, or null", "itemIndexes": [item numbers above that belong to the cluster, or empty]}\n\n` +
    `confidence reflects how genuinely non-obvious and real this cluster is — not enthusiasm. If nothing ` +
    `clusters: {"confidence": 0, "theme": null, "message": null, "itemIndexes": []}.`;

  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_SONNET,
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) {
      logger.info({ userName }, "[ConnectionEngine] Cluster: no JSON in response");
      return;
    }

    const parsed = JSON.parse(m[0]) as {
      confidence:  number;
      theme:       string | null;
      message:     string | null;
      itemIndexes: number[];
    };

    if (!parsed.message || parsed.confidence < CLUSTER_CONFIDENCE_THRESHOLD || !parsed.itemIndexes?.length) {
      logger.info({ userName, confidence: parsed.confidence }, "[ConnectionEngine] Cluster: below threshold");
      return;
    }

    const clusterItems = parsed.itemIndexes
      .map((i) => items[i])
      .filter((it): it is SourceItem => !!it && it.sourceType === "attic_item");
    if (clusterItems.length < 2) return;

    // No per-pair connections rows — supporting_item_ids on the observation
    // below already fully encodes cluster membership, and every pair here
    // would carry the identical confidence/reason, so a full n-choose-2 mesh
    // is pure redundant writes that grow quadratically with cluster size for
    // zero queryable value (nothing reads the connections table today).

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'cluster' AND status = 'pending'`,
      [userName]
    );
    await query(
      `INSERT INTO observations (user_name, observation_type, message, supporting_item_ids, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'cluster', $2, $3, $4, 'low', false)`,
      [userName, parsed.message, clusterItems.map((it) => it.sourceId), parsed.confidence]
    );
    logger.info({ userName, confidence: parsed.confidence, theme: parsed.theme }, "[ConnectionEngine] Cluster: observation stored");
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] Cluster: Claude call failed");
  }
}

// ── Weekly gift ───────────────────────────────────────────────────────────────
// Generalized getWeeklyGift (lifeCapturesManager.ts) — same prompt, now reading
// life_capture + attic_item and storing into observations
// (observation_type='weekly_gift', confidence 100 since this is synthesis, not
// a graded finding) instead of only returning text live. The original
// getWeeklyGift is left untouched in lifeCapturesManager.ts; nothing currently
// calls it, so nothing breaks by adding this as a separate, additive pass.

export async function weeklyGiftPass(userName: string): Promise<string | null> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item"], 7);
  if (items.length < 2) {
    logger.info({ userName }, "[ConnectionEngine] WeeklyGift: fewer than 2 items — skipping");
    return null;
  }

  const profile   = await getProfile(userName).catch(() => null);
  const { timezone: tz } = await getUserLocationContext(userName);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const itemLines = items
    .map((it) => {
      const date = new Date(it.occurredAt).toLocaleDateString("en-US", {
        timeZone: tz, weekday: "short", month: "short", day: "numeric",
      });
      return `• [${date}, ${it.context}] ${it.content}`;
    })
    .join("\n");

  const prompt =
    `${firstName}'s reflections and saved items from the past 7 days:\n${itemLines}\n\n` +
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
      model:      MODEL_SONNET,
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    if (!text) return null;

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'weekly_gift' AND status = 'pending'`,
      [userName]
    );
    await query(
      `INSERT INTO observations (user_name, observation_type, message, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'weekly_gift', $2, 100, 'low', false)`,
      [userName, text]
    );
    logger.info({ userName, chars: text.length }, "[ConnectionEngine] WeeklyGift: generated and stored");
    return text;
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] WeeklyGift: generation failed");
    return null;
  }
}

// ── Unified entry point ──────────────────────────────────────────────────────
// annual letter generation is untouched — generateAndStoreAnnualLetter stays
// in lifeCapturesManager.ts against life_annual_letters, its own table. Long-
// form, one-per-year, retrieved by year: urgency/should_interrupt_user/
// suggested_action don't mean anything for a letter, so it doesn't belong in
// observations. This dispatcher just calls through to it for the 'annual' case.

export async function runConnectionEngine(
  userName: string,
  trigger:  ConnectionEngineTrigger,
): Promise<void> {
  switch (trigger) {
    case "capture":
      await Promise.allSettled([
        dotConnectorPass(userName),
        patternObservationPass(userName),
      ]);
      break;
    case "batch_daily":
      await clusterPass(userName);
      break;
    case "weekly":
      await weeklyGiftPass(userName);
      break;
    case "annual": {
      const { generateAndStoreAnnualLetter } = await import("../lifeCaptures/lifeCapturesManager.js");
      await generateAndStoreAnnualLetter(userName);
      break;
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Daily at noon UTC: batch_daily (cluster) + annual for every active user.
// annual relies on generateAndStoreAnnualLetter's own per-year idempotency
// check (it no-ops if a letter already exists for the current year) — there's
// no per-user "configured annual letter date" setting anywhere in this
// codebase today, so this fires as soon as there's enough data rather than
// waiting for a specific date. weekly (gift) additionally runs on Sundays,
// matching journalPatternAnalyzer's existing weekly cadence. Both weekly and
// annual will mostly no-op until there's more than a token amount of data —
// expected, not a bug.

export function startConnectionEngineScheduler(): void {
  let _running = false;
  cron.schedule("0 12 * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => [{ userName: NATIVE_STORED_NAME }]);
      const isSunday = new Date().getUTCDay() === 0;

      for (const u of users) {
        await runConnectionEngine(u.userName, "batch_daily").catch((err) =>
          logger.warn({ err, userName: u.userName }, "[ConnectionEngine] Scheduler: batch_daily run failed")
        );
        await runConnectionEngine(u.userName, "annual").catch((err) =>
          logger.warn({ err, userName: u.userName }, "[ConnectionEngine] Scheduler: annual run failed")
        );
        if (isSunday) {
          await runConnectionEngine(u.userName, "weekly").catch((err) =>
            logger.warn({ err, userName: u.userName }, "[ConnectionEngine] Scheduler: weekly run failed")
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "[ConnectionEngine] Scheduler error");
    } finally {
      _running = false;
    }
  }, { timezone: "UTC" });

  logger.info("[ConnectionEngine] Scheduler started (daily batch_daily/annual, weekly on Sundays)");
}
