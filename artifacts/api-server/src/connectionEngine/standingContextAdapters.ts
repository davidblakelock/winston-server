/**
 * Standing Context Adapters
 *
 * Phase 3 of the unified memory architecture. Goals aren't a recency-sorted
 * stream of dated events the way life_captures/attic_items/list_items are
 * (see memorySourceAdapters.ts's MemorySourceAdapter) — they're a small,
 * current set to check other saved items against. This file is that other
 * shape: standing context, not a stream.
 *
 * This is also the fix for the circular import that used to require a
 * dynamic import workaround in goalsManager.ts: connectionEngineManager.ts
 * used to import getGoals/getGoalById directly from goalsManager.ts, while
 * goalsManager.ts needed the reverse direction (Attic/Life/corrections
 * context) and could only get it via `await import(...)` at call time to
 * dodge the cycle. Moving connectionEngineManager.ts's goal-reading code
 * here means connectionEngineManager.ts now reaches goalsManager.ts through
 * this file instead of directly — goalsManager.ts never imports this file or
 * connectionEngineManager.ts, so the cycle is gone, not just worked around.
 *
 * Pure move, not a rewrite — fetchGoalContext/IndexedGoalContext are the
 * same code that lived in connectionEngineManager.ts, unchanged except for
 * gaining `export`. getGoalById is a straight re-export of goalsManager.ts's
 * own function — connectionEngineManager.ts's one other call site for it
 * (resolving a connection's target goal title) needed a source that wasn't
 * goalsManager.ts directly.
 */

import { getGoals, getGoalById, type Goal } from "../goals/goalsManager.js";
import { logger } from "../lib/logger.js";

export { getGoalById };

// A second context source alongside life_capture/attic_item/list_item — not
// merged into SourceItem[] since goals aren't a recency-sorted stream of
// things that happened, they're standing context to check saved items
// against. Indexed (not just prose) so dotConnectorPass/patternObservationPass
// can report back WHICH goal a suggestion connects to by position, the same
// "point at it, don't retype it" discipline used everywhere else — Claude
// picks an index, the server resolves the real goal id.
export interface IndexedGoalContext {
  text:  string;
  goals: Goal[];
}

const ACTIVE_GOALS_CAP = 20; // was a bare 8. Not a formula — just a more
// generous bound, with the truncation now logged instead of silent.

export async function fetchGoalContext(userName: string): Promise<IndexedGoalContext> {
  const goals = await getGoals(userName).catch(() => [] as Goal[]);
  // Active AND aspirational both count as "current" here — noticing a
  // connection to an aspirational goal is exactly the kind of nudge that
  // could promote it to active, not something to withhold until it is one.
  const allActive = goals.filter((g) => g.status !== "completed");
  if (allActive.length > ACTIVE_GOALS_CAP) {
    logger.info(
      { userName, activeCount: allActive.length, cap: ACTIVE_GOALS_CAP },
      "[StandingContext] Active goals exceed cap — truncating"
    );
  }
  const active = allActive.slice(0, ACTIVE_GOALS_CAP);
  if (active.length === 0) return { text: "", goals: [] };
  const lines = active
    .map((g, i) => {
      const done  = g.steps.filter((s) => s.completed).length;
      const total = g.steps.length;
      return `  [${i}] "${g.title}"${g.description ? ` — ${g.description}` : ""} (${total > 0 ? `${done}/${total} steps done` : "no steps yet"})`;
    })
    .join("\n");
  const text = `\nCurrent goals (indexed) — if a saved item below genuinely relates to one of these, report its ` +
    `index as relatedGoalIndex; don't force it:\n${lines}\n`;
  return { text, goals: active };
}
