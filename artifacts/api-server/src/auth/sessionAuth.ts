import crypto from "crypto";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getAppUrl(_reqHost?: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0].trim()}`;
  return "https://winston-companion--davidblakelock.replit.app";
}

export interface SessionUser {
  userName: string;
  email: string;
  googleId?: string;
  isNewUser?: boolean;
}

// ── Google user lookup / creation ─────────────────────────────────────────────

export async function lookupOrCreateGoogleUser(
  googleId: string,
  email: string,
  name: string
): Promise<{ userName: string; isNewUser: boolean }> {
  // 1. Look up google_users by google_id
  const { rows: existing } = await query<{ user_name: string; is_new_user: boolean }>(
    "SELECT user_name, is_new_user FROM google_users WHERE google_id = $1",
    [googleId]
  );

  let userName: string;

  if (existing.length > 0) {
    userName = existing[0].user_name;
    // Clear the first-sign-in flag
    if (existing[0].is_new_user) {
      await query("UPDATE google_users SET is_new_user = false WHERE google_id = $1", [googleId]);
    }
  } else {
    // Brand-new Google user — derive userName from first name
    const firstName = name.split(" ")[0] || "Friend";
    userName = firstName;

    await query(
      `INSERT INTO google_users (google_id, email, name, user_name, is_new_user)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (google_id) DO NOTHING`,
      [googleId, email, name, firstName]
    );

    logger.info({ googleId, email, userName }, "New Google user created");
  }

  // 2. Source of truth for "new vs returning" is whether a COMPLETED profile exists.
  //    A user might have a magic-link profile already — they should go straight to chat.
  const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
    "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
    [userName]
  );

  const hasCompletedProfile =
    profileRows.length > 0 && profileRows[0].onboarding_completed === true;

  logger.info({ googleId, userName, hasCompletedProfile }, "Google user resolved");
  return { userName, isNewUser: !hasCompletedProfile };
}

// ── App sessions ──────────────────────────────────────────────────────────────

export async function createSession(
  userName: string,
  email: string,
  googleId?: string
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  if (googleId) {
    await query(
      `INSERT INTO app_sessions (user_name, email, token, expires_at, google_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userName, email, token, expiresAt, googleId]
    );
  } else {
    await query(
      "INSERT INTO app_sessions (user_name, email, token, expires_at) VALUES ($1, $2, $3, $4)",
      [userName, email, token, expiresAt]
    );
  }

  logger.info({ userName, email }, "App session created");
  return token;
}

export async function validateSession(
  token: string
): Promise<SessionUser | null> {
  const { rows } = await query<{ user_name: string; email: string; google_id: string | null }>(
    "SELECT user_name, email, google_id FROM app_sessions WHERE token = $1 AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) return null;
  return {
    userName: rows[0].user_name,
    email: rows[0].email,
    googleId: rows[0].google_id ?? undefined,
  };
}

export async function revokeSession(token: string): Promise<void> {
  await query("DELETE FROM app_sessions WHERE token = $1", [token]);
}

// ── Legacy magic-link support (kept for backwards compat) ─────────────────────

export async function createMagicLink(email: string): Promise<{ token: string; email: string } | null> {
  const ALLOWED = ["davidblakelock.winston@gmail.com"];
  const normalized = email.trim().toLowerCase();
  if (!ALLOWED.includes(normalized)) return null;

  await query(
    "UPDATE magic_link_tokens SET used_at = NOW() WHERE email = $1 AND used_at IS NULL",
    [normalized]
  );

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await query(
    "INSERT INTO magic_link_tokens (email, token, expires_at) VALUES ($1, $2, $3)",
    [normalized, token, expiresAt]
  );

  return { token, email: normalized };
}

export async function verifyMagicLink(token: string): Promise<SessionUser | null> {
  const { rows } = await query<{ id: number; email: string }>(
    "SELECT id, email FROM magic_link_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) return null;
  await query("UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1", [rows[0].id]);
  return { userName: "David", email: rows[0].email };
}

export async function sendMagicLinkEmail(email: string, magicLinkUrl: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Winston <noreply@winston.app>",
        to: [email],
        subject: "Your Winston sign-in link",
        html: `<a href="${magicLinkUrl}">Sign in to Winston</a>`,
      }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err }, "Failed to send magic link email");
    return false;
  }
}
