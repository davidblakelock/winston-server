import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Winston Mode ───────────────────────────────────────────────────────────────

export type WinstonMode = "autopilot" | "supervised" | "briefing_only";

// Backward-compat alias — callers importing ProactiveMode still compile without changes.
export type ProactiveMode = WinstonMode;

const VALID_MODES: readonly WinstonMode[] = ["autopilot", "supervised", "briefing_only"];

// Maps old proactive_mode DB values to the new Winston Mode values.
// Used on read (getProactiveMode) AND on the POST endpoint (legacy clients).
export const LEGACY_MODE_MAP: Record<string, WinstonMode> = {
  whisper:      "briefing_only",
  vacation:     "briefing_only",
  balanced:     "supervised",
  full_partner: "autopilot",
  full:         "autopilot",
};

export function isValidMode(m: unknown): m is WinstonMode {
  return typeof m === "string" && (VALID_MODES as readonly string[]).includes(m);
}

// ── Table setup ───────────────────────────────────────────────────────────────

export async function ensureProactiveModeTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_proactive_settings (
      user_name  text PRIMARY KEY,
      mode       text NOT NULL DEFAULT 'supervised',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Drop legacy digest_interval_minutes column if it exists (no longer used)
  await query(`ALTER TABLE user_proactive_settings DROP COLUMN IF EXISTS digest_interval_minutes`)
    .catch(() => {});
  // Migrate any legacy mode values that are still in the DB
  await query(`
    UPDATE user_proactive_settings
       SET mode = CASE
                    WHEN mode IN ('whisper', 'vacation') THEN 'briefing_only'
                    WHEN mode = 'balanced'               THEN 'supervised'
                    WHEN mode IN ('full_partner', 'full') THEN 'autopilot'
                    ELSE mode
                  END
     WHERE mode NOT IN ('autopilot', 'supervised', 'briefing_only')
  `);
  logger.info("[WinstonMode] Table ready, legacy values migrated");
}

// Alias — index.ts calls this name
export const ensureWinstonModeTable = ensureProactiveModeTable;

// ── Trusted Senders ───────────────────────────────────────────────────────────

export async function ensureTrustedSendersTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS trusted_senders (
      id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_name       text NOT NULL,
      email_or_domain text NOT NULL,
      name            text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Functional unique index (case-insensitive) — must be created separately from the table
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trusted_senders_user_email
      ON trusted_senders (user_name, lower(email_or_domain))
  `);
  logger.info("[WinstonMode] trusted_senders table ready");
}

export interface TrustedSender {
  id: number;
  emailOrDomain: string;
  name: string | null;
  createdAt: string;
}

export async function getTrustedSenders(userName: string): Promise<TrustedSender[]> {
  const { rows } = await query<{
    id: number; email_or_domain: string; name: string | null; created_at: string;
  }>(
    `SELECT id, email_or_domain, name, created_at
       FROM trusted_senders WHERE user_name = $1 ORDER BY created_at ASC`,
    [userName]
  );
  return rows.map((r) => ({
    id: r.id,
    emailOrDomain: r.email_or_domain,
    name: r.name,
    createdAt: r.created_at,
  }));
}

export async function addTrustedSender(
  userName: string,
  emailOrDomain: string,
  name?: string
): Promise<TrustedSender> {
  const { rows } = await query<{
    id: number; email_or_domain: string; name: string | null; created_at: string;
  }>(
    `INSERT INTO trusted_senders (user_name, email_or_domain, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_name, lower(email_or_domain)) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, email_or_domain, name, created_at`,
    [userName, emailOrDomain.toLowerCase().trim(), name ?? null]
  );
  const row = rows[0]!;
  logger.info({ userName, emailOrDomain }, "[WinstonMode] Trusted sender added");
  return { id: row.id, emailOrDomain: row.email_or_domain, name: row.name, createdAt: row.created_at };
}

export async function removeTrustedSender(userName: string, id: number): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM trusted_senders WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

export async function isTrustedSender(userName: string, emailOrDomain: string): Promise<boolean> {
  const emailLower = emailOrDomain.toLowerCase();
  const domainPart = emailLower.includes("@") ? (emailLower.split("@")[1] ?? "") : emailLower;
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM trusted_senders
      WHERE user_name = $1 AND (lower(email_or_domain) = $2 OR lower(email_or_domain) = $3)
      LIMIT 1`,
    [userName, emailLower, domainPart]
  );
  return rows.length > 0;
}

// ── Push notification category matrix ─────────────────────────────────────────
//
//   "always"         — sent in ALL modes (safety-critical, morning briefing, urgent)
//   "time-sensitive" — suppressed in briefing_only; sent in supervised + autopilot
//   "proactive"      — sent only in autopilot

const NOTIFICATION_CATEGORY_MAP: Record<string, "always" | "time-sensitive" | "proactive"> = {
  "morning-briefing": "always",
  "medication":       "always",
  "weather-alert":    "always",
  "order-update":     "always",    // package delivered / out-for-delivery
  "bill-anomaly":     "always",    // unusual charge detected
  "flight-cancel":    "always",    // flight cancelled
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
 * Returns true if a push notification should be sent given the user's Winston Mode,
 * the notification type, and whether the notification is for/from a VIP.
 *
 * Mode matrix:
 *   briefing_only — always + VIP override only (minimal interruptions)
 *   supervised    — always + time-sensitive + VIP override
 *   autopilot     — always + time-sensitive + proactive + VIP override
 */
export function shouldSendPushForMode(
  mode: WinstonMode,
  notificationType: string | undefined,
  isVip = false
): boolean {
  if (isVip) return true;
  const category = NOTIFICATION_CATEGORY_MAP[notificationType ?? ""] ?? "time-sensitive";
  if (category === "always") return true;
  if (mode === "briefing_only") return false;
  if (category === "time-sensitive") return true;
  return mode === "autopilot";
}

// ── Mode persistence ──────────────────────────────────────────────────────────

export async function getProactiveMode(userName: string): Promise<WinstonMode> {
  try {
    const { rows } = await query<{ mode: string }>(
      `SELECT mode FROM user_proactive_settings WHERE user_name = $1`,
      [userName]
    );
    const raw = rows[0]?.mode;
    if (!raw) return "supervised";
    if (raw in LEGACY_MODE_MAP) return LEGACY_MODE_MAP[raw]!;
    if (isValidMode(raw)) return raw;
    return "supervised";
  } catch {
    return "supervised";
  }
}

export const getWinstonMode = getProactiveMode;

export async function setProactiveMode(userName: string, mode: WinstonMode): Promise<void> {
  await query(
    `INSERT INTO user_proactive_settings (user_name, mode, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_name) DO UPDATE SET mode = $2, updated_at = now()
     RETURNING user_name`,
    [userName, mode]
  );
  logger.info({ userName, mode }, "[WinstonMode] Mode updated");
}

export const setWinstonMode = setProactiveMode;

// ── Email scan intervals ──────────────────────────────────────────────────────
//
//   autopilot     — every 15 min   (most proactive)
//   supervised    — every 30 min
//   briefing_only — every 2 hours  (minimal interruptions)

export function getModeEmailIntervalMs(mode: WinstonMode): number {
  switch (mode) {
    case "autopilot":     return  15 * 60 * 1000;
    case "supervised":    return  30 * 60 * 1000;
    case "briefing_only": return 120 * 60 * 1000;
  }
}

// ── Briefing mode instructions ────────────────────────────────────────────────

export function buildModeInstruction(mode: WinstonMode, firstName: string): string {
  switch (mode) {
    case "briefing_only":
      return `\n\n[WINSTON MODE: BRIEFING ONLY]\nKeep this briefing minimal. 3–4 sentences total — calendar and critical alerts only. Skip news, sports, entertainment, local content, health, and anything non-essential. Lead with the single most important thing for ${firstName}'s day. No closing thought. No My Day invite. Just the essentials.`;

    case "supervised":
      return "";

    case "autopilot":
      return `\n\n[WINSTON MODE: AUTOPILOT]\nDeliver the full briefing as normal, and additionally weave in any [Cross-Domain Intelligence] insights naturally into the narrative — these are connections James Bond has noticed between ${firstName}'s calendar, health, relationships, and tasks. Surface relationship nudges warmly and specifically. Flag any schedule risks plainly. The briefing should feel like a highly-informed advisor who sees across all domains of ${firstName}'s life.`;
  }
}
