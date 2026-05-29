import { google } from "googleapis";
import { query } from "../db.js";
import { getUserAliasNames } from "../auth/userAliases.js";

// ── Invalid-grant sentinel ─────────────────────────────────────────────────────
// Thrown by calendar/gmail functions when Google revokes the refresh token.
// Caught by schedulers so they can clear stale credentials and push-notify the user.
export class GoogleInvalidGrantError extends Error {
  constructor(public readonly userName: string) {
    super("invalid_grant");
    this.name = "GoogleInvalidGrantError";
  }
}

export function isInvalidGrant(err: unknown): boolean {
  const e = err as Record<string, unknown> | null;
  if (!e) return false;
  const msg = String(e.message ?? "");
  const data = (e.response as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
  return (
    msg === "invalid_grant" ||
    String(data?.error ?? "") === "invalid_grant"
  );
}

// Clear both Google credential stores for a user.
// Deletes ALL alias rows (e.g. 'David', 'davidblakelock') so legacy-named rows
// don't persist and trigger repeated invalid_grant cycles.
// Uses RETURNING so the DELETE routes through exec_dml_ret (required for Supabase DML).
export async function clearGoogleTokensForUser(userName: string): Promise<void> {
  const names = getUserAliasNames(userName);
  await Promise.allSettled([
    query("DELETE FROM google_auth WHERE user_name = ANY($1::text[]) RETURNING user_name", [names]),
    query("DELETE FROM user_integrations WHERE user_name = ANY($1::text[]) AND provider = 'google' RETURNING user_name", [names]),
  ]);
  console.log(`[OAuth] clearGoogleTokensForUser(${userName}) — stale tokens removed for: ${names.join(", ")}`);
}

// ── Identity-only scopes (used for sign-in — minimal permissions) ─────────────
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// ── Full integration scopes (used for "Connect Google" in settings) ───────────
// contacts scope (write) is included so new/updated contact writes work without re-auth.
// fitness scopes are included for Google Fit sleep + activity data in the morning briefing.
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/fitness.sleep.read",
  "https://www.googleapis.com/auth/fitness.activity.read",
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

export async function hasContactsWriteScope(userName?: string): Promise<boolean> {
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
    .some((s) => s === "https://www.googleapis.com/auth/contacts");
}

export async function hasFitnessScope(userName: string): Promise<boolean> {
  // Check both tables — user_integrations is the canonical store written by the
  // connect flow; google_auth is the legacy fallback. Either one having the scope
  // is sufficient.
  const [gaResult, uiResult] = await Promise.all([
    query<{ scope: string | null }>(
      `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
      [userName]
    ).catch(() => ({ rows: [] as Array<{ scope: string | null }> })),
    query<{ scopes: string | null }>(
      `SELECT scopes FROM user_integrations WHERE user_name = $1 AND provider = 'google' LIMIT 1`,
      [userName]
    ).catch(() => ({ rows: [] as Array<{ scopes: string | null }> })),
  ]);

  const fitnessScopeIds = [
    "https://www.googleapis.com/auth/fitness.sleep.read",
    "https://www.googleapis.com/auth/fitness.activity.read",
  ];

  const gaScope   = gaResult.rows[0]?.scope   ?? "";
  const uiScopes  = uiResult.rows[0]?.scopes  ?? "";

  return fitnessScopeIds.some(
    (s) => gaScope.split(" ").includes(s) || uiScopes.split(" ").includes(s)
  );
}

export function getRedirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  // APP_URL is the canonical production domain — the ONLY URL registered in Google
  // Cloud Console. REPLIT_DOMAINS also includes the Replit workspace dev domain
  // (e.g. af745d13-xxx.spock.replit.dev) which is NOT registered, causing
  // redirect_uri_mismatch errors when running in the dev workspace. Always prefer
  // APP_URL so both the dev server and the production server use the same registered
  // callback URL.
  if (process.env.APP_URL) {
    return `${process.env.APP_URL.replace(/\/$/, "")}/api/auth/callback`;
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
  // Wrapped in try/catch so a missing table or query error falls through gracefully.
  try {
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
      let refreshToken = row.refresh_token;

      // If user_integrations has no refresh token, try to borrow one from google_auth
      // so the access token can be auto-renewed without forcing the user to reconnect.
      if (!refreshToken) {
        try {
          const { rows: gaRows } = await query<{ refresh_token: string }>(
            `SELECT refresh_token FROM google_auth WHERE user_name = $1 AND refresh_token IS NOT NULL LIMIT 1`,
            [userName]
          );
          if (gaRows[0]?.refresh_token) {
            refreshToken = gaRows[0].refresh_token;
            // Persist it so we don't need to fall back again next time
            await query(
              `UPDATE user_integrations SET refresh_token = $1, updated_at = NOW()
               WHERE user_name = $2 AND provider = 'google' AND refresh_token IS NULL
               RETURNING user_name`,
              [refreshToken, userName]
            ).catch(() => {});
            console.log(`[OAuth] getAuthClientForUser(${userName}) — back-filled missing refresh_token from google_auth`);
          }
        } catch {
          // Non-fatal — continue without refresh token
        }
      }

      console.log(`[OAuth] getAuthClientForUser(${userName}) → user_integrations (${row.external_email ?? "unknown"})`);
      const oauth2Client = createOAuthClient();
      oauth2Client.setCredentials({
        access_token: row.access_token,
        refresh_token: refreshToken ?? undefined,
        expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : undefined,
      });
      oauth2Client.on("tokens", async (tokens) => {
        if (tokens.access_token) {
          // Keep both stores in sync on token refresh
          await query(
            `UPDATE user_integrations SET access_token = $1, token_expiry = $2, updated_at = NOW()
             WHERE user_name = $3 AND provider = 'google'
             RETURNING user_name`,
            [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userName]
          ).catch(() => {});
          await query(
            `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW()
             WHERE user_name = $3
             RETURNING user_name`,
            [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userName]
          ).catch(() => {});
        }
      });
      return oauth2Client;
    }
  } catch (err) {
    console.warn(`[OAuth] getAuthClientForUser(${userName}) — user_integrations query failed, falling back:`, err instanceof Error ? err.message : err);
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
          `UPDATE google_auth SET access_token = $1, token_expiry = $2, updated_at = NOW() WHERE user_name = $3 RETURNING user_name`,
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
         WHERE user_name = $3
         RETURNING user_name`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, auth.user_name]
      );
    }
  });

  return oauth2Client;
}
