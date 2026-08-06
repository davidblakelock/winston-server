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
 *
 * user_corrections (natural-language feedback rows) is owned by
 * memorySourceAdapters.ts now, not this file — see ensureUserCorrectionsTable.
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
import {
  fetchFromAdapters,
  type SourceType,
  type SourceItem,
  getRecentCorrections,
  type UserCorrection,
  recencyLabel,
  ensureUserCorrectionsTable,
} from "./memorySourceAdapters.js";
import { fetchGoalContext, type IndexedGoalContext, getGoalById } from "./standingContextAdapters.js";
import { applyProfileFact, type ExtractedFacts, pruneOldChatFacts } from "../memory/memoryManager.js";
import { getStoicForUser, PHASE_NAMES } from "../stoic/stoicManager.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";

const anthropic = new Anthropic();

// Starting number, not a rule standing in for judgment — tune from real score
// distributions once cluster data exists (build spec Part 1.6, Phase 4 note).
const CLUSTER_CONFIDENCE_THRESHOLD = 80;

// Goal-suggestion gate (build spec Part 3.4): a single one-off cluster is not
// enough evidence of a genuine emerging interest — require the SAME items to
// resurface across a separate, later batch_daily run before offering to make
// it a goal. Window is how far back to look for a prior cluster to compare
// against; count is how many shared attic_item IDs count as "the same
// pattern recurring" rather than one coincidental shared item.
const GOAL_ELIGIBLE_LOOKBACK_DAYS  = 14;
const GOAL_ELIGIBLE_MIN_OVERLAP    = 2;

// Appended to a goal-eligible cluster's message, stripped back off by
// chatHandlerCore.ts's create_goal_from_observation handler when building a
// goal's description — the question reads fine as a live prompt but not as
// persisted text once it's actually become a goal.
export const GOAL_OFFER_SUFFIX = " Want me to make that an actual goal?";

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

  // theme: short title-shaped phrase clusterPass already generates but never
  // stored — needed as a goal title candidate once a cluster is goal-eligible.
  // goal_eligible: set true only when a cluster's items overlap a PRIOR
  // separate batch_daily run's cluster (not just this one run) — see
  // clusterPass. Gates whether the goal-creation invitation is offered at all.
  await query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS theme text`)
    .catch((err) => logger.warn({ err }, "[ConnectionEngine] observations.theme migration warning"));
  await query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS goal_eligible boolean NOT NULL DEFAULT false`)
    .catch((err) => logger.warn({ err }, "[ConnectionEngine] observations.goal_eligible migration warning"));
  // Points at connections.id when dotConnectorPass/patternObservationPass
  // noticed a fit to an existing goal alongside the observation's message.
  // No FK for the same reason source_observation_id on goals has none —
  // this module's own table init has no guaranteed ordering relative to
  // itself running twice (connections vs observations), let alone goals'.
  await query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS related_connection_id integer`)
    .catch((err) => logger.warn({ err }, "[ConnectionEngine] observations.related_connection_id migration warning"));
  // Composite (sourceType, sourceId) pairs — fixes a real correctness gap:
  // the older supporting_item_ids (bare integer[]) has no source-type
  // qualifier, so an attic_items id and an unrelated list_items/chat_facts
  // id could numerically collide in the goal-eligibility recurrence check
  // below. supporting_item_ids is left in place (not dropped, standing
  // no-DROP policy) and still populated for any existing/future reader that
  // wants the flat list, but the recurrence comparison itself now uses this
  // column instead.
  await query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS supporting_items jsonb NOT NULL DEFAULT '[]'`)
    .catch((err) => logger.warn({ err }, "[ConnectionEngine] observations.supporting_items migration warning"));
  // Structured payload for observation types that need to carry more than
  // free text through to the accept handler — profile_fact stores
  // {category, value} here so applyObservationCorrection can write the
  // right thing on 'elevate' without re-parsing the message text (that
  // would be exactly the brittle-regex pattern this codebase avoids).
  await query(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS payload jsonb`)
    .catch((err) => logger.warn({ err }, "[ConnectionEngine] observations.payload migration warning"));
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionEngineTrigger = "capture" | "batch_daily" | "weekly" | "annual";

// SourceType/SourceItem now live in memorySourceAdapters.ts (Phase 1 of the
// unified memory architecture) — re-exported here so existing call sites
// (goalsManager.ts, this file's own passes) don't need their import paths
// touched.
export type { SourceType, SourceItem } from "./memorySourceAdapters.js";

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

export type ObservationType = "dot_connector" | "pattern" | "cluster" | "weekly_gift" | "profile_fact";

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
  status:                "pending" | "shown" | "dismissed" | "accepted" | "suppressed";
  created_at:            string;
  shown_at:              string | null;
  theme:                 string | null;
  goal_eligible:         boolean;
  related_connection_id: number | null;
  payload:               Record<string, unknown> | null;
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

export async function markObservationAccepted(id: number): Promise<void> {
  await query(
    `UPDATE observations SET status = 'accepted' WHERE id = $1`,
    [id]
  );
}

// ── Connections (goal-fit writes) ────────────────────────────────────────────
// First real writer of the connections table — previously created but unused.
// dotConnectorPass/patternObservationPass call this when they notice a saved
// item genuinely fits an existing goal, instead of only mentioning it in the
// observation's message text.

export async function writeGoalConnection(
  userName:      string,
  sourceType:    SourceType,
  sourceId:      number,
  goalId:        number,
  reason:        string,
  confidence     = 90,
): Promise<number> {
  await _tableInit;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO connections (user_name, source_type, source_id, target_type, target_id, connection_reason, confidence_score, status)
     VALUES ($1, $2, $3, 'goal', $4, $5, $6, 'suggested')
     RETURNING id`,
    [userName, sourceType, sourceId, String(goalId), reason, confidence]
  );
  return rows[0]!.id;
}

export async function getConnectionById(id: number): Promise<Connection | null> {
  await _tableInit;
  const { rows } = await query<Connection>(`SELECT * FROM connections WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateConnectionStatus(
  id:     number,
  status: "suggested" | "accepted" | "dismissed" | "rejected",
): Promise<void> {
  await query(`UPDATE connections SET status = $1 WHERE id = $2`, [status, id]);
}

export async function linkObservationToConnection(observationId: number, connectionId: number): Promise<void> {
  await query(`UPDATE observations SET related_connection_id = $1 WHERE id = $2`, [connectionId, observationId]);
}

// ── Listing for the browsing screen ──────────────────────────────────────────
// The chat flow only ever needed "the single best pending one"
// (getTopPendingObservation) or "whatever was most recently shown"
// (getMostRecentShownObservation) — the Attic browsing screen needs the
// actual list, enriched with the connection (and, when it points at a goal,
// the goal's title) so the client isn't making its own follow-up lookups.

export interface ObservationWithConnection extends Observation {
  connection: {
    id:          number;
    target_type: string;
    goalId:      number | null;
    goalTitle:   string | null;
    status:      Connection["status"];
  } | null;
}

export async function listObservationsForUser(
  userName: string,
  statuses: Observation["status"][] = ["pending", "shown"],
  limit     = 50,
): Promise<ObservationWithConnection[]> {
  await _tableInit;
  const { rows } = await query<Observation>(
    `SELECT * FROM observations
     WHERE user_name = $1 AND status = ANY($2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [userName, statuses, limit]
  );

  const enriched: ObservationWithConnection[] = [];
  for (const row of rows) {
    let connection: ObservationWithConnection["connection"] = null;
    // getConnectionById doesn't filter by user_name (it's only ever been
    // called with an id already scoped to the caller's own observation) —
    // re-check ownership here since this is now reachable from a route.
    if (row.related_connection_id) {
      const conn = await getConnectionById(row.related_connection_id);
      if (conn && conn.user_name === userName) {
        let goalId: number | null = null;
        let goalTitle: string | null = null;
        if (conn.target_type === "goal") {
          const parsed = parseInt(conn.target_id, 10);
          if (!isNaN(parsed)) {
            goalId = parsed;
            const goal = await getGoalById(parsed, userName);
            goalTitle = goal?.title ?? null;
          }
        }
        connection = { id: conn.id, target_type: conn.target_type, goalId, goalTitle, status: conn.status };
      }
    }
    enriched.push({ ...row, connection });
  }
  return enriched;
}

export async function updateObservationStatus(
  id:       number,
  userName: string,
  status:   Observation["status"],
): Promise<Observation | null> {
  await _tableInit;
  const { rows } = await query<Observation>(
    `UPDATE observations
     SET status = $1, shown_at = CASE WHEN $1 = 'shown' THEN now() ELSE shown_at END
     WHERE id = $2 AND user_name = $3
     RETURNING *`,
    [status, id, userName]
  );
  const updated = rows[0] ?? null;
  // Cascade to the linked goal-connection the same way applyObservationCorrection
  // does for the voice flow — accepted/dismissed on the observation should mean
  // the same thing for whatever connection it carried.
  if (updated?.related_connection_id && (status === "accepted" || status === "dismissed")) {
    await updateConnectionStatus(updated.related_connection_id, status);
  }
  return updated;
}

// ── Corrections (Phase 5) ─────────────────────────────────────────────────────
// Simple version: raw feedback text fed back into future passes as one more
// prompt ingredient, same shape as every other context block those passes
// already build. No item-level exclusion filtering, no embeddings — not
// proven necessary yet. connections is untouched — nothing writes to it today,
// so there's nothing for a correction to target there.

export type CorrectionType = "dismiss" | "reject" | "elevate" | "forget";

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

  const newStatus = CORRECTION_TO_STATUS[correctionType];
  await query(
    `UPDATE observations SET status = $1 WHERE id = $2`,
    [newStatus, target.id]
  );
  // Cascade to the linked goal-connection, if this observation carried one —
  // "elevate" (confirm) accepts it, everything else that closes the
  // observation out (dismiss/reject/forget) dismisses it too.
  if (target.related_connection_id) {
    await updateConnectionStatus(target.related_connection_id, newStatus === "accepted" ? "accepted" : "dismissed");
  }
  // profile_fact's real write-through — only on genuine acceptance, never
  // on dismiss/reject/forget. The payload was captured by profileFactPass
  // at proposal time, not re-derived here.
  if (newStatus === "accepted" && target.observation_type === "profile_fact" && target.payload) {
    const payload = target.payload as { category?: string; value?: string };
    if (payload.category && payload.value) {
      await applyProfileFact(userName, payload.category as keyof ExtractedFacts, payload.value).catch((err) => {
        logger.warn({ err, userName, payload }, "[ConnectionEngine] ProfileFact write-through failed (non-fatal)");
      });
    }
  }
  await ensureUserCorrectionsTable;
  await query(
    `INSERT INTO user_corrections (user_name, correction_type, affected_item_ids, natural_language_feedback)
     VALUES ($1, $2, $3, $4)`,
    [userName, correctionType, [target.id], feedback]
  );
  logger.info({ userName, correctionType, observationId: target.id }, "[ConnectionEngine] Correction applied");
  return { observationId: target.id };
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

// Distinct from getRecentCorrections/formatCorrectionContext (explicit
// user feedback — dismiss/reject/elevate/forget). This is "what has
// actually been told to this person recently, regardless of whether they
// reacted to it" — so generation itself can recognize it's about to repeat
// something, not just avoid repeating something the user explicitly pushed
// back on. Includes every status (pending/shown/accepted/dismissed/
// suppressed) — a pending-but-not-yet-shown observation about the same
// theme is just as much a reason to avoid regenerating it as a shown one.
export async function getRecentSurfacedObservations(userName: string, days = 30): Promise<Observation[]> {
  await _tableInit;
  const { rows } = await query<Observation>(
    `SELECT * FROM observations
     WHERE user_name = $1 AND created_at >= now() - interval '${days} days'
     ORDER BY created_at DESC
     LIMIT 15`,
    [userName]
  );
  return rows;
}

export function formatRecentSurfacedContext(observations: Observation[]): string {
  if (observations.length === 0) return "";
  const lines = observations
    .map((o) => `  - (${o.observation_type}) ${o.message}`)
    .join("\n");
  return `\nThings you've already told this person recently — do NOT repeat the same insight or ` +
    `observation, even reworded differently. Only surface something here if it's genuinely NEW, or a ` +
    `materially different angle on the same topic (e.g. a real update, not a restatement):\n${lines}\n`;
}

// A third context source, same shape as fetchGoalContext — standing context,
// not part of the recency-sorted item stream. No tenet-matching logic; the
// phase name is just handed over and Claude decides whether it's relevant.
async function fetchStoicPhaseContext(userName: string): Promise<string> {
  const stoic = await getStoicForUser(userName).catch(() => null);
  if (!stoic) return "";
  const phaseName = PHASE_NAMES[stoic.phase] ?? `Phase ${stoic.phase}`;
  return `\nThe user's current Stoic curriculum phase: ${phaseName}. Let this inform your read of what's ` +
    `emerging for them if it genuinely fits — don't force a connection, and never mention the phase or the ` +
    `curriculum by name.\n`;
}

// ── Source adapter ────────────────────────────────────────────────────────────
// Normalizes across source tables so the passes below can read a mixed pool
// of items without knowing which table each one came from. Sources keep their
// own storage — this only fetches and reshapes. Delegates to
// memorySourceAdapters.ts (Phase 1 of the unified memory architecture) —
// this function name/signature stays as the passes' call site so nothing
// downstream needed to change, but the actual per-domain fetch/reshape logic
// now lives in one shared registry instead of inline here.
export async function fetchSourceItems(
  userName:    string,
  sourceTypes: SourceType[],
  days:        number,
): Promise<SourceItem[]> {
  return fetchFromAdapters(userName, sourceTypes, days);
}

// Numbered variant of formatItemLines — needed wherever a pass has to point
// back at a specific item by position (goal-connection linking) rather than
// just quoting it in a message.
function formatIndexedItemLines(items: SourceItem[], tz: string, limit: number): string {
  return items
    .slice(0, limit)
    .map((it, i) => {
      const date = new Date(it.occurredAt).toLocaleDateString("en-US", {
        timeZone: tz, month: "short", day: "numeric",
      });
      return `[${i}] (${date}, ${recencyLabel(it.occurredAt)}, ${it.context}) ${it.content}`;
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

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 30);
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

  const itemLines = formatIndexedItemLines(items, tz, 100);
  const corrections = await getRecentCorrections(userName, 30);
  const recentSurfaced = await getRecentSurfacedObservations(userName);
  const { text: goalContext, goals } = await fetchGoalContext(userName);
  const stoicPhaseContext = await fetchStoicPhaseContext(userName);

  const prompt =
    `${firstName}'s personal reflections and saved items from the last 30 days (numbered):\n${itemLines}\n\n` +
    `Profile: lives in ${city}, interests include ${interests.slice(0, 6).join(", ") || "various things"}.` +
    formatCorrectionContext(corrections) + formatRecentSurfacedContext(recentSurfaced) + goalContext + stoicPhaseContext + `\n\n` +
    `One question: Is there anything in the above that Winston could take a concrete action on RIGHT NOW — ` +
    `specifically something involving: checking the calendar for an open week, making a reservation, ` +
    `researching travel options, or adding something to a list?\n\n` +
    `Rules:\n` +
    `• Only suggest something Winston can actually do — calendar gaps, reservations, travel research, list additions.\n` +
    `• No vague life advice ("you should prioritize rest", "consider reconnecting with family").\n` +
    `• No suggestions about things already in progress or recently acted on.\n` +
    `• RECENCY MATTERS: each item shows how long ago it was said (today / N days ago / N weeks ago). This is a "right now" nudge, not a memory lane trip — weight items from the last several days heavily and treat anything 2+ weeks old as probably no longer live unless something recent still points at it too. Don't build a suggestion off a single stale item just because it's still inside the 30-day window.\n` +
    `• The suggestion must be ONE natural conversational sentence Winston would say — under 25 words.\n` +
    `• Example format: "You mentioned wanting an exotic trip — you have a clear week in September. Want me to start looking at options?"\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"suggestion": "the sentence, or null if nothing genuinely actionable", "itemIndex": <item number above this is most directly based on, or null>, "relatedGoalIndex": <index from "Current goals" above if this genuinely connects to one, or null>}`;

  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 150,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) {
      logger.info({ userName }, "[ConnectionEngine] DotConnector: no JSON in response");
      return;
    }

    const parsed = JSON.parse(m[0]) as {
      suggestion:       string | null;
      itemIndex:        number | null;
      relatedGoalIndex: number | null;
    };

    if (!parsed.suggestion) {
      logger.info({ userName }, "[ConnectionEngine] DotConnector: no actionable suggestion found");
      return;
    }

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'dot_connector' AND status = 'pending'`,
      [userName]
    );
    const { rows: inserted } = await query<{ id: number }>(
      `INSERT INTO observations (user_name, observation_type, message, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'dot_connector', $2, 90, 'low', false)
       RETURNING id`,
      [userName, parsed.suggestion]
    );
    const observationId = inserted[0]!.id;
    logger.info({ userName, suggestion: parsed.suggestion.slice(0, 80) }, "[ConnectionEngine] DotConnector: suggestion stored");

    // Real connections row when this suggestion genuinely fits an existing
    // goal, instead of the fit only living inside the message's prose.
    const matchedGoal = parsed.relatedGoalIndex != null ? goals[parsed.relatedGoalIndex] : undefined;
    const matchedItem = parsed.itemIndex != null ? items[parsed.itemIndex] : undefined;
    if (matchedGoal && matchedItem) {
      const connectionId = await writeGoalConnection(
        userName, matchedItem.sourceType, matchedItem.sourceId, matchedGoal.id, parsed.suggestion
      );
      await linkObservationToConnection(observationId, connectionId);
      logger.info(
        { userName, observationId, connectionId, goalId: matchedGoal.id },
        "[ConnectionEngine] DotConnector: goal connection written"
      );
    }
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

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 30);
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

  const itemLines = formatIndexedItemLines(items, tz, 100);
  const corrections = await getRecentCorrections(userName, 30);
  const recentSurfaced = await getRecentSurfacedObservations(userName);
  const { text: goalContext, goals } = await fetchGoalContext(userName);
  const stoicPhaseContext = await fetchStoicPhaseContext(userName);

  const prompt =
    `${firstName}'s personal reflections and saved items from the last 30 days (numbered):\n${itemLines}\n` +
    formatCorrectionContext(corrections) + formatRecentSurfacedContext(recentSurfaced) + goalContext + stoicPhaseContext + `\n` +
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
    `• RECENCY MATTERS: each item shows how long ago it was said. A real pattern needs at least one occurrence from the last week or so still active — three mentions that all happened 3-4 weeks ago with nothing since is a pattern that already ended, not one worth surfacing now. Don't treat old repeated items as current just because they repeat.\n` +
    `• If there is no genuine pattern: set observation to null.\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"observation": "the observation sentence, or null if no genuine pattern", "itemIndex": <item number above this is most directly based on, or null>, "relatedGoalIndex": <index from "Current goals" above if this genuinely connects to one, or null>}`;

  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 170,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) {
      logger.info({ userName }, "[ConnectionEngine] PatternObservation: no JSON in response");
      return;
    }

    const parsed = JSON.parse(m[0]) as {
      observation:      string | null;
      itemIndex:        number | null;
      relatedGoalIndex: number | null;
    };

    if (!parsed.observation) {
      logger.info({ userName }, "[ConnectionEngine] PatternObservation: no genuine pattern found");
      return;
    }

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'pattern' AND status = 'pending'`,
      [userName]
    );
    const { rows: inserted } = await query<{ id: number }>(
      `INSERT INTO observations (user_name, observation_type, message, confidence_score, urgency, should_interrupt_user)
       VALUES ($1, 'pattern', $2, 90, 'low', false)
       RETURNING id`,
      [userName, parsed.observation]
    );
    const observationId = inserted[0]!.id;
    logger.info({ userName, obs: parsed.observation.slice(0, 80) }, "[ConnectionEngine] PatternObservation: observation stored");

    const matchedGoal = parsed.relatedGoalIndex != null ? goals[parsed.relatedGoalIndex] : undefined;
    const matchedItem = parsed.itemIndex != null ? items[parsed.itemIndex] : undefined;
    if (matchedGoal && matchedItem) {
      const connectionId = await writeGoalConnection(
        userName, matchedItem.sourceType, matchedItem.sourceId, matchedGoal.id, parsed.observation
      );
      await linkObservationToConnection(observationId, connectionId);
      logger.info(
        { userName, observationId, connectionId, goalId: matchedGoal.id },
        "[ConnectionEngine] PatternObservation: goal connection written"
      );
    }
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] PatternObservation: Claude call failed");
  }
}

// ── Cluster pass — cross-domain emerging-interest detection ─────────────────
// Unlike the two passes above, clustering needs an actual graded confidence
// (several candidate clusters of varying strength, not one yes/no), so this
// is the one pass that asks Claude for a numeric score and thresholds on it
// in code.
//
// This is a direct Claude reasoning pass over the raw item text, not
// embedding-similarity candidate generation — pgvector isn't wired into any
// code path yet. Broadened beyond attic_item to attic/list/chat_fact per
// explicit decision (Aug 2026 session) — shopping-list items are already
// excluded upstream at the listItemAdapter level, so no extra filter is
// needed here for that.

export async function clusterPass(userName: string): Promise<void> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["attic_item", "list_item", "chat_fact"], 30);
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
      return `[${i}] (${date}, ${recencyLabel(it.occurredAt)}, ${it.context}) ${it.content}`;
    })
    .join("\n");
  const corrections = await getRecentCorrections(userName, 30);
  const recentSurfaced = await getRecentSurfacedObservations(userName);

  const prompt =
    `Here's what ${firstName} has saved, added to a list, or explored in conversation over the last 30 ` +
    `days:\n${itemLines}\n` +
    formatCorrectionContext(corrections) + formatRecentSurfacedContext(recentSurfaced) + `\n` +
    `Look for a genuine cluster: three or more separate items pointing at the same emerging interest or ` +
    `unstated intention that isn't already reflected anywhere else (e.g. several Europe-related saves ` +
    `suggesting a trip interest with nothing on the calendar yet). Do not force a cluster that isn't really ` +
    `there — most of the time there won't be one.\n\n` +
    `RECENCY MATTERS: each item shows how long ago it was saved (today / N days ago / N weeks ago) — this is ` +
    `an "emerging interest right now" signal, not an archive search. An emerging interest needs at least one ` +
    `item from the last week or two to actually be emerging; three items that all sit 3-4 weeks old with ` +
    `nothing since read as a phase that already passed, not a current one — score confidence low for that, ` +
    `regardless of how neatly the theme fits, unless the match is so unambiguous and strong it would be wrong ` +
    `to ignore it. All-old clusters should rarely clear the confidence bar; a cluster anchored by something ` +
    `recent should be scored on its actual merits.\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"confidence": 0-100, "theme": "short theme name or null", "message": "one warm conversational sentence ` +
    `Winston would say, or null", "itemIndexes": [item numbers above that belong to the cluster, or empty]}\n\n` +
    `confidence reflects how genuinely non-obvious and real this cluster is — not enthusiasm — and must factor ` +
    `in recency as described above. If nothing clusters: {"confidence": 0, "theme": null, "message": null, "itemIndexes": []}.`;

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
      .filter((it): it is SourceItem => !!it);
    if (clusterItems.length < 2) return;

    const newItemIds = clusterItems.map((it) => it.sourceId); // still stored in supporting_item_ids below
    const newSupportingItems = clusterItems.map((it) => ({ sourceType: it.sourceType, sourceId: it.sourceId }));

    // Goal-eligibility check MUST run before the delete below — a prior
    // cluster still sitting at status='pending' (never yet shown) would
    // otherwise be gone before its supporting_items could be compared
    // against this run's.
    const { rows: priorClusters } = await query<{ id: number; supporting_items: Array<{ sourceType: string; sourceId: number }> }>(
      `SELECT id, supporting_items FROM observations
       WHERE user_name = $1 AND observation_type = 'cluster'
         AND created_at >= now() - interval '${GOAL_ELIGIBLE_LOOKBACK_DAYS} days'`,
      [userName]
    );
    // (sourceType, sourceId) pair comparison — the actual fix. Now safe to
    // cover all three sources, not just attic_item, since a bare numeric
    // collision across tables can no longer register as a false recurrence.
    const keyOf = (it: { sourceType: string; sourceId: number }) => `${it.sourceType}:${it.sourceId}`;
    const newKeys = new Set(newSupportingItems.map(keyOf));
    const goalEligible = priorClusters.some((prior) => {
      const overlap = (prior.supporting_items ?? []).filter((it) => newKeys.has(keyOf(it)));
      return overlap.length >= GOAL_ELIGIBLE_MIN_OVERLAP;
    });

    // No per-pair connections rows — supporting_item_ids on the observation
    // below already fully encodes cluster membership, and every pair here
    // would carry the identical confidence/reason, so a full n-choose-2 mesh
    // is pure redundant writes that grow quadratically with cluster size for
    // zero queryable value (nothing reads the connections table today).

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'cluster' AND status = 'pending'`,
      [userName]
    );
    const finalMessage = parsed.message + (goalEligible ? GOAL_OFFER_SUFFIX : "");
    await query(
      `INSERT INTO observations (user_name, observation_type, message, supporting_item_ids, supporting_items, confidence_score, urgency, should_interrupt_user, theme, goal_eligible)
       VALUES ($1, 'cluster', $2, $3, $4, $5, 'low', false, $6, $7)`,
      [userName, finalMessage, newItemIds, JSON.stringify(newSupportingItems), parsed.confidence, parsed.theme, goalEligible]
    );
    logger.info(
      { userName, confidence: parsed.confidence, theme: parsed.theme, goalEligible },
      "[ConnectionEngine] Cluster: observation stored"
    );
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] Cluster: Claude call failed");
  }
}

// ── Profile-fact promotion (Phase 4b) ────────────────────────────────────────
// Generalizes memoryManager.ts's existing chat-fact-extraction judgment to
// domains other than chat — an Attic save, a list item, or a life capture
// can also reveal a durable profile fact chat never got a chance to catch.
// Deliberately conservative: this NEVER writes to user_profiles directly.
// It proposes via an observation (observation_type='profile_fact'), and the
// actual write only happens if the person accepts — see
// applyObservationCorrection's 'elevate' handling below. A single passive
// save is weaker evidence of a genuine durable interest than something the
// person said directly in conversation (which chat's own extraction already
// trusts more), so this stays confirm-gated rather than auto-write.

export async function profileFactPass(userName: string): Promise<void> {
  await _tableInit;

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 30);
  if (items.length < 4) return;

  const { rows: rateRows } = await query<{ id: number }>(
    `SELECT id FROM observations
     WHERE user_name = $1 AND observation_type = 'profile_fact' AND created_at >= now() - interval '1 day'`,
    [userName]
  );
  if (rateRows.length > 0) return;

  const profile = await getProfile(userName).catch(() => null);
  const { timezone: tz } = await getUserLocationContext(userName);
  const firstName = (profile?.name ?? userName).split(" ")[0];

  const itemLines = formatIndexedItemLines(items, tz, 100);
  const corrections = await getRecentCorrections(userName, 30);
  const recentSurfaced = await getRecentSurfacedObservations(userName);

  const existingFacts = [
    profile?.hobbies?.length ? `Hobbies already known: ${profile.hobbies.join(", ")}` : null,
    profile?.favoriteArtists?.length ? `Favorite artists already known: ${profile.favoriteArtists.join(", ")}` : null,
    profile?.sportsTeams ? `Sports teams already known: ${profile.sportsTeams}` : null,
  ].filter(Boolean).join("\n");

  const prompt =
    `${firstName}'s recent saves, reflections, and conversation context from the last 30 days (numbered):\n${itemLines}\n\n` +
    (existingFacts ? `What Winston already knows about them:\n${existingFacts}\n\n` : "") +
    formatCorrectionContext(corrections) + formatRecentSurfacedContext(recentSurfaced) + `\n` +
    `Is there a genuinely durable, specific fact about ${firstName} revealed here that Winston doesn't already ` +
    `know — a hobby, a favorite artist/musician, a restaurant they love, or a sports team they follow? Only ` +
    `surface something backed by real signal in the items above — ideally more than one item pointing at it, ` +
    `not a single passing mention. Never something already known above. Never a guess. Never anything ` +
    `task-like (that belongs elsewhere, not here).\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"category": "hobbies"|"favoriteArtists"|"restaurants"|"sportsTeams"|null, ` +
    `"value": "<the specific fact, e.g. \\"home espresso\\">, or null", ` +
    `"message": "<one warm sentence naming what you noticed and asking if you should remember it, in your own ` +
    `voice — or null>", "itemIndexes": [item numbers above this is based on, or empty]}\n` +
    `Use null for everything if nothing genuinely new and durable came up — most runs won't have one.`;

  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 200,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();

    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return;

    const parsed = JSON.parse(m[0]) as {
      category:    string | null;
      value:       string | null;
      message:     string | null;
      itemIndexes: number[];
    };

    if (!parsed.category || !parsed.value || !parsed.message) {
      logger.info({ userName }, "[ConnectionEngine] ProfileFact: nothing genuinely new found");
      return;
    }

    const supportingItems = (parsed.itemIndexes ?? [])
      .map((i) => items[i])
      .filter((it): it is SourceItem => !!it)
      .map((it) => ({ sourceType: it.sourceType, sourceId: it.sourceId }));
    const supportingIds = supportingItems.map((it) => it.sourceId);

    await query(
      `DELETE FROM observations WHERE user_name = $1 AND observation_type = 'profile_fact' AND status = 'pending'`,
      [userName]
    );
    await query(
      `INSERT INTO observations (user_name, observation_type, message, supporting_item_ids, supporting_items, confidence_score, urgency, should_interrupt_user, payload)
       VALUES ($1, 'profile_fact', $2, $3, $4, 85, 'low', false, $5)`,
      [userName, parsed.message, supportingIds, JSON.stringify(supportingItems), JSON.stringify({ category: parsed.category, value: parsed.value })]
    );
    logger.info(
      { userName, category: parsed.category, value: parsed.value },
      "[ConnectionEngine] ProfileFact: suggestion stored"
    );
  } catch (err) {
    logger.warn({ err, userName }, "[ConnectionEngine] ProfileFact: Claude call failed");
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

  const items = await fetchSourceItems(userName, ["life_capture", "attic_item", "list_item", "chat_fact"], 7);
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
      return `• [${date}, ${recencyLabel(it.occurredAt)}, ${it.context}] ${it.content}`;
    })
    .join("\n");
  const recentSurfaced = await getRecentSurfacedObservations(userName);

  const prompt =
    `${firstName}'s reflections and saved items from the past 7 days:\n${itemLines}\n\n` +
    formatRecentSurfacedContext(recentSurfaced) +
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

// ── Governance ────────────────────────────────────────────────────────────────
// The single arbiter across every observation type. Each pass above decides
// independently whether IT found something worth proposing — this decides,
// given everything currently proposed plus what's already been said lately,
// what (if anything) is actually worth surfacing right now. Runs at the end
// of every runConnectionEngine trigger, not on its own schedule — whenever
// any pass might have just added a new pending candidate is exactly when
// arbitration needs to re-run.

const GOVERNANCE_SURFACE_WINDOW_DAYS = 4; // don't surface anything new if
// something was already shown within this many days — the actual volume
// control, separate from the pairwise "which is best" arbitration below.
const GOVERNANCE_HISTORY_LOOKBACK_DAYS = 14;

export async function governancePass(userName: string): Promise<void> {
  await _tableInit;

  const { rows: pending } = await query<Observation>(
    `SELECT * FROM observations WHERE user_name = $1 AND status = 'pending' ORDER BY created_at ASC`,
    [userName]
  );

  if (pending.length === 0) return; // nothing to arbitrate
  // No longer special-casing a single candidate — it still needs to be
  // checked against recent surfacing history (the actual bug this fixes:
  // a lone near-duplicate observation was previously never compared
  // against anything and sailed straight through). The arbitration prompt
  // below already handles N=1 correctly on its own; a list of one is still
  // a valid list to judge "is this worth surfacing given what's already
  // been said" against.

  // Cross-type volume control — independent of which candidate is "best."
  const { rows: recentShown } = await query<{ id: number }>(
    `SELECT id FROM observations
     WHERE user_name = $1 AND status IN ('shown', 'accepted', 'dismissed')
       AND (shown_at >= now() - interval '${GOVERNANCE_SURFACE_WINDOW_DAYS} days'
            OR (shown_at IS NULL AND created_at >= now() - interval '${GOVERNANCE_SURFACE_WINDOW_DAYS} days'))`,
    [userName]
  );
  if (recentShown.length > 0) {
    // Budget already spent — suppress everything currently pending rather
    // than let it silently queue for next time. If any of these are still
    // genuinely relevant later, their own originating pass will regenerate
    // a fresh, current version of them (each pass's own DELETE-before-INSERT
    // already handles that) — this isn't losing them, it's declining to
    // stack them up.
    await query(
      `UPDATE observations SET status = 'suppressed' WHERE id = ANY($1)`,
      [pending.map((p) => p.id)]
    );
    logger.info(
      { userName, suppressedCount: pending.length },
      "[ConnectionEngine] Governance: recent surface budget spent, suppressing all pending"
    );
    return;
  }

  // Real arbitration — more than one candidate, budget available.
  const { rows: history } = await query<Observation>(
    `SELECT * FROM observations
     WHERE user_name = $1 AND status IN ('shown', 'accepted', 'dismissed')
       AND created_at >= now() - interval '${GOVERNANCE_HISTORY_LOOKBACK_DAYS} days'
     ORDER BY created_at DESC
     LIMIT 10`,
    [userName]
  );

  const candidateLines = pending
    .map((o, i) => `[${i}] (${o.observation_type}) ${o.message}`)
    .join("\n");
  const historyLines = history.length > 0
    ? history.map((o) => `- (${o.observation_type}) ${o.message}`).join("\n")
    : "(nothing shown recently)";

  const prompt =
    `Winston currently has ${pending.length} different things it could tell this person:\n${candidateLines}\n\n` +
    `What's already been said to them in the last ${GOVERNANCE_HISTORY_LOOKBACK_DAYS} days:\n${historyLines}\n\n` +
    `Pick AT MOST ONE of the numbered candidates above to actually surface right now — the single best thing ` +
    `worth telling this person, considering genuine value, avoiding repetitive or overlapping territory with ` +
    `what they've already heard, and not overloading them just because multiple things happen to be ready at ` +
    `once. It's completely fine to pick none if nothing genuinely stands out.\n\n` +
    `Return ONLY this JSON, no markdown:\n` +
    `{"chosenIndex": <number from the list above, or null if none>}`;

  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 60,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const m = stripped.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { chosenIndex: number | null }) : { chosenIndex: null };

    const chosenId = typeof parsed.chosenIndex === "number" ? pending[parsed.chosenIndex]?.id : undefined;
    const suppressIds = pending.filter((p) => p.id !== chosenId).map((p) => p.id);

    if (suppressIds.length > 0) {
      await query(`UPDATE observations SET status = 'suppressed' WHERE id = ANY($1)`, [suppressIds]);
    }
    logger.info(
      { userName, chosenId: chosenId ?? null, suppressedCount: suppressIds.length, candidateCount: pending.length },
      "[ConnectionEngine] Governance: arbitration complete"
    );
  } catch (err) {
    // Fail open, not closed — if governance itself errors, leave all
    // candidates pending rather than silently suppress everything (the
    // existing getTopPendingObservation ORDER BY still degrades gracefully
    // to "pick the highest confidence one" as a fallback in this case).
    logger.warn({ err, userName }, "[ConnectionEngine] Governance: Claude call failed, leaving candidates pending");
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
      await profileFactPass(userName);
      break;
    case "weekly":
      await weeklyGiftPass(userName);
      break;
    case "annual": {
      const { generateAndStoreAnnualLetter } = await import("../lifeCaptures/lifeCapturesManager.js");
      await generateAndStoreAnnualLetter(userName);
      return; // annual letters aren't observations — nothing for governance to arbitrate
    }
  }
  // Runs after every trigger except annual — whichever pass(es) just ran
  // may have added a new pending candidate, so arbitration needs to
  // reconsider the full current set, not just the newest addition.
  await governancePass(userName).catch((err) =>
    logger.warn({ err, userName, trigger }, "[ConnectionEngine] governancePass failed (non-fatal)")
  );
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

      // Global housekeeping, not per-user — runs once per cron firing.
      await pruneOldChatFacts().catch((err) =>
        logger.warn({ err }, "[ConnectionEngine] Scheduler: chat_facts pruning failed")
      );

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
