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

export async function generateUniqueUsername(base: string): Promise<string> {
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
      await query("UPDATE google_users SET picture = $2 WHERE google_id = $1 RETURNING google_id", [googleId, picture]);
    }

    if (existing[0].is_new_user) {
      await query("UPDATE google_users SET is_new_user = false WHERE google_id = $1 RETURNING google_id", [googleId]);
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
     ON CONFLICT (google_id) DO UPDATE SET picture = EXCLUDED.picture
     RETURNING user_name`,
    [googleId, email, name, userName, isNewUser, picture ?? null]
  );

  logger.info(
    { googleId, email, userName, isNewUser },
    "[AUTH] lookupOrCreateGoogleUser — COMPLETE"
  );
  return { userName, isNewUser };
}

// ── Microsoft user lookup / creation ──────────────────────────────────────────

export async function lookupOrCreateMicrosoftUser(
  microsoftOid: string,
  email: string,
  name: string,
  picture?: string
): Promise<{ userName: string; isNewUser: boolean }> {
  logger.info({ microsoftOid, email, name }, "[AUTH] lookupOrCreateMicrosoftUser — START");

  const { rows: existing } = await query<{ user_name: string }>(
    "SELECT user_name FROM microsoft_users WHERE microsoft_oid = $1",
    [microsoftOid]
  );

  if (existing.length > 0) {
    const userName = existing[0].user_name;
    if (picture) {
      await query("UPDATE microsoft_users SET picture = $2 WHERE microsoft_oid = $1 RETURNING microsoft_oid", [microsoftOid, picture]).catch(() => {});
    }
    const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
      "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [userName]
    );
    const hasCompletedProfile = profileRows.length > 0 && profileRows[0].onboarding_completed === true;
    logger.info({ microsoftOid, userName, isNewUser: !hasCompletedProfile }, "[AUTH] lookupOrCreateMicrosoftUser — KNOWN user");
    return { userName, isNewUser: !hasCompletedProfile };
  }

  // New Microsoft OID — try to find an existing account by email
  const prior = await findExistingUserByEmail(email).catch(() => null);

  let userName: string;
  let isNewUser: boolean;
  if (prior) {
    userName = prior.userName;
    isNewUser = prior.isNewUser;
    logger.info({ microsoftOid, email, userName }, "[AUTH] lookupOrCreateMicrosoftUser — linked to EXISTING user");
  } else {
    const firstName = name.split(" ")[0] || "Friend";
    userName = await generateUniqueUsername(firstName);
    isNewUser = true;
    logger.info({ microsoftOid, email, userName }, "[AUTH] lookupOrCreateMicrosoftUser — BRAND NEW user");
  }

  await query(
    `INSERT INTO microsoft_users (microsoft_oid, email, name, user_name, picture)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (microsoft_oid) DO NOTHING
     RETURNING user_name`,
    [microsoftOid, email, name, userName, picture ?? null]
  );

  logger.info({ microsoftOid, email, userName, isNewUser }, "[AUTH] lookupOrCreateMicrosoftUser — COMPLETE");
  return { userName, isNewUser };
}

// ── Apple user lookup / creation ───────────────────────────────────────────────

export async function lookupOrCreateAppleUser(
  appleSub: string,
  email: string | null,
  name: string | null
): Promise<{ userName: string; isNewUser: boolean }> {
  logger.info({ appleSub, email, name }, "[AUTH] lookupOrCreateAppleUser — START");

  const { rows: existing } = await query<{ user_name: string }>(
    "SELECT user_name FROM apple_users WHERE apple_sub = $1",
    [appleSub]
  );

  if (existing.length > 0) {
    const userName = existing[0].user_name;
    const { rows: profileRows } = await query<{ onboarding_completed: boolean }>(
      "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [userName]
    );
    const hasCompletedProfile = profileRows.length > 0 && profileRows[0].onboarding_completed === true;
    logger.info({ appleSub, userName, isNewUser: !hasCompletedProfile }, "[AUTH] lookupOrCreateAppleUser — KNOWN user");
    return { userName, isNewUser: !hasCompletedProfile };
  }

  // New Apple sub — try to find an existing account by email (Apple provides it only once)
  const prior = email ? await findExistingUserByEmail(email).catch(() => null) : null;

  let userName: string;
  let isNewUser: boolean;
  if (prior) {
    userName = prior.userName;
    isNewUser = prior.isNewUser;
    logger.info({ appleSub, email, userName }, "[AUTH] lookupOrCreateAppleUser — linked to EXISTING user");
  } else {
    const firstName = name?.split(" ")[0] ?? "Friend";
    userName = await generateUniqueUsername(firstName);
    isNewUser = true;
    logger.info({ appleSub, email, userName }, "[AUTH] lookupOrCreateAppleUser — BRAND NEW user");
  }

  await query(
    `INSERT INTO apple_users (apple_sub, email, name, user_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (apple_sub) DO NOTHING
     RETURNING user_name`,
    [appleSub, email ?? null, name ?? null, userName]
  );

  logger.info({ appleSub, email, userName, isNewUser }, "[AUTH] lookupOrCreateAppleUser — COMPLETE");
  return { userName, isNewUser };
}

// ── App sessions ──────────────────────────────────────────────────────────────

export async function createSession(
  userName: string,
  email: string,
  googleId?: string,
  picture?: string
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  logger.info(
    { userName, email, googleId: googleId ?? null, hasPicture: !!picture, tokenPrefix: token.slice(0, 8) + "…", expiresAt },
    "[AUTH] createSession — inserting new session into app_sessions"
  );

  await query(
    `INSERT INTO app_sessions (user_name, email, token, expires_at, google_id, picture)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING token`,
    [userName, email, token, expiresAt, googleId ?? null, picture ?? null]
  );

  logger.info({ userName, email, hasPicture: !!picture, tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] createSession — session created successfully");
  return token;
}

export async function validateSession(
  token: string
): Promise<SessionUser | null> {
  const tokenPrefix = token.slice(0, 8) + "…";
  logger.info({ tokenPrefix }, "[AUTH] validateSession — querying app_sessions");

  const { rows } = await query<{
    user_name: string;
    email: string;
    google_id: string | null;
    session_picture: string | null;
    gu_picture: string | null;
    full_name: string | null;
  }>(
    `SELECT s.user_name, s.email, s.google_id,
            s.picture AS session_picture,
            gu.picture AS gu_picture,
            gu.name AS full_name
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

  // Prefer picture stored directly on the session, fall back to google_users JOIN
  const picture = rows[0].session_picture ?? rows[0].gu_picture ?? undefined;

  const result = {
    userName: rows[0].user_name,
    email: rows[0].email,
    googleId: rows[0].google_id ?? undefined,
    picture: picture || undefined,
    fullName: rows[0].full_name ?? undefined,
  };

  logger.info(
    { tokenPrefix, userName: result.userName, email: result.email, hasPicture: !!result.picture },
    "[AUTH] validateSession — session valid, resolved user"
  );

  return result;
}

export async function revokeSession(token: string): Promise<void> {
  logger.info({ tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] revokeSession — deleting session");
  await query("DELETE FROM app_sessions WHERE token = $1 RETURNING token", [token]);
  logger.info({ tokenPrefix: token.slice(0, 8) + "…" }, "[AUTH] revokeSession — session deleted");
}


