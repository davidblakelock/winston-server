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
  await query(`
    ALTER TABLE user_proactive_settings
    ADD COLUMN IF NOT EXISTS digest_interval_minutes integer NOT NULL DEFAULT 120
  `);
  logger.info("[ProactiveMode] Table ready");
}

const DEFAULT_DIGEST_INTERVAL = 120;
const MIN_DIGEST_INTERVAL = 15;
const MAX_DIGEST_INTERVAL = 1440;

export async function getDigestInterval(userName: string): Promise<number> {
  try {
    const { rows } = await query<{ digest_interval_minutes: number }>(
      `SELECT digest_interval_minutes FROM user_proactive_settings WHERE user_name = $1`,
      [userName]
    );
    const val = rows[0]?.digest_interval_minutes;
    if (typeof val === "number" && val >= MIN_DIGEST_INTERVAL) return val;
    return DEFAULT_DIGEST_INTERVAL;
  } catch {
    return DEFAULT_DIGEST_INTERVAL;
  }
}

export async function setDigestInterval(userName: string, minutes: number): Promise<void> {
  await query(
    `INSERT INTO user_proactive_settings (user_name, digest_interval_minutes, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_name) DO UPDATE SET digest_interval_minutes = $2, updated_at = now()`,
    [userName, minutes]
  );
  logger.info({ userName, minutes }, "[DigestInterval] Interval updated");
}

// ── Digest interval derived from mode ─────────────────────────────────────────

export function getIntervalForMode(mode: ProactiveMode): number {
  switch (mode) {
    case "whisper":  return 240; // 4 hours
    case "balanced": return 120; // 2 hours
    case "full":     return 60;  // 1 hour
    case "vacation": return 30;  // 30 minutes
  }
}

// ── Push notification categories ───────────────────────────────────────────────
//   "always"         — sent in ALL modes (safety-critical, morning briefing)
//   "time-sensitive" — suppressed in whisper; sent in balanced, full, vacation
//   "proactive"      — sent only in full and vacation

const NOTIFICATION_CATEGORY_MAP: Record<string, "always" | "time-sensitive" | "proactive"> = {
  "morning-briefing": "always",
  "medication":       "always",
  "weather-alert":    "always",
  "digest":           "always",        // interval itself is mode-controlled
  "departure":        "time-sensitive",
  "reminder":         "time-sensitive",
  "bill-reminder":    "time-sensitive",
  "date-reminder":    "time-sensitive",
  "winddown":         "time-sensitive",
  "contact-reminder": "time-sensitive",
  "connect-accepted": "time-sensitive",
  "connect-message":  "time-sensitive",
  "connect-reminder": "time-sensitive",
  "calendar-update":  "time-sensitive",
  "geofence-shopping":"proactive",
  "list-sync":        "proactive",
  "pickleball":       "proactive",
};

/**
 * Returns true if a push notification should be sent given the user's proactive
 * mode, the notification type, and whether the notification is for/from a VIP.
 *
 * Mode matrix:
 *   whisper  — always only (medication, weather-alert, morning-briefing)
 *   balanced — always + time-sensitive
 *   full     — always + time-sensitive + proactive
 *   vacation — always + time-sensitive + proactive
 */
export function shouldSendPushForMode(
  mode: ProactiveMode,
  notificationType: string | undefined,
  isVip = false
): boolean {
  if (isVip) return true; // VIP contacts always bypass the mode gate
  const category = NOTIFICATION_CATEGORY_MAP[notificationType ?? ""] ?? "time-sensitive";
  if (category === "always") return true;
  if (mode === "whisper") return false;         // whisper: only "always" passes
  if (category === "time-sensitive") return true; // balanced/full/vacation: time-sensitive passes
  return mode === "full" || mode === "vacation";  // proactive: full/vacation only
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
