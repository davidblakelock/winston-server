import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export type ProactiveMode = "whisper" | "balanced" | "full" | "vacation";

const VALID_MODES: readonly ProactiveMode[] = ["whisper", "balanced", "full", "vacation"];

export function isValidMode(m: unknown): m is ProactiveMode {
  return typeof m === "string" && (VALID_MODES as readonly string[]).includes(m);
}

export async function ensureProactiveModeTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_proactive_settings (
      user_name  text PRIMARY KEY,
      mode       text NOT NULL DEFAULT 'balanced',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  logger.info("[ProactiveMode] Table ready");
}

export async function getProactiveMode(userName: string): Promise<ProactiveMode> {
  try {
    const { rows } = await query<{ mode: string }>(
      `SELECT mode FROM user_proactive_settings WHERE user_name = $1`,
      [userName]
    );
    if (rows[0] && isValidMode(rows[0].mode)) return rows[0].mode;
    return "balanced";
  } catch {
    return "balanced";
  }
}

export async function setProactiveMode(userName: string, mode: ProactiveMode): Promise<void> {
  await query(
    `INSERT INTO user_proactive_settings (user_name, mode, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_name) DO UPDATE SET mode = $2, updated_at = now()
     RETURNING user_name`,
    [userName, mode]
  );
  logger.info({ userName, mode }, "[ProactiveMode] Mode updated");
}

export function buildModeInstruction(mode: ProactiveMode, firstName: string): string {
  switch (mode) {
    case "whisper":
      return `\n\n[PROACTIVE MODE: WHISPER]\nKeep this briefing minimal. 3–4 sentences total — calendar and critical alerts only. Skip news, sports, entertainment, local content, health, and anything non-essential. Lead with the single most important thing for ${firstName}'s day. No closing thought. No My Day invite. Just the essentials.`;

    case "balanced":
      return "";

    case "full":
      return `\n\n[PROACTIVE MODE: FULL PARTNER]\nDeliver the full briefing as normal, and additionally weave in any [Cross-Domain Intelligence] insights naturally into the narrative — these are connections James Bond has noticed between ${firstName}'s calendar, health, relationships, and tasks. Surface relationship nudges warmly and specifically. Flag any schedule risks plainly. The briefing should feel like a highly-informed advisor who sees across all domains of ${firstName}'s life.`;

    case "vacation":
      return `\n\n[PROACTIVE MODE: VACATION]\nDeliver the full briefing with maximum intelligence. Include all [Cross-Domain Intelligence] insights. Proactively suggest handling routine items — for example: "I can draft a reply to that meeting request," "Want me to add that flight to your calendar," "I can send Susan a reminder about Saturday." Be maximally helpful and anticipate ${firstName}'s needs across every domain. Suggest automatic responses where appropriate.`;
  }
}
