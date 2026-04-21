import { google } from "googleapis";
import { query } from "../db.js";

// ── Identity-only scopes (used for sign-in — minimal permissions) ─────────────
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// ── Full integration scopes (used for "Connect Google" in settings) ───────────
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
];

// ── Account preference SQL ─────────────────────────────────────────────────────
// Prefer the real personal account (non-winston) over the app service account.
// When David re-authenticated with davidblakelock01@gmail.com, it was stored as
// user_name='David'. This ordering ensures Gmail, Calendar, and scope checks
// always resolve to his real account if it exists.
const PREFERRED_ACCOUNT_ORDER = `
  ORDER BY
    CASE WHEN email NOT LIKE '%winston%' THEN 0 ELSE 1 END,
    updated_at DESC NULLS LAST
`;

export async function hasCalendarWriteScope(userName?: string): Promise<boolean> {
  const { rows } = userName
    ? await query<{ scope: string | null }>(
        `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
        [userName]
      )
    : await query<{ scope: string | null }>(
        `SELECT scope FROM google_auth ${PREFERRED_ACCOUNT_ORDER} LIMIT 1`
      );
  if (!rows.length || !rows[0].scope) return false;
  return rows[0].scope
    .split(" ")
    .some((s) => s === "https://www.googleapis.com/auth/calendar");
}

export async function hasContactsScope(userName?: string): Promise<boolean> {
  const { rows } = userName
    ? await query<{ scope: string | null }>(
        `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
        [userName]
      )
    : await query<{ scope: string | null }>(
        `SELECT scope FROM google_auth ${PREFERRED_ACCOUNT_ORDER} LIMIT 1`
      );
  if (!rows.length || !rows[0].scope) return false;
  return rows[0].scope
    .split(" ")
    .some((s) => s === "https://www.googleapis.com/auth/contacts.readonly");
}

export function getRedirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  const domains = process.env.REPLIT_DOMAINS;
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  const domain = (domains ? domains.split(",")[0] : devDomain) ?? "";
  return `https://${domain}/api/auth/callback`;
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

interface GoogleAuthRow {
  id: number;
  user_name: string;
  email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: Date | null;
  scope: string | null;
}

// ── Per-user Google auth client ────────────────────────────────────────────────
// For multi-user: resolves the OAuth client for a specific Winston userName.
// Priority: user_integrations (canonical) → google_auth (legacy) → global fallback.
export async function getAuthClientForUser(
  userName: string
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  // First try: user_integrations (canonical integration store, written by connect flow)
  const { rows: integrationRows } = await query<{
    access_token: string | null;
    refresh_token: string | null;
    token_expiry: Date | null;
    external_email: string | null;
  }>(
    `SELECT access_token, refresh_token, token_expiry, external_email
     FROM user_integrations
     WHERE user_name = $1 AND provider = 'google'
       AND (access_token IS NOT NULL OR refresh_token IS NOT NULL)
     LIMIT 1`,
    [userName]
  );
  if (integrationRows.length > 0) {
    const row = integrationRows[0];
    console.log(`[OAuth] getAuthClientForUser(${userName}) → user_integrations (${row.external_email ?? "unknown"})`);
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials({
      access_token: row.access_token,
      refresh_token: row.refresh_token ?? undefined,
      expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : undefined,
    });
    oauth2Client.on("tokens", async (tokens) => {
      if (tokens.access_token) {
        await query(
          `UPDATE user_integrations SET access_token = $1, token_expiry = $2, updated_at = NOW()
           WHERE user_name = $3 AND provider = 'google'`,
          [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userName]
        );
      }
    });
    return oauth2Client;
  }

  // Second try: legacy google_auth row for this user
  const { rows: userRows } = await query<GoogleAuthRow>(
    `SELECT * FROM google_auth WHERE user_name = $1 AND (access_token IS NOT NULL OR refresh_token IS NOT NULL) LIMIT 1`,
    [userName]
  );
  if (userRows.length > 0) {
    const auth = userRows[0];
    console.log(`[OAuth] getAuthClientForUser(${userName}) → google_auth (legacy) (${auth.email ?? "unknown"})`);
    const oauth2Client = createOAuthClient();
    oauth2Client.setCredentials({
      access_token: auth.access_token,
      refresh_token: auth.refresh_token ?? undefined,
      expiry_date: auth.token_expiry ? new Date(auth.token_expiry).getTime() : undefined,
    });
    oauth2Client.on("tokens", async (tokens) => {
      if (tokens.access_token) {
        await query(
          `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3`,
          [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, auth.user_name]
        );
      }
    });
    return oauth2Client;
  }

  // Fallback: global preference (ensures backward compat)
  return getAuthClient();
}

export async function getAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  // Select all rows ordered by preference — real personal account first, then
  // most recently updated. Falls back to the winston app account if needed.
  const { rows } = await query<GoogleAuthRow>(
    `SELECT * FROM google_auth ${PREFERRED_ACCOUNT_ORDER} LIMIT 5`
  );

  // Find the first row that has a usable token
  const auth = rows.find((r) => r.access_token || r.refresh_token);
  if (!auth) return null;

  console.log(`[OAuth] getAuthClient using ${auth.email ?? "unknown"} (user_name=${auth.user_name})`);

  const oauth2Client = createOAuthClient();

  oauth2Client.setCredentials({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token ?? undefined,
    expiry_date: auth.token_expiry ? new Date(auth.token_expiry).getTime() : undefined,
  });

  // When the token auto-refreshes, update the correct row (not hardcoded 'David')
  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await query(
        `UPDATE google_auth
         SET access_token = $1,
             token_expiry = $2,
             updated_at   = NOW()
         WHERE user_name = $3`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, auth.user_name]
      );
    }
  });

  return oauth2Client;
}
