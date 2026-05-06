import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export interface FocusModeState {
  enabled: boolean;
  enabledAt: string | null;
  durationMinutes: number | null;
  endsAt: string | null;
}

export async function ensureFocusModeTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS focus_mode_state (
      user_name        text PRIMARY KEY,
      enabled          boolean NOT NULL DEFAULT false,
      enabled_at       timestamptz,
      duration_minutes integer,
      ends_at          timestamptz
    )
  `);
  logger.info("[FocusMode] focus_mode_state table ready");
}

export async function getFocusMode(userName: string): Promise<FocusModeState> {
  try {
    const { rows } = await query<{
      enabled: boolean;
      enabled_at: string | null;
      duration_minutes: number | null;
      ends_at: string | null;
    }>(
      `SELECT enabled, enabled_at, duration_minutes, ends_at
       FROM focus_mode_state WHERE user_name = $1`,
      [userName]
    );

    if (!rows[0]) return { enabled: false, enabledAt: null, durationMinutes: null, endsAt: null };

    const r = rows[0];
    let enabled = r.enabled;

    if (enabled && r.ends_at && new Date(r.ends_at) < new Date()) {
      await disableFocusMode(userName);
      enabled = false;
    }

    return {
      enabled,
      enabledAt: r.enabled_at,
      durationMinutes: r.duration_minutes,
      endsAt: r.ends_at,
    };
  } catch {
    return { enabled: false, enabledAt: null, durationMinutes: null, endsAt: null };
  }
}

export async function enableFocusMode(userName: string, durationMinutes?: number): Promise<FocusModeState> {
  const now = new Date();
  const endsAt = durationMinutes ? new Date(now.getTime() + durationMinutes * 60_000) : null;

  await query(
    `INSERT INTO focus_mode_state (user_name, enabled, enabled_at, duration_minutes, ends_at)
     VALUES ($1, true, $2, $3, $4)
     ON CONFLICT (user_name) DO UPDATE
       SET enabled = true, enabled_at = $2, duration_minutes = $3, ends_at = $4
     RETURNING user_name`,
    [userName, now.toISOString(), durationMinutes ?? null, endsAt?.toISOString() ?? null]
  );

  logger.info({ userName, durationMinutes, endsAt }, "[FocusMode] Focus mode enabled");
  return { enabled: true, enabledAt: now.toISOString(), durationMinutes: durationMinutes ?? null, endsAt: endsAt?.toISOString() ?? null };
}

export async function disableFocusMode(userName: string): Promise<void> {
  await query(
    `INSERT INTO focus_mode_state (user_name, enabled, enabled_at, duration_minutes, ends_at)
     VALUES ($1, false, null, null, null)
     ON CONFLICT (user_name) DO UPDATE
       SET enabled = false, enabled_at = null, duration_minutes = null, ends_at = null
     RETURNING user_name`,
    [userName]
  );
  logger.info({ userName }, "[FocusMode] Focus mode disabled");
}
