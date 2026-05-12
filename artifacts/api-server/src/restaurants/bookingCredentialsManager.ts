import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Schema migration ──────────────────────────────────────────────────────────

export async function ensureBookingCredentialsColumns(): Promise<void> {
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS opentable_email    text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS opentable_password text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS resy_email         text`);
  await query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS resy_password      text`);
  logger.info("[BookingCreds] Columns ensured (opentable_email, opentable_password, resy_email, resy_password)");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BookingCredentials {
  openTableEmail:    string | null;
  openTablePassword: string | null;
  resyEmail:         string | null;
  resyPassword:      string | null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getBookingCredentials(userName: string): Promise<BookingCredentials> {
  const { rows } = await query<{
    opentable_email:    string | null;
    opentable_password: string | null;
    resy_email:         string | null;
    resy_password:      string | null;
  }>(
    `SELECT opentable_email, opentable_password, resy_email, resy_password
       FROM user_profiles
      WHERE user_name = $1
      LIMIT 1`,
    [userName]
  );
  if (rows.length === 0) {
    return { openTableEmail: null, openTablePassword: null, resyEmail: null, resyPassword: null };
  }
  const r = rows[0];
  return {
    openTableEmail:    r.opentable_email,
    openTablePassword: r.opentable_password,
    resyEmail:         r.resy_email,
    resyPassword:      r.resy_password,
  };
}

/** Returns which services have credentials set (never exposes passwords). */
export async function getBookingCredentialStatus(
  userName: string
): Promise<{ openTableConnected: boolean; resyConnected: boolean }> {
  const creds = await getBookingCredentials(userName);
  return {
    openTableConnected: !!(creds.openTableEmail && creds.openTablePassword),
    resyConnected:      !!(creds.resyEmail      && creds.resyPassword),
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function saveOpenTableCredentials(
  userName: string,
  email:    string,
  password: string
): Promise<void> {
  await query(
    `UPDATE user_profiles
        SET opentable_email    = $1,
            opentable_password = $2
      WHERE user_name = $3`,
    [email.trim(), password, userName]
  );
  logger.info({ userName }, "[BookingCreds] OpenTable credentials saved");
}

export async function saveResyCredentials(
  userName: string,
  email:    string,
  password: string
): Promise<void> {
  await query(
    `UPDATE user_profiles
        SET resy_email    = $1,
            resy_password = $2
      WHERE user_name = $3`,
    [email.trim(), password, userName]
  );
  logger.info({ userName }, "[BookingCreds] Resy credentials saved");
}

// ── Deletes ───────────────────────────────────────────────────────────────────

export async function clearOpenTableCredentials(userName: string): Promise<void> {
  await query(
    `UPDATE user_profiles
        SET opentable_email = NULL, opentable_password = NULL
      WHERE user_name = $1`,
    [userName]
  );
  logger.info({ userName }, "[BookingCreds] OpenTable credentials cleared");
}

export async function clearResyCredentials(userName: string): Promise<void> {
  await query(
    `UPDATE user_profiles
        SET resy_email = NULL, resy_password = NULL
      WHERE user_name = $1`,
    [userName]
  );
  logger.info({ userName }, "[BookingCreds] Resy credentials cleared");
}
