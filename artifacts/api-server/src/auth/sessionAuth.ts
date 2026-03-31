import crypto from "crypto";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const ALLOWED_EMAILS = ["davidblakelock.winston@gmail.com"];

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getAppUrl(_reqHost?: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  // Replit dev domain (same domain proxies both frontend and API)
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  // Replit production domain
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0].trim()}`;
  return "https://winston-companion--davidblakelock.replit.app";
}

export interface MagicLinkResult {
  token: string;
  email: string;
}

export async function createMagicLink(
  email: string
): Promise<MagicLinkResult | null> {
  const normalized = email.trim().toLowerCase();
  if (!ALLOWED_EMAILS.includes(normalized)) {
    return null;
  }

  // Invalidate existing unused tokens for this email
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

  logger.info({ email: normalized }, "Magic link created");
  return { token, email: normalized };
}

export interface SessionUser {
  userName: string;
  email: string;
}

export async function verifyMagicLink(
  token: string
): Promise<SessionUser | null> {
  const { rows } = await query<{ id: number; email: string }>(
    "SELECT id, email FROM magic_link_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  await query("UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1", [
    row.id,
  ]);

  return { userName: "David", email: row.email };
}

export async function createSession(
  userName: string,
  email: string
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await query(
    "INSERT INTO app_sessions (user_name, email, token, expires_at) VALUES ($1, $2, $3, $4)",
    [userName, email, token, expiresAt]
  );

  logger.info({ userName, email }, "App session created");
  return token;
}

export async function validateSession(
  token: string
): Promise<SessionUser | null> {
  const { rows } = await query<{ user_name: string; email: string }>(
    "SELECT user_name, email FROM app_sessions WHERE token = $1 AND expires_at > NOW()",
    [token]
  );

  if (rows.length === 0) return null;
  return { userName: rows[0].user_name, email: rows[0].email };
}

export async function revokeSession(token: string): Promise<void> {
  await query("DELETE FROM app_sessions WHERE token = $1", [token]);
}

export async function sendMagicLinkEmail(
  email: string,
  magicLinkUrl: string
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Winston <noreply@winston.app>",
        to: [email],
        subject: "Your Winston sign-in link",
        html: `
          <div style="font-family:Georgia,serif;max-width:480px;margin:40px auto;color:#1a1a2e;padding:40px;background:#fafafa;border-radius:8px">
            <p style="font-size:1.4rem;font-weight:bold;margin-bottom:8px">Emma Peel is waiting for you.</p>
            <p style="color:#444;margin-bottom:32px">Click the button below to sign in to Winston. This link expires in 30 minutes.</p>
            <a href="${magicLinkUrl}" style="display:inline-block;padding:14px 32px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;font-size:1rem">
              Open Winston →
            </a>
            <p style="color:#888;font-size:0.8rem;margin-top:32px">If you didn't request this, you can safely ignore it.</p>
          </div>
        `,
      }),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err }, "Failed to send magic link email");
    return false;
  }
}
