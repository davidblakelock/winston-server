import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Ensures the booking-related schema is up to date.
 *   - Adds booking_phone to user_profiles (contact phone for reservations)
 *   - Drops old credential columns (opentable_email/password, resy_email/password)
 *   - Creates resy_sessions table for 14-day session storage
 */
export async function ensureBookingColumns(): Promise<void> {
  // New: booking contact phone on user_profiles
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS booking_phone text`);

  // Remove old credential columns — no longer stored
  await query(`ALTER TABLE user_profiles DROP COLUMN IF EXISTS opentable_email`);
  await query(`ALTER TABLE user_profiles DROP COLUMN IF EXISTS opentable_password`);
  await query(`ALTER TABLE user_profiles DROP COLUMN IF EXISTS resy_email`);
  await query(`ALTER TABLE user_profiles DROP COLUMN IF EXISTS resy_password`);

  // Resy session tokens (14-day expiry)
  await query(`
    CREATE TABLE IF NOT EXISTS resy_sessions (
      user_name  text PRIMARY KEY,
      token      text NOT NULL,
      email      text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  logger.info("[Booking] Schema ensured (booking_phone, resy_sessions)");
}

// ── Resy session management ───────────────────────────────────────────────────

export interface ResySession {
  token: string;
  email: string;
}

/** Returns a valid Resy session token, or null if none / expired. */
export async function getResySession(userName: string): Promise<ResySession | null> {
  try {
    const { rows } = await query<{
      token: string; email: string; expires_at: string;
    }>(
      `SELECT token, email, expires_at FROM resy_sessions WHERE user_name = $1 LIMIT 1`,
      [userName]
    );
    if (!rows[0]) return null;
    if (new Date(rows[0].expires_at) < new Date()) {
      await clearResySession(userName);
      return null;
    }
    return { token: rows[0].token, email: rows[0].email };
  } catch {
    return null;
  }
}

/** Persists a Resy session token for 14 days. */
export async function saveResySession(
  userName: string,
  token:    string,
  email:    string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO resy_sessions (user_name, token, email, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_name) DO UPDATE
       SET token = $2, email = $3, expires_at = $4, created_at = NOW()`,
    [userName, token, email, expiresAt.toISOString()]
  );
  logger.info({ userName }, "[Booking] Resy session saved (14 days)");
}

/** Removes a stored Resy session (logout / force re-auth). */
export async function clearResySession(userName: string): Promise<void> {
  await query(`DELETE FROM resy_sessions WHERE user_name = $1`, [userName]);
  logger.info({ userName }, "[Booking] Resy session cleared");
}
