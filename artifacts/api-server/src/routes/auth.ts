import { Router, type Request, type Response } from "express";
import express from "express";
import { google } from "googleapis";
import { createOAuthClient, getRedirectUri, SCOPES } from "../google/oauth.js";
import { query } from "../db.js";
import {
  createSession,
  validateSession,
  revokeSession,
  lookupOrCreateGoogleUser,
  getAppUrl,
} from "../auth/sessionAuth.js";
import { registerUser, loginUser } from "../auth/passwordAuth.js";

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
      req.log.info({ userName, isNewUser, hasPicture: !!picture }, "[AUTH] /auth/callback — creating app session for sign-in");
      const sessionToken = await createSession(userName, email, googleId, picture);

      // Pass all params to frontend — picture gets stored in session AND in URL param
      const pictureParam = picture ? `&picture=${encodeURIComponent(picture)}` : "";
      const redirectUrl = `${appUrl}/?token=${encodeURIComponent(sessionToken)}&name=${encodeURIComponent(userName)}&new=${isNewUser ? "1" : "0"}${pictureParam}`;
      req.log.info(
        { userName, isNewUser, hasPicture: !!picture, pictureLength: picture?.length ?? 0, redirectUrlLength: redirectUrl.length },
        "[AUTH] /auth/callback — redirecting frontend with session token + picture"
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

// ── Native app Google Sign-In ─────────────────────────────────────────────────
// POST /api/auth/google/native
// Body: { idToken: string, serverAuthCode?: string }
//
// The native app obtains a Google idToken (and optionally a serverAuthCode for
// offline API access) via the Google Sign-In SDK. This endpoint:
//   1. Verifies the idToken signature and audience with Google
//   2. Resolves/creates the Winston user from the Google identity
//   3. If serverAuthCode is provided, exchanges it for access+refresh tokens and
//      upserts them into google_auth (enables server-side calendar/gmail/contacts)
//   4. Creates a 30-day Winston session and returns the session token
router.post("/auth/google/native", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const { idToken, serverAuthCode } = req.body as {
    idToken?: string;
    serverAuthCode?: string;
  };

  if (!idToken || typeof idToken !== "string") {
    res.status(400).json({ error: "idToken is required" });
    return;
  }

  try {
    // ── 1. Verify idToken ───────────────────────────────────────────────────
    const client = createOAuthClient();
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      res.status(401).json({ error: "Invalid Google ID token" });
      return;
    }

    const googleId = payload.sub;
    const email = (payload.email ?? "").trim().toLowerCase();
    const fullName = (payload.name ?? email.split("@")[0]).trim();
    const picture = payload.picture ?? undefined;

    if (!googleId || !email) {
      res.status(401).json({ error: "Google token missing required identity fields" });
      return;
    }

    req.log.info({ email, googleId }, "[AUTH] /auth/google/native — idToken verified");

    // ── 2. Resolve Winston user ─────────────────────────────────────────────
    const { userName, isNewUser } = await lookupOrCreateGoogleUser(googleId, email, fullName, picture);

    req.log.info({ userName, isNewUser }, "[AUTH] /auth/google/native — user resolved");

    // ── 3. Exchange serverAuthCode → store OAuth tokens (optional) ──────────
    if (serverAuthCode && typeof serverAuthCode === "string") {
      try {
        const { tokens } = await client.getToken({ code: serverAuthCode });
        if (tokens.access_token) {
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
          req.log.info({ userName }, "[AUTH] /auth/google/native — google_auth upserted from serverAuthCode");
        }
      } catch (codeErr) {
        // Non-fatal — session still issued, but server-side Google APIs won't work
        req.log.warn({ err: codeErr }, "[AUTH] /auth/google/native — serverAuthCode exchange failed (non-fatal)");
      }
    }

    // ── 4. Create Winston session ───────────────────────────────────────────
    const sessionToken = await createSession(userName, email, googleId, picture);

    req.log.info({ userName, email }, "[AUTH] /auth/google/native — session created");

    res.json({
      sessionToken,
      userName,
      email,
      picture: picture ?? null,
      isNewUser,
    });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/google/native — error");
    res.status(401).json({ error: "Google authentication failed" });
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
      hasPicture: !!session.picture,
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

// POST /api/auth/google/disconnect — disconnect Google (keeps app session intact)
router.post("/auth/google/disconnect", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let userName: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) userName = session.userName;
    }
    if (!userName) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    await query("DELETE FROM google_auth WHERE user_name = $1", [userName]);
    req.log.info({ userName }, "Google OAuth disconnected (keeping app session)");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Google disconnect error");
    res.status(500).json({ error: "Disconnect failed" });
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

// ── Email / Password authentication ──────────────────────────────────────────

// POST /api/auth/register
// Body: { email, password, name }
// Returns: { sessionToken, userName, email, name, isNewUser: true }
router.post("/auth/register", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const { email, password, name } = req.body as {
    email?: string;
    password?: string;
    name?: string;
  };

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  if (!name || typeof name !== "string" || name.trim().length < 1) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  try {
    const result = await registerUser(email, password, name);

    if ("error" in result) {
      res.status(409).json({ error: result.error });
      return;
    }

    const { userName } = result;
    const sessionToken = await createSession(userName, email.trim().toLowerCase());

    req.log.info({ userName, email }, "[AUTH] /auth/register — registration successful");

    res.status(201).json({
      sessionToken,
      userName,
      email: email.trim().toLowerCase(),
      name: name.trim(),
      isNewUser: true,
    });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/register — error");
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// POST /api/auth/login
// Body: { email, password }
// Returns: { sessionToken, userName, email, name }
router.post("/auth/login", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const { email, password } = req.body as {
    email?: string;
    password?: string;
  };

  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "Email is required." });
    return;
  }
  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Password is required." });
    return;
  }

  try {
    const user = await loginUser(email, password);

    if (!user) {
      // Return generic message to avoid leaking whether the email exists
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    const sessionToken = await createSession(user.userName, user.email);

    req.log.info({ userName: user.userName, email: user.email }, "[AUTH] /auth/login — login successful");

    res.json({
      sessionToken,
      userName: user.userName,
      email: user.email,
      name: user.name,
    });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/login — error");
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

export { getRedirectUri };
export default router;
