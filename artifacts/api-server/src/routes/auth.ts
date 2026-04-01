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
  lookupOrCreateGoogleUser,
  getAppUrl,
} from "../auth/sessionAuth.js";

const router = Router();

// ── Google Sign-In ─────────────────────────────────────────────────────────────
// GET /api/auth/google?signin=1  — full-page redirect sign-in flow
// GET /api/auth/google            — popup calendar/gmail connect (existing behaviour)
router.get("/auth/google", (req: Request, res: Response) => {
  const isSignIn = req.query.signin === "1";
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "select_account consent",
    // state carries whether this is a sign-in so the callback knows what to do
    state: isSignIn ? "signin" : "connect",
  });
  res.redirect(url);
});

// GET /api/auth/callback — Google OAuth callback (handles both sign-in and connect)
router.get("/auth/callback", async (req: Request, res: Response) => {
  const { code, error, state } = req.query;
  const isSignIn = state === "signin";
  const appUrl = getAppUrl(req.headers.host as string | undefined);

  if (error || !code) {
    if (isSignIn) {
      res.redirect(`${appUrl}/?auth=error`);
    } else {
      res.send(`<!DOCTYPE html><html><body><script>
        if(window.opener){window.opener.postMessage('google-auth-error','*');window.close();}
        else{window.location.href='/?auth=error';}
      </script></body></html>`);
    }
    return;
  }

  try {
    req.log.info({ state, isSignIn }, "[AUTH] /auth/callback — Google OAuth callback received");

    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    req.log.info(
      {
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        scopes: tokens.scope,
      },
      "[AUTH] /auth/callback — Google tokens received"
    );

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    const email = (userInfo.data.email ?? "").trim().toLowerCase();
    // Prefer `sub` (OpenID Connect) then fall back to `id` (v2 field)
    const googleId = (userInfo.data.sub ?? userInfo.data.id ?? "").trim();
    const fullName = (userInfo.data.name ?? email.split("@")[0]).trim();
    const picture = (userInfo.data.picture ?? "").trim() || undefined;

    req.log.info(
      {
        email,
        googleId: googleId || "MISSING",
        googleIdLength: googleId.length,
        fullName,
        subPresent: !!userInfo.data.sub,
        idPresent: !!userInfo.data.id,
        emailVerified: userInfo.data.verified_email,
      },
      "[AUTH] /auth/callback — Google userinfo received (FULL GOOGLE ID LOGGED)"
    );

    if (!googleId || !email) {
      req.log.error(
        { email, googleIdPresent: !!googleId, allDataKeys: Object.keys(userInfo.data) },
        "[AUTH] /auth/callback — FATAL: Google OAuth returned no user ID or email"
      );
      if (isSignIn) {
        res.redirect(`${appUrl}/?auth=error`);
      } else {
        res.send(`<!DOCTYPE html><html><body><script>
          if(window.opener){window.opener.postMessage('google-auth-error','*');window.close();}
          else{window.location.href='/?auth=error';}
        </script></body></html>`);
      }
      return;
    }

    // ── Resolve user identity from Google ID — no hardcoded fallback ─────────
    req.log.info({ googleId, email }, "[AUTH] /auth/callback — calling lookupOrCreateGoogleUser");
    const resolved = await lookupOrCreateGoogleUser(googleId, email, fullName, picture);
    const { userName, isNewUser } = resolved;

    req.log.info(
      { googleId, email, userName, isNewUser },
      "[AUTH] /auth/callback — lookupOrCreateGoogleUser returned"
    );

    // ── Upsert google_auth (OAuth tokens for calendar/gmail access) ───────────
    req.log.info({ userName, email }, "[AUTH] /auth/callback — upserting google_auth row");
    await query(
      `INSERT INTO google_auth (user_name, email, access_token, refresh_token, token_expiry, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_name) DO UPDATE SET
         email         = EXCLUDED.email,
         access_token  = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, google_auth.refresh_token),
         token_expiry  = EXCLUDED.token_expiry,
         scope         = EXCLUDED.scope,
         updated_at    = NOW()`,
      [
        userName,
        email,
        tokens.access_token ?? null,
        tokens.refresh_token ?? null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        SCOPES.join(" "),
      ]
    );

    req.log.info({ email, userName, isSignIn, isNewUser }, "[AUTH] /auth/callback — google_auth upserted");

    if (isSignIn) {
      // ── Create app session and redirect frontend with token ─────────────────
      req.log.info({ userName, isNewUser }, "[AUTH] /auth/callback — creating app session for sign-in");
      const sessionToken = await createSession(userName, email, googleId);

      // Pass isNewUser flag to frontend so it can clear stale storage before loading profile
      const pictureParam = picture ? `&picture=${encodeURIComponent(picture)}` : "";
      const redirectUrl = `${appUrl}/?token=${encodeURIComponent(sessionToken)}&name=${encodeURIComponent(userName)}&new=${isNewUser ? "1" : "0"}${pictureParam}`;
      req.log.info(
        { userName, isNewUser, hasPicture: !!picture, redirectPath: `/?token=…&name=${encodeURIComponent(userName)}&new=${isNewUser ? "1" : "0"}` },
        "[AUTH] /auth/callback — redirecting frontend with session token"
      );
      res.redirect(redirectUrl);
    } else {
      // ── Popup calendar/gmail connect ────────────────────────────────────────
      res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body>
        <script>
          if(window.opener){window.opener.postMessage('google-connected','*');window.close();}
          else{window.location.href='/?connected=google';}
        </script>
        <p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#4ade80">
          Google connected! You can close this window.
        </p>
      </body></html>`);
    }
  } catch (err) {
    req.log.error({ err }, "Google OAuth callback error");
    if (isSignIn) {
      res.redirect(`${appUrl}/?auth=error`);
    } else {
      res.send(`<!DOCTYPE html><html><body><script>
        if(window.opener){window.opener.postMessage('google-auth-error','*');window.close();}
        else{window.location.href='/?auth=error';}
      </script></body></html>`);
    }
  }
});

// ── Session validation ────────────────────────────────────────────────────────

router.get("/auth/session", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.json({ authenticated: false });
      return;
    }

    const session = await validateSession(authHeader.slice(7));
    if (!session) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      userName: session.userName,
      email: session.email,
      googleId: session.googleId,
      picture: session.picture ?? null,
      fullName: session.fullName ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Session validation error");
    res.json({ authenticated: false });
  }
});

// ── Session logout ────────────────────────────────────────────────────────────

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

// ── Google auth status (calendar/gmail connect — requires session) ────────────

router.get("/auth/status", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let userName: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) userName = session.userName;
    }
    if (!userName) {
      res.json({ connected: false });
      return;
    }
    const { rows } = await query<{ email: string | null; token_expiry: Date | null }>(
      "SELECT email, token_expiry FROM google_auth WHERE user_name = $1 LIMIT 1",
      [userName]
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
    const authHeader = req.headers.authorization;
    let userName: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) userName = session.userName;
    }
    if (userName) {
      await query("DELETE FROM google_auth WHERE user_name = $1", [userName]);
      req.log.info({ userName }, "Google OAuth disconnected");
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Logout error");
    res.status(500).json({ error: "Logout failed" });
  }
});

// ── Magic-link endpoints ──────────────────────────────────────────────────────

router.post("/auth/magic-link", async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) { res.status(400).json({ error: "email_required" }); return; }

    const result = await createMagicLink(email.trim().toLowerCase());
    if (!result) { res.json({ sent: true, emailSent: false }); return; }

    const magicLinkUrl = `${getAppUrl(req.headers.host as string | undefined)}/auth/verify?token=${result.token}`;
    let emailSent = false;
    if (process.env.RESEND_API_KEY) {
      emailSent = await sendMagicLinkEmail(result.email, magicLinkUrl);
    }
    res.json({ sent: true, magicLinkUrl, emailSent });
  } catch (err) {
    req.log.error({ err }, "Magic link error");
    res.status(500).json({ error: "server_error" });
  }
});

router.post("/auth/magic-link/verify", async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) { res.status(400).json({ error: "token_required" }); return; }

    const user = await verifyMagicLink(token.trim());
    if (!user) { res.status(401).json({ error: "invalid_or_expired" }); return; }

    const sessionToken = await createSession(user.userName, user.email);
    res.json({ sessionToken, userName: user.userName, email: user.email, isNewUser: user.isNewUser ?? false });
  } catch (err) {
    req.log.error({ err }, "Magic link verify error");
    res.status(500).json({ error: "server_error" });
  }
});

export { getRedirectUri };
export default router;
