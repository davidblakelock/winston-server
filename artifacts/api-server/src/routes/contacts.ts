import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";

const router = Router();

// ── GET /contacts/test ────────────────────────────────────────────────────────
// Diagnostic endpoint — calls People API with the best available Google token.
// Full public URL: GET /api/contacts/test
//
// Auth is optional — the endpoint works three ways (in priority order):
//   1. Authorization: Bearer <session-token> header  (same as every other route)
//   2. ?token=<session-token> query param           (browser-friendly)
//   3. No auth — reads directly from google_auth DB  (fallback for bare browser testing)
router.get("/contacts/test", async (req: Request, res: Response) => {
  try {
    // ── 1. Resolve session if a token was provided (header or query param) ──────
    let sessionInfo: { userName: string; email: string } | null = null;

    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const rawToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : queryToken ?? null;

    if (rawToken) {
      const session = await validateSession(rawToken);
      if (session) {
        sessionInfo = { userName: session.userName, email: session.email };
      }
    }

    // ── 2. Load Google OAuth token from google_auth ────────────────────────────
    // If we have a session, look up by userName. Otherwise use the best available
    // token (same priority logic as contacts.ts: prefer personal accounts).
    const tokenQuery = sessionInfo
      ? `SELECT user_name, access_token, refresh_token, token_expiry, scope, email
         FROM google_auth WHERE user_name = $1 LIMIT 1`
      : `SELECT user_name, access_token, refresh_token, token_expiry, scope, email
         FROM google_auth
         ORDER BY
           CASE WHEN email NOT LIKE '%winston%' THEN 0 ELSE 1 END,
           updated_at DESC NULLS LAST
         LIMIT 1`;

    const { rows } = await query<{
      user_name: string;
      access_token: string;
      refresh_token: string;
      token_expiry: string;
      scope: string;
      email: string;
    }>(tokenQuery, sessionInfo ? [sessionInfo.userName] : []);

    if (!rows || !rows.length || !rows[0].access_token) {
      return res.json({
        error: "no google_auth token found",
        session: sessionInfo,
        hint: "Pass ?token=<your-session-token> or Authorization: Bearer <token> to identify yourself",
      });
    }

    const row = rows[0];
    const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
    const isExpired = expiry > 0 && Date.now() > expiry - 60_000;
    let accessToken = row.access_token;

    // ── 3. Refresh token if expired ────────────────────────────────────────────
    if (isExpired && row.refresh_token) {
      const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID ?? "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
          refresh_token: row.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const refreshData = (await refreshRes.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (refreshData.access_token) {
        accessToken = refreshData.access_token;
      }
    }

    // ── 4. Verify whose Google account this token belongs to ───────────────────
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userInfo = (await userInfoRes.json()) as {
      email?: string;
      name?: string;
      sub?: string;
    };

    // ── 5. Call People API connections endpoint ────────────────────────────────
    const peopleUrl =
      "https://people.googleapis.com/v1/people/me/connections" +
      "?personFields=names,emailAddresses,phoneNumbers&pageSize=10";

    const response = await fetch(peopleUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const status = response.status;
    const data = (await response.json()) as {
      connections?: unknown[];
      totalPeople?: number;
      totalItems?: number;
      error?: unknown;
      nextPageToken?: string;
    };

    // ── 6. Return everything ───────────────────────────────────────────────────
    return res.json({
      session: sessionInfo
        ? { userName: sessionInfo.userName, email: sessionInfo.email }
        : { note: "no session token provided — used best available google_auth row" },
      google_auth: {
        storedEmail: row.email,
        storedScope: row.scope,
        hasContactsReadonly: row.scope?.includes("contacts.readonly"),
        tokenExpiredWas: isExpired,
        tokenPrefix: accessToken ? accessToken.substring(0, 20) : "none",
      },
      tokenBelongsTo: {
        email: userInfo.email,
        name: userInfo.name,
        sub: userInfo.sub,
      },
      status,
      data,
      totalConnections: data?.connections?.length ?? 0,
      totalPeople: data?.totalPeople ?? null,
    });
  } catch (e: unknown) {
    return res.json({ error: (e as Error).message });
  }
});

export default router;
