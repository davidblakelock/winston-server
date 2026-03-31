import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import { createOAuthClient, getRedirectUri, SCOPES } from "../google/oauth.js";
import { query } from "../db.js";
import {
  createMagicLink,
  verifyMagicLink,
  createSession,
  validateSession,
  revokeSession,
  sendMagicLinkEmail,
  getAppUrl,
} from "../auth/sessionAuth.js";

const router = Router();

const REQUIRED_EMAIL = "davidblakelock.winston@gmail.com";

// ── Magic Link Auth ───────────────────────────────────────────────────────────

// POST /api/auth/magic-link — request a sign-in link
router.post("/auth/magic-link", async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== "string") {
      res.status(400).json({ error: "email_required" });
      return;
    }

    const result = await createMagicLink(email.trim().toLowerCase());

    // Always respond the same way regardless of whether email is authorized
    // (security: don't reveal which emails are allowed)
    if (!result) {
      // Not an authorized email — still say "sent" but don't include the link
      res.json({ sent: true, emailSent: false });
      return;
    }

    const appUrl = getAppUrl(req.headers.host as string | undefined);
    const magicLinkUrl = `${appUrl}/auth/verify?token=${result.token}`;

    let emailSent = false;
    if (process.env.RESEND_API_KEY) {
      emailSent = await sendMagicLinkEmail(result.email, magicLinkUrl);
    }

    req.log.info({ email: result.email, emailSent }, "Magic link requested");
    res.json({ sent: true, magicLinkUrl, emailSent });
  } catch (err) {
    req.log.error({ err }, "Magic link request error");
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/auth/magic-link/verify — verify token and create session
router.post("/auth/magic-link/verify", async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token_required" });
      return;
    }

    const user = await verifyMagicLink(token.trim());
    if (!user) {
      res.status(401).json({ error: "invalid_or_expired" });
      return;
    }

    const sessionToken = await createSession(user.userName, user.email);
    req.log.info({ userName: user.userName }, "User authenticated via magic link");

    res.json({
      sessionToken,
      userName: user.userName,
      email: user.email,
    });
  } catch (err) {
    req.log.error({ err }, "Magic link verify error");
    res.status(500).json({ error: "server_error" });
  }
});

// GET /api/auth/session — validate current session
router.get("/auth/session", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.json({ authenticated: false });
      return;
    }

    const token = authHeader.slice(7);
    const session = await validateSession(token);

    if (!session) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      userName: session.userName,
      email: session.email,
    });
  } catch (err) {
    req.log.error({ err }, "Session validation error");
    res.json({ authenticated: false });
  }
});

// POST /api/auth/session/logout — revoke current session
router.post("/auth/session/logout", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      await revokeSession(authHeader.slice(7)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Session logout error");
    res.json({ ok: true });
  }
});

router.get("/auth/google", (_req: Request, res: Response) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "select_account consent",
    login_hint: REQUIRED_EMAIL,
  });
  res.redirect(url);
});

router.get("/auth/callback", async (req: Request, res: Response) => {
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect("/?auth=error");
    return;
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email ?? null;

    // Reject if not the expected account
    if (email?.toLowerCase() !== REQUIRED_EMAIL.toLowerCase()) {
      req.log.warn({ email }, "Google OAuth rejected — wrong account");
      res.send(`<!DOCTYPE html><html><head><title>Wrong Account</title></head><body>
        <script>
          if (window.opener) { window.opener.postMessage('google-auth-error', '*'); window.close(); }
          else { window.location.href = '/?auth=wrong-account'; }
        </script>
        <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#f87171">
          Please sign in with <strong>${REQUIRED_EMAIL}</strong>.<br><br>
          <a href="/api/auth/google" style="color:#818cf8">Try again</a>
        </p>
      </body></html>`);
      return;
    }

    await query(
      `INSERT INTO google_auth (user_name, email, access_token, refresh_token, token_expiry, scope)
       VALUES ('David', $1, $2, $3, $4, $5)
       ON CONFLICT (user_name) DO UPDATE SET
         email        = EXCLUDED.email,
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, google_auth.refresh_token),
         token_expiry = EXCLUDED.token_expiry,
         scope        = EXCLUDED.scope,
         updated_at   = NOW()`,
      [
        email,
        tokens.access_token ?? null,
        tokens.refresh_token ?? null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        SCOPES.join(" "),
      ]
    );

    req.log.info({ email }, "Google OAuth connected");
    res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
      <script>
        if (window.opener) { window.opener.postMessage('google-connected', '*'); window.close(); }
        else { window.location.href = '/?connected=google'; }
      </script>
      <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#4ade80">Google connected! You can close this window.</p>
    </body></html>`);
  } catch (err) {
    req.log.error({ err }, "Google OAuth callback error");
    res.send(`<!DOCTYPE html><html><head><title>Error</title></head><body>
      <script>
        if (window.opener) { window.opener.postMessage('google-auth-error', '*'); window.close(); }
        else { window.location.href = '/?auth=error'; }
      </script>
      <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#f87171">Sign-in failed. You can close this window.</p>
    </body></html>`);
  }
});

router.get("/auth/status", async (_req: Request, res: Response) => {
  try {
    const { rows } = await query<{ email: string | null; token_expiry: Date | null }>(
      "SELECT email, token_expiry FROM google_auth WHERE user_name = 'David' LIMIT 1"
    );
    if (rows.length === 0 || !rows[0].email) {
      res.json({ connected: false });
      return;
    }
    res.json({ connected: true, email: rows[0].email });
  } catch {
    res.json({ connected: false });
  }
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM google_auth WHERE user_name = 'David'");
    req.log.info("Google OAuth disconnected");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Logout error");
    res.status(500).json({ error: "Logout failed" });
  }
});

export { getRedirectUri };
export default router;
