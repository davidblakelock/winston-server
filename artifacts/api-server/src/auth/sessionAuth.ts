import crypto from "crypto";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getAppUrl(_reqHost?: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0].trim()}`;
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  return "https://winston-companion--davidblakelock.replit.app";
}

export interface SessionUser {
  userName: string;
  email: string;
  googleId?: string;
  isNewUser?: boolean;
}

// ── Username generation ────────────────────────────────────────────────────────
// Finds a username not already claimed in user_profiles

async function generateUniqueUsername(base: string): Promise<string> {
  const clean = base.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || "User";
  const { rows } = await query<{ user_name: string }>(
    "SELECT user_name FROM user_profiles WHERE user_name = $1 LIMIT 1",
    [clean]
  );
  if (rows.length === 0) return clean;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${clean}${i}`;
    const { rows: r } = await query<{ user_name: string }>(
      "SELECT user_name FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [candidate]
    );
    if (r.length === 0) return candidate;
  }
  return `${clean}_${Date.now()}`;
}

// ── Email → existing user lookup ──────────────────────────────────────────────
// Checks app_sessions first, then google_auth as fallback.
// Returns the userName and whether onboarding is complete, or null if not found.

async function findExistingUserByEmail(
  email: string
): Promise<{ userName: string; isNewUser: boolean } | null> {
  const normalized = email.trim().toLowerCase();

  // 1. Try app_sessions (most reliable — every sign-in writes here)
  const { rows: sessionRows } = await query<{ user_name: string }>(
    "SELECT user_name FROM app_sessions WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1",
    [normalized]
  );

  // 2. Fall back to google_auth (has email for every Google OAuth user)
  let userName: string | null = null;
  if (sessionRows.length > 0) {
    userName = sessionRows[0].user_name;
  } else {
    const { rows: gaRows } = await query<{ user_name: string }>(
      "SELECT user_name FROM google_auth WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [normalized]
    );
    if (gaRows.length > 0) {
      userName = gaRows[0].user_name;
      logger.info({ email: normalized, userName }, "Email resolved via google_auth fallback");
    }
  }

  if (!userName) return null;

  const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
    "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
    [userName]
  );
  const hasCompletedProfile =
    profileRows.length > 0 && profileRows[0].onboarding_completed === true;
  return { userName, isNewUser: !hasCompletedProfile };
}

// ── Google user lookup / creation ─────────────────────────────────────────────

export async function lookupOrCreateGoogleUser(
  googleId: string,
  email: string,
  name: string
): Promise<{ userName: string; isNewUser: boolean }> {
  // 1. Known Google ID → returning user, look up their stored username
  const { rows: existing } = await query<{ user_name: string; is_new_user: boolean }>(
    "SELECT user_name, is_new_user FROM google_users WHERE google_id = $1",
    [googleId]
  );

  if (existing.length > 0) {
    const userName = existing[0].user_name;
    if (existing[0].is_new_user) {
      await query("UPDATE google_users SET is_new_user = false WHERE google_id = $1", [googleId]);
    }
    const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
      "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [userName]
    );
    const hasCompletedProfile =
      profileRows.length > 0 && profileRows[0].onboarding_completed === true;
    logger.info({ googleId, userName, hasCompletedProfile }, "Google user resolved");
    return { userName, isNewUser: !hasCompletedProfile };
  }

  // 2. New Google ID — use email to find an existing account (e.g. prior magic-link sign-in)
  const prior = await findExistingUserByEmail(email);

  let userName: string;
  let isNewUser: boolean;

  if (prior) {
    // Email recognised — link this Google account to the same user
    userName = prior.userName;
    isNewUser = prior.isNewUser;
    logger.info({ googleId, email, userName }, "Google account linked to existing user");
  } else {
    // Truly new email — never seen before → always go to onboarding
    const firstName = name.split(" ")[0] || "Friend";
    userName = await generateUniqueUsername(firstName);
    isNewUser = true;
    logger.info({ googleId, email, userName }, "New Google user created");
  }

  await query(
    `INSERT INTO google_users (google_id, email, name, user_name, is_new_user)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (google_id) DO NOTHING`,
    [googleId, email, name, userName, isNewUser]
  );

  logger.info({ googleId, userName, isNewUser }, "Google user resolved");
  return { userName, isNewUser };
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

// ── Magic-link support ────────────────────────────────────────────────────────
// Any email address can request a magic link (no allowlist).
// New email → isNewUser=true → onboarding after clicking link.
// Returning email → isNewUser=false → straight to chat.

export async function createMagicLink(
  email: string
): Promise<{ token: string; email: string; isNewUser: boolean } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;

  // Determine new vs returning by checking prior sessions for this email
  const prior = await findExistingUserByEmail(normalized);
  const isNewUser = prior === null || prior.isNewUser;

  // Invalidate any unused previous tokens for this email
  await query(
    "UPDATE magic_link_tokens SET used_at = NOW() WHERE email = $1 AND used_at IS NULL",
    [normalized]
  );

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  await query(
    "INSERT INTO magic_link_tokens (email, token, expires_at) VALUES ($1, $2, $3)",
    [normalized, token, expiresAt]
  );

  return { token, email: normalized, isNewUser };
}

export async function verifyMagicLink(
  token: string
): Promise<(SessionUser & { isNewUser: boolean }) | null> {
  const { rows } = await query<{ id: number; email: string }>(
    "SELECT id, email FROM magic_link_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) return null;
  const email = rows[0].email;
  await query("UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1", [rows[0].id]);

  // Find existing user by email or create a new unique username
  const prior = await findExistingUserByEmail(email);
  let userName: string;
  let isNewUser: boolean;

  if (prior) {
    userName = prior.userName;
    isNewUser = prior.isNewUser;
  } else {
    const emailPrefix = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "") || "User";
    userName = await generateUniqueUsername(emailPrefix);
    isNewUser = true;
  }

  return { userName, email, isNewUser };
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
        html: `<p>Click the link below to sign in to Winston:</p>
               <p><a href="${magicLinkUrl}" style="color:#4f46e5">Sign in to Winston</a></p>
               <p style="color:#999;font-size:12px">This link expires in 30 minutes.</p>`,
      }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err }, "Failed to send magic link email");
    return false;
  }
}
