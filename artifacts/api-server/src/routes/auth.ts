import { Router, type Request, type Response } from "express";
import express from "express";
import { google } from "googleapis";
import { createOAuthClient, getRedirectUri, SCOPES, IDENTITY_SCOPES } from "../google/oauth.js";
import { query } from "../db.js";
import {
  createSession,
  validateSession,
  revokeSession,
  lookupOrCreateGoogleUser,
  lookupOrCreateMicrosoftUser,
  lookupOrCreateAppleUser,
  getAppUrl,
} from "../auth/sessionAuth.js";
import { registerUser, loginUser } from "../auth/passwordAuth.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
// @ts-ignore — apple-signin-auth has no bundled types
import appleSignin from "apple-signin-auth";

const router = Router();

// ── Google Sign-In ─────────────────────────────────────────────────────────────
// GET /api/auth/google?signin=1  — full-page redirect sign-in flow
// GET /api/auth/google            — popup calendar/gmail connect (existing behaviour)
router.get("/auth/google", (req: Request, res: Response) => {
  const isSignIn = req.query.signin === "1";
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    // Identity sign-in: request minimal scopes (openid + email + profile only).
    // Integration connect: request full scopes (calendar, gmail, contacts).
    scope: isSignIn ? IDENTITY_SCOPES : SCOPES,
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

    // ── Upsert google_auth ONLY for full-scope connect flow ───────────────────
    // Sign-in (?signin=1) uses identity-only scopes — never write those tokens
    // to google_auth, which is reserved for calendar/gmail integration tokens.
    // Overwriting with identity-only tokens would silently break calendar/gmail.
    if (!isSignIn) {
      req.log.info({ userName, email }, "[AUTH] /auth/callback — upserting google_auth row (connect flow)");
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
          tokens.scope ?? SCOPES.join(" "),
        ]
      );
      // Also write to user_integrations (canonical multi-user integration store)
      await query(
        `INSERT INTO user_integrations (user_name, provider, access_token, refresh_token, token_expiry, scopes, external_email, updated_at)
         VALUES ($1, 'google', $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_name, provider) DO UPDATE SET
           access_token   = EXCLUDED.access_token,
           refresh_token  = COALESCE(EXCLUDED.refresh_token, user_integrations.refresh_token),
           token_expiry   = EXCLUDED.token_expiry,
           scopes         = EXCLUDED.scopes,
           external_email = EXCLUDED.external_email,
           updated_at     = NOW()`,
        [
          userName,
          tokens.access_token ?? null,
          tokens.refresh_token ?? null,
          tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          tokens.scope ?? SCOPES.join(" "),
          email,
        ]
      );
      req.log.info({ email, userName, isNewUser }, "[AUTH] /auth/callback — google_auth + user_integrations upserted (connect)");
    } else {
      req.log.info({ email, userName }, "[AUTH] /auth/callback — sign-in flow, skipping google_auth upsert");
    }

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
    // IMPORTANT: Only write to google_auth/user_integrations if the exchanged
    // tokens actually include the full calendar/gmail/contacts scopes.
    // Identity-only tokens (email+profile) must NEVER overwrite existing
    // full-scope tokens — that would silently break calendar/gmail/contacts.
    if (serverAuthCode && typeof serverAuthCode === "string") {
      try {
        const { tokens } = await client.getToken({ code: serverAuthCode });
        if (tokens.access_token) {
          const grantedScope = tokens.scope ?? "";
          const hasCalendar = grantedScope.includes("calendar");
          const hasGmail    = grantedScope.includes("gmail");
          const hasContacts = grantedScope.includes("contacts");
          const hasFullScopes = hasCalendar || hasGmail || hasContacts;

          if (hasFullScopes) {
            // Full integration scopes granted — write to both stores
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
                userName, email,
                tokens.access_token ?? null,
                tokens.refresh_token ?? null,
                tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                grantedScope,
              ]
            );
            await query(
              `INSERT INTO user_integrations (user_name, provider, access_token, refresh_token, token_expiry, scopes, external_email, updated_at)
               VALUES ($1, 'google', $2, $3, $4, $5, $6, NOW())
               ON CONFLICT (user_name, provider) DO UPDATE SET
                 access_token   = EXCLUDED.access_token,
                 refresh_token  = COALESCE(EXCLUDED.refresh_token, user_integrations.refresh_token),
                 token_expiry   = EXCLUDED.token_expiry,
                 scopes         = EXCLUDED.scopes,
                 external_email = EXCLUDED.external_email,
                 updated_at     = NOW()`,
              [
                userName,
                tokens.access_token ?? null,
                tokens.refresh_token ?? null,
                tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                grantedScope,
                email,
              ]
            );
            req.log.info({ userName, hasCalendar, hasGmail, hasContacts }, "[AUTH] /auth/google/native — google_auth + user_integrations upserted (full scopes)");
          } else {
            // Identity-only tokens — preserve any existing full-scope tokens.
            // Only update the access_token if the user has NO existing tokens at all.
            const { rows: existing } = await query<{ scope: string | null }>(
              `SELECT scope FROM google_auth WHERE user_name = $1 LIMIT 1`,
              [userName]
            );
            const existingHasFullScopes = existing.length > 0 &&
              (existing[0].scope ?? "").includes("calendar");

            if (!existingHasFullScopes) {
              // No full-scope tokens exist yet — safe to write identity tokens as a placeholder
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
                  userName, email,
                  tokens.access_token ?? null,
                  tokens.refresh_token ?? null,
                  tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                  grantedScope,
                ]
              );
              req.log.info({ userName, grantedScope }, "[AUTH] /auth/google/native — google_auth upserted (no prior full-scope tokens)");
            } else {
              req.log.info({ userName, grantedScope }, "[AUTH] /auth/google/native — identity-only serverAuthCode, preserving existing full-scope tokens");
            }
          }
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
    const apiKey = req.headers["x-api-key"];
    let userName: string | null = null;
    // Accept both Bearer session token and native-app API key
    if (apiKey === "winston-native-2026") {
      userName = NATIVE_STORED_NAME;
    } else if (authHeader?.startsWith("Bearer ")) {
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

// GET /api/auth/onboarding-status — returns whether the current user has completed onboarding
router.get("/auth/onboarding-status", async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers["x-api-key"];
    const authHeader = req.headers.authorization;
    let userName: string | null = null;

    if (apiKey === "winston-native-2026") {
      userName = NATIVE_STORED_NAME;
    } else if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) userName = session.userName;
    }

    if (!userName) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const { rows } = await query<{ onboarding_completed: boolean }>(
      "SELECT onboarding_completed FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [userName]
    );

    if (rows.length === 0) {
      res.json({ onboardingCompleted: false, userName });
      return;
    }

    res.json({ onboardingCompleted: rows[0].onboarding_completed === true, userName });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/onboarding-status — error");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/auth/providers — returns which sign-in/integration providers are configured
// No auth required — used by the frontend to show/hide provider buttons.
router.get("/auth/providers", (_req: Request, res: Response) => {
  res.json({
    google:    true, // always available (client ID is always configured)
    microsoft: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    apple:     !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY),
  });
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
      isNewUser: false,
    });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/login — error");
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ── Microsoft Sign-In ──────────────────────────────────────────────────────────
// Standard OAuth2 code flow against Microsoft Identity Platform.
// Requires MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET env vars.
// Supports work/school/personal accounts via the "common" tenant.

const MS_SCOPES = ["openid", "email", "profile", "User.Read"].join(" ");

function getMicrosoftAuthUrl(appUrl: string, state: string): string {
  const clientId = process.env.MICROSOFT_CLIENT_ID ?? "";
  const redirect = `${appUrl}/api/auth/microsoft/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: MS_SCOPES,
    response_mode: "query",
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

router.get("/auth/microsoft", (req: Request, res: Response) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Microsoft sign-in not configured — MICROSOFT_CLIENT_ID missing" });
    return;
  }
  const appUrl = getAppUrl(req.headers.host as string | undefined);
  res.redirect(getMicrosoftAuthUrl(appUrl, "signin"));
});

router.get("/auth/microsoft/callback", async (req: Request, res: Response) => {
  const appUrl = getAppUrl(req.headers.host as string | undefined);
  const { code, error } = req.query;

  if (error || !code) {
    res.redirect(`${appUrl}/?auth=error`);
    return;
  }

  try {
    const clientId = process.env.MICROSOFT_CLIENT_ID ?? "";
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? "";
    const redirect = `${appUrl}/api/auth/microsoft/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code as string,
        redirect_uri: redirect,
        grant_type: "authorization_code",
        scope: MS_SCOPES,
      }),
    });

    if (!tokenRes.ok) {
      req.log.error({ status: tokenRes.status }, "[AUTH] Microsoft token exchange failed");
      res.redirect(`${appUrl}/?auth=error`);
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      oid?: string;
    };

    // Get user profile from Microsoft Graph
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!graphRes.ok) {
      req.log.error({ status: graphRes.status }, "[AUTH] Microsoft Graph /me failed");
      res.redirect(`${appUrl}/?auth=error`);
      return;
    }

    const msUser = (await graphRes.json()) as {
      id: string;
      displayName: string;
      mail?: string;
      userPrincipalName?: string;
    };

    const microsoftOid = msUser.id;
    const email = (msUser.mail ?? msUser.userPrincipalName ?? "").trim().toLowerCase();
    const fullName = (msUser.displayName ?? email.split("@")[0]).trim();

    if (!microsoftOid || !email) {
      req.log.error({ microsoftOid, email }, "[AUTH] Microsoft — missing OID or email");
      res.redirect(`${appUrl}/?auth=error`);
      return;
    }

    const { userName, isNewUser } = await lookupOrCreateMicrosoftUser(microsoftOid, email, fullName);
    const sessionToken = await createSession(userName, email);

    req.log.info({ userName, email, isNewUser }, "[AUTH] Microsoft sign-in — session created");
    res.redirect(`${appUrl}/?token=${encodeURIComponent(sessionToken)}&name=${encodeURIComponent(userName)}&new=${isNewUser ? "1" : "0"}`);
  } catch (err) {
    req.log.error({ err }, "[AUTH] Microsoft callback error");
    res.redirect(`${appUrl}/?auth=error`);
  }
});

// POST /api/auth/microsoft/native — native app: receives a Microsoft access token
// and verifies it against the Graph API. Used by apps that complete the MSAL flow
// natively and exchange the result for a Winston session.
router.post("/auth/microsoft/native", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const { accessToken } = req.body as { accessToken?: string };
  if (!accessToken || typeof accessToken !== "string") {
    res.status(400).json({ error: "accessToken is required" });
    return;
  }

  try {
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!graphRes.ok) {
      res.status(401).json({ error: "Microsoft token validation failed" });
      return;
    }

    const msUser = (await graphRes.json()) as {
      id: string;
      displayName: string;
      mail?: string;
      userPrincipalName?: string;
    };

    const microsoftOid = msUser.id;
    const email = (msUser.mail ?? msUser.userPrincipalName ?? "").trim().toLowerCase();
    const fullName = (msUser.displayName ?? email.split("@")[0]).trim();

    if (!microsoftOid || !email) {
      res.status(401).json({ error: "Microsoft token missing required identity fields" });
      return;
    }

    const { userName, isNewUser } = await lookupOrCreateMicrosoftUser(microsoftOid, email, fullName);
    const sessionToken = await createSession(userName, email);

    req.log.info({ userName, email }, "[AUTH] /auth/microsoft/native — session created");
    res.json({ sessionToken, userName, email, isNewUser });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/microsoft/native — error");
    res.status(401).json({ error: "Microsoft authentication failed" });
  }
});

// ── Apple Sign-In ──────────────────────────────────────────────────────────────
// Web flow: Apple redirects back via POST with code + id_token.
// Native flow: app completes Sign in with Apple and sends the identity token.
// Requires APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY env vars.

router.get("/auth/apple", (req: Request, res: Response) => {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Apple sign-in not configured — APPLE_CLIENT_ID missing" });
    return;
  }
  const appUrl = getAppUrl(req.headers.host as string | undefined);
  const redirect = `${appUrl}/api/auth/apple/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code id_token",
    response_mode: "form_post",
    scope: "name email",
    state: "signin",
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

// Apple sends a POST (form_post) to the callback
router.post("/auth/apple/callback", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
  const appUrl = getAppUrl(req.headers.host as string | undefined);
  const { code, id_token, error, user: userJson } = req.body as {
    code?: string;
    id_token?: string;
    error?: string;
    user?: string;   // JSON string — only on first sign-in
  };

  if (error || (!code && !id_token)) {
    res.redirect(`${appUrl}/?auth=error`);
    return;
  }

  try {
    const clientId = process.env.APPLE_CLIENT_ID ?? "";

    // Verify the id_token using Apple's public JWKS
    const payload = await appleSignin.verifyIdToken(id_token, {
      audience: clientId,
      ignoreExpiration: false,
    }) as { sub: string; email?: string };

    const appleSub = payload.sub;
    const email = payload.email?.trim().toLowerCase() ?? null;

    // Apple only provides name on the FIRST sign-in — it's in a JSON "user" form field
    let fullName: string | null = null;
    if (userJson) {
      try {
        const parsed = JSON.parse(userJson) as { name?: { firstName?: string; lastName?: string } };
        const fn = parsed.name?.firstName ?? "";
        const ln = parsed.name?.lastName ?? "";
        fullName = [fn, ln].filter(Boolean).join(" ") || null;
      } catch { /* ignore parse errors */ }
    }

    if (!appleSub) {
      req.log.error({ appleSub }, "[AUTH] Apple — missing sub in id_token");
      res.redirect(`${appUrl}/?auth=error`);
      return;
    }

    const { userName, isNewUser } = await lookupOrCreateAppleUser(appleSub, email, fullName);
    const sessionToken = await createSession(userName, email ?? `apple-${appleSub}@noemail`);

    req.log.info({ userName, email, isNewUser }, "[AUTH] Apple sign-in — session created");
    res.redirect(`${appUrl}/?token=${encodeURIComponent(sessionToken)}&name=${encodeURIComponent(userName)}&new=${isNewUser ? "1" : "0"}`);
  } catch (err) {
    req.log.error({ err }, "[AUTH] Apple callback error");
    res.redirect(`${appUrl}/?auth=error`);
  }
});

// POST /api/auth/apple/native — native app sends the Apple identity token
// (from expo-apple-authentication or the iOS Sign in with Apple SDK)
router.post("/auth/apple/native", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const { identityToken, fullName: nameObj } = req.body as {
    identityToken?: string;
    fullName?: { givenName?: string; familyName?: string } | null;
  };

  if (!identityToken || typeof identityToken !== "string") {
    res.status(400).json({ error: "identityToken is required" });
    return;
  }

  try {
    const clientId = process.env.APPLE_CLIENT_ID ?? "";

    const payload = await appleSignin.verifyIdToken(identityToken, {
      audience: clientId,
      ignoreExpiration: false,
    }) as { sub: string; email?: string };

    const appleSub = payload.sub;
    const email = payload.email?.trim().toLowerCase() ?? null;

    let fullName: string | null = null;
    if (nameObj?.givenName || nameObj?.familyName) {
      fullName = [nameObj.givenName, nameObj.familyName].filter(Boolean).join(" ");
    }

    if (!appleSub) {
      res.status(401).json({ error: "Apple token missing sub claim" });
      return;
    }

    const { userName, isNewUser } = await lookupOrCreateAppleUser(appleSub, email, fullName);
    const sessionToken = await createSession(userName, email ?? `apple-${appleSub}@noemail`);

    req.log.info({ userName, email }, "[AUTH] /auth/apple/native — session created");
    res.json({ sessionToken, userName, email, isNewUser });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /auth/apple/native — error");
    res.status(401).json({ error: "Apple authentication failed" });
  }
});

// GET /api/integrations/status — returns which integrations the signed-in user has connected
router.get("/integrations/status", async (req: Request, res: Response) => {
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

    const { rows } = await query<{
      provider: string;
      external_email: string | null;
      scopes: string | null;
      connected_at: Date | null;
    }>(
      `SELECT provider, external_email, scopes, connected_at
       FROM user_integrations WHERE user_name = $1 ORDER BY provider`,
      [userName]
    );

    const integrations: Record<string, { connected: boolean; email: string | null; connectedAt: string | null }> = {};
    for (const row of rows) {
      integrations[row.provider] = {
        connected: true,
        email: row.external_email,
        connectedAt: row.connected_at ? row.connected_at.toISOString() : null,
      };
    }

    res.json({ userName, integrations });
  } catch (err) {
    req.log.error({ err }, "[AUTH] /integrations/status error");
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

export { getRedirectUri };
export default router;
