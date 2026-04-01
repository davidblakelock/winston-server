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
  picture?: string;
  fullName?: string;
}

// ── Username generation ────────────────────────────────────────────────────────

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

async function findExistingUserByEmail(
  email: string
): Promise<{ userName: string; isNewUser: boolean } | null> {
  const normalized = email.trim().toLowerCase();

  logger.info({ email: normalized }, "[AUTH] findExistingUserByEmail — querying app_sessions");

  // 1. Try app_sessions (most reliable — every sign-in writes here)
  const { rows: sessionRows } = await query<{ user_name: string }>(
    "SELECT user_name FROM app_sessions WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1",
    [normalized]
  );

  logger.info(
    { email: normalized, sessionRowsFound: sessionRows.length, userName: sessionRows[0]?.user_name ?? null },
    "[AUTH] findExistingUserByEmail — app_sessions result"
  );

  // 2. Fall back to google_auth (has email for every Google OAuth user)
  let userName: string | null = null;
  if (sessionRows.length > 0) {
    userName = sessionRows[0].user_name;
    logger.info({ email: normalized, userName }, "[AUTH] findExistingUserByEmail — resolved via app_sessions");
  } else {
    logger.info({ email: normalized }, "[AUTH] findExistingUserByEmail — no session row, trying google_auth");
    const { rows: gaRows } = await query<{ user_name: string }>(
      "SELECT user_name FROM google_auth WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [normalized]
    );
    logger.info(
      { email: normalized, gaRowsFound: gaRows.length, userName: gaRows[0]?.user_name ?? null },
      "[AUTH] findExistingUserByEmail — google_auth result"
    );
    if (gaRows.length > 0) {
      userName = gaRows[0].user_name;
      logger.info({ email: normalized, userName }, "[AUTH] findExistingUserByEmail — resolved via google_auth fallback");
    }
  }

  if (!userName) {
    logger.info({ email: normalized }, "[AUTH] findExistingUserByEmail — no existing user found, returning null");
    return null;
  }

  const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
    "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
    [userName]
  );

  const hasCompletedProfile =
    profileRows.length > 0 && profileRows[0].onboarding_completed === true;

  logger.info(
    {
      email: normalized,
      userName,
      profileRowsFound: profileRows.length,
      onboardingCompleted: profileRows[0]?.onboarding_completed ?? "NO ROW",
      hasCompletedProfile,
      isNewUser: !hasCompletedProfile,
    },
    "[AUTH] findExistingUserByEmail — profile lookup result"
  );

  return { userName, isNewUser: !hasCompletedProfile };
}

// ── Google user lookup / creation ─────────────────────────────────────────────

export async function lookupOrCreateGoogleUser(
  googleId: string,
  email: string,
  name: string,
  picture?: string
): Promise<{ userName: string; isNewUser: boolean }> {
  logger.info(
    { googleId, email, name },
    "[AUTH] lookupOrCreateGoogleUser — START (full Google ID logged)"
  );

  // 1. Known Google ID → returning user, look up their stored username
  logger.info({ googleId }, "[AUTH] lookupOrCreateGoogleUser — querying google_users by googleId");

  const { rows: existing } = await query<{ user_name: string; is_new_user: boolean }>(
    "SELECT user_name, is_new_user FROM google_users WHERE google_id = $1",
    [googleId]
  );

  logger.info(
    { googleId, rowsFound: existing.length, storedUserName: existing[0]?.user_name ?? null },
    "[AUTH] lookupOrCreateGoogleUser — google_users lookup result"
  );

  if (existing.length > 0) {
    const userName = existing[0].user_name;
    logger.info({ googleId, userName }, "[AUTH] lookupOrCreateGoogleUser — KNOWN Google ID, using stored userName");

    if (picture) {
      await query("UPDATE google_users SET picture = $2 WHERE google_id = $1", [googleId, picture]);
    }

    if (existing[0].is_new_user) {
      await query("UPDATE google_users SET is_new_user = false WHERE google_id = $1", [googleId]);
      logger.info({ googleId, userName }, "[AUTH] lookupOrCreateGoogleUser — cleared is_new_user flag");
    }

    logger.info({ googleId, userName }, "[AUTH] lookupOrCreateGoogleUser — querying user_profiles for onboarding status");
    const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
      "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [userName]
    );

    const hasCompletedProfile =
      profileRows.length > 0 && profileRows[0].onboarding_completed === true;

    logger.info(
      {
        googleId,
        userName,
        profileRowsFound: profileRows.length,
        onboardingCompleted: profileRows[0]?.onboarding_completed ?? "NO ROW",
        hasCompletedProfile,
        isNewUser: !hasCompletedProfile,
      },
      "[AUTH] lookupOrCreateGoogleUser — KNOWN user profile result"
    );

    return { userName, isNewUser: !hasCompletedProfile };
  }

  // 2. New Google ID — use email to find an existing account (e.g. prior magic-link sign-in)
  logger.info(
    { googleId, email },
    "[AUTH] lookupOrCreateGoogleUser — NEW Google ID, checking for existing account by email"
  );

  const prior = await findExistingUserByEmail(email);

  logger.info(
    { googleId, email, priorFound: prior !== null, priorUserName: prior?.userName ?? null, priorIsNewUser: prior?.isNewUser ?? null },
    "[AUTH] lookupOrCreateGoogleUser — email lookup result"
  );

  let userName: string;
  let isNewUser: boolean;

  if (prior) {
    // Email recognised — link this Google account to the same user
    userName = prior.userName;
    isNewUser = prior.isNewUser;
    logger.info({ googleId, email, userName, isNewUser }, "[AUTH] lookupOrCreateGoogleUser — linking to EXISTING user account");
  } else {
    // Truly new email — never seen before → always go to onboarding
    const firstName = name.split(" ")[0] || "Friend";
    userName = await generateUniqueUsername(firstName);
    isNewUser = true;
    logger.info({ googleId, email, userName, firstName }, "[AUTH] lookupOrCreateGoogleUser — BRAND NEW user, generated userName");
  }

  logger.info({ googleId, email, userName, isNewUser }, "[AUTH] lookupOrCreateGoogleUser — inserting into google_users");
  await query(
    `INSERT INTO google_users (google_id, email, name, user_name, is_new_user, picture)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (google_id) DO UPDATE SET picture = EXCLUDED.picture`,
    [googleId, email, name, userName, isNewUser, picture ?? null]
  );

  logger.info(
    { googleId, email, userName, isNewUser },
    "[AUTH] lookupOrCreateGoogleUser — COMPLETE"
  );
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

  logger.info(
    { userName, email, googleId: googleId ?? null, tokenPrefix: token.slice(0, 8) + "…", expiresAt },
    "[AUTH] createSession — inserting new session into app_sessions"
  );

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

  logger.info({ userName, email, tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] createSession — session created successfully");
  return token;
}

export async function validateSession(
  token: string
): Promise<SessionUser | null> {
  const tokenPrefix = token.slice(0, 8) + "…";
  logger.info({ tokenPrefix }, "[AUTH] validateSession — querying app_sessions");

  const { rows } = await query<{ user_name: string; email: string; google_id: string | null; picture: string | null; full_name: string | null }>(
    `SELECT s.user_name, s.email, s.google_id, gu.picture, gu.name AS full_name
     FROM app_sessions s
     LEFT JOIN google_users gu ON (
       (s.google_id IS NOT NULL AND gu.google_id = s.google_id)
       OR (s.google_id IS NULL AND LOWER(gu.email) = LOWER(s.email))
     )
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );

  if (rows.length === 0) {
    logger.warn({ tokenPrefix }, "[AUTH] validateSession — NO MATCHING SESSION (expired or invalid)");
    return null;
  }

  const result = {
    userName: rows[0].user_name,
    email: rows[0].email,
    googleId: rows[0].google_id ?? undefined,
    picture: rows[0].picture ?? undefined,
    fullName: rows[0].full_name ?? undefined,
  };

  logger.info(
    { tokenPrefix, userName: result.userName, email: result.email },
    "[AUTH] validateSession — session valid, resolved user"
  );

  return result;
}

export async function revokeSession(token: string): Promise<void> {
  logger.info({ tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] revokeSession — deleting session");
  await query("DELETE FROM app_sessions WHERE token = $1", [token]);
  logger.info({ tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] revokeSession — session deleted");
}

// ── Magic-link support ────────────────────────────────────────────────────────

export async function createMagicLink(
  email: string
): Promise<{ token: string; email: string; isNewUser: boolean } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;

  logger.info({ email: normalized }, "[AUTH] createMagicLink — looking up existing user");

  // Determine new vs returning by checking prior sessions for this email
  const prior = await findExistingUserByEmail(normalized);
  const isNewUser = prior === null || prior.isNewUser;

  logger.info(
    { email: normalized, priorFound: prior !== null, priorUserName: prior?.userName ?? null, isNewUser },
    "[AUTH] createMagicLink — prior user lookup result"
  );

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

  logger.info({ email: normalized, isNewUser, tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] createMagicLink — token created");

  return { token, email: normalized, isNewUser };
}

// ── Magic-link email delivery ─────────────────────────────────────────────────

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
    logger.warn({ err }, "[AUTH] sendMagicLinkEmail — failed to send email");
    return false;
  }
}

export async function verifyMagicLink(
  token: string
): Promise<(SessionUser & { isNewUser: boolean }) | null> {
  const tokenPrefix = token.slice(0, 8) + "…";
  logger.info({ tokenPrefix }, "[AUTH] verifyMagicLink — validating magic link token");

  const { rows } = await query<{ id: number; email: string }>(
    "SELECT id, email FROM magic_link_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) {
    logger.warn({ tokenPrefix }, "[AUTH] verifyMagicLink — token not found or already used/expired");
    return null;
  }

  const email = rows[0].email;
  logger.info({ tokenPrefix, email }, "[AUTH] verifyMagicLink — token valid, marking used");
  await query("UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1", [rows[0].id]);

  // Find existing user by email or create a new unique username
  logger.info({ email }, "[AUTH] verifyMagicLink — looking up existing user by email");
  const prior = await findExistingUserByEmail(email);

  let userName: string;
  let isNewUser: boolean;

  if (prior) {
    userName = prior.userName;
    isNewUser = prior.isNewUser;
    logger.info({ email, userName, isNewUser }, "[AUTH] verifyMagicLink — found existing user");
  } else {
    const emailPrefix = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "") || "User";
    userName = await generateUniqueUsername(emailPrefix);
    isNewUser = true;
    logger.info({ email, userName }, "[AUTH] verifyMagicLink — new user, generated userName");
  }

  logger.info({ email, userName, isNewUser }, "[AUTH] verifyMagicLink — COMPLETE");
  return { userName, email, isNewUser };
}
