import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export type ProactiveMode = "whisper" | "balanced" | "full_partner" | "vacation";

const VALID_MODES: readonly ProactiveMode[] = ["whisper", "balanced", "full_partner", "vacation"];

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

// ── Push notification categories ───────────────────────────────────────────────
//   "always"         — sent in ALL modes (safety-critical, morning briefing, urgent)
//   "time-sensitive" — suppressed in whisper/vacation; sent in balanced, full_partner
//   "proactive"      — sent only in full_partner

const NOTIFICATION_CATEGORY_MAP: Record<string, "always" | "time-sensitive" | "proactive"> = {
  "morning-briefing": "always",
  "medication":       "always",
  "weather-alert":    "always",
  "order-update":     "always",   // package delivered / out-for-delivery
  "bill-anomaly":     "always",   // unusual charge detected
  "flight-cancel":    "always",   // flight cancelled
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
 *   whisper      — always only + VIP override
 *   balanced     — always + time-sensitive + VIP override
 *   full_partner — always + time-sensitive + proactive + VIP override
 *   vacation     — always + VIP override only (no proactive interruptions; silent mode)
 */
export function shouldSendPushForMode(
  mode: ProactiveMode,
  notificationType: string | undefined,
  isVip = false
): boolean {
  if (isVip) return true;
  const category = NOTIFICATION_CATEGORY_MAP[notificationType ?? ""] ?? "time-sensitive";
  if (category === "always") return true;
  if (mode === "whisper" || mode === "vacation") return false;
  if (category === "time-sensitive") return true;
  return mode === "full_partner";
}

export async function getProactiveMode(userName: string): Promise<ProactiveMode> {
  try {
    const { rows } = await query<{ mode: string }>(
      `SELECT mode FROM user_proactive_settings WHERE user_name = $1`,
      [userName]
    );
    const raw = rows[0]?.mode;
    if (!raw) return "balanced";
    // Migrate legacy "full" value written before the rename
    if (raw === "full") return "full_partner";
    if (isValidMode(raw)) return raw;
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

/**
 * Returns the background email scan interval in milliseconds for a given mode.
 *
 *   whisper      — every 2 hours  (120 min)
 *   balanced     — every 1 hour   ( 60 min)
 *   full_partner — every 30 min   ( 30 min)
 *   vacation     — every 4 hours  (240 min)
 */
export function getModeEmailIntervalMs(mode: ProactiveMode): number {
  switch (mode) {
    case "whisper":      return 120 * 60 * 1000;
    case "balanced":     return  60 * 60 * 1000;
    case "full_partner": return  30 * 60 * 1000;
    case "vacation":     return 240 * 60 * 1000;
  }
}

export function buildModeInstruction(mode: ProactiveMode, firstName: string): string {
  switch (mode) {
    case "whisper":
      return `\n\n[PROACTIVE MODE: WHISPER]\nKeep this briefing minimal. 3–4 sentences total — calendar and critical alerts only. Skip news, sports, entertainment, local content, health, and anything non-essential. Lead with the single most important thing for ${firstName}'s day. No closing thought. No My Day invite. Just the essentials.`;

    case "balanced":
      return "";

    case "full_partner":
      return `\n\n[PROACTIVE MODE: FULL PARTNER]\nDeliver the full briefing as normal, and additionally weave in any [Cross-Domain Intelligence] insights naturally into the narrative — these are connections James Bond has noticed between ${firstName}'s calendar, health, relationships, and tasks. Surface relationship nudges warmly and specifically. Flag any schedule risks plainly. The briefing should feel like a highly-informed advisor who sees across all domains of ${firstName}'s life.`;

    case "vacation":
      return `\n\n[PROACTIVE MODE: VACATION]\n${firstName} is on vacation and wants minimal interruptions. Keep this briefing extremely brief — 2–3 sentences maximum. Mention only what is genuinely critical (a VIP contact reaching out, a safety alert, something that truly cannot wait). Skip news, sports, calendar details, bills, health data, entertainment, and all proactive suggestions. No closing thought. No My Day invite. If nothing critical exists, say exactly: "All clear — enjoy your vacation." Then stop.`;
  }
}
