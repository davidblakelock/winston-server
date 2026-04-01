import { google } from "googleapis";
import { query } from "../db.js";

export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
];

export async function hasCalendarWriteScope(): Promise<boolean> {
  const { rows } = await query<{ scope: string | null }>(
    "SELECT scope FROM google_auth WHERE user_name = 'David' LIMIT 1"
  );
  if (!rows.length || !rows[0].scope) return false;
  return rows[0].scope
    .split(" ")
    .some((s) => s === "https://www.googleapis.com/auth/calendar");
}

export function getRedirectUri(): string {
  // Allow an explicit override (needed for production deployments)
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

export async function getAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const { rows } = await query<GoogleAuthRow>(
    "SELECT * FROM google_auth WHERE user_name = 'David' LIMIT 1"
  );
  if (rows.length === 0 || !rows[0].access_token) return null;

  const auth = rows[0];
  const oauth2Client = createOAuthClient();

  oauth2Client.setCredentials({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token ?? undefined,
    expiry_date: auth.token_expiry ? new Date(auth.token_expiry).getTime() : undefined,
  });

  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await query(
        `UPDATE google_auth
         SET access_token = $1,
             token_expiry = $2,
             updated_at   = NOW()
         WHERE user_name = 'David'`,
        [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null]
      );
    }
  });

  return oauth2Client;
}
