import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";

const router = Router();

// ── GET /contacts/test ────────────────────────────────────────────────────────
// Diagnostic endpoint — calls People API using the token from the current session.
// Full public URL: GET /api/contacts/test
// Requires: Authorization: Bearer <session-token> header (same as every other API call)
router.get("/contacts/test", async (req: Request, res: Response) => {
  try {
    // 1. Validate Winston session from Authorization header (mirrors every other protected route)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.json({ error: "no session — send Authorization: Bearer <session-token>" });
    }
    const session = await validateSession(authHeader.slice(7));
    if (!session) {
      return res.json({ error: "invalid or expired session" });
    }

    // 2. Load the Google OAuth token from google_auth (keyed by userName)
    const { rows } = await query<{
      access_token: string;
      refresh_token: string;
      token_expiry: string;
      scope: string;
      email: string;
    }>(
      `SELECT access_token, refresh_token, token_expiry, scope, email
       FROM google_auth WHERE user_name = $1 LIMIT 1`,
      [session.userName]
    );

    if (!rows || !rows.length || !rows[0].access_token) {
      return res.json({
        error: "no google_auth token found for this user",
        session_user: session.userName,
        session_email: session.email,
      });
    }

    const row = rows[0];
    const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
    const isExpired = expiry > 0 && Date.now() > expiry - 60_000;
    let accessToken = row.access_token;

    // 3. Refresh token if expired
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

    // 4. Verify whose account this token belongs to
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userInfo = (await userInfoRes.json()) as { email?: string; name?: string; sub?: string };

    // 5. Call People API connections endpoint (exact URL the user specified)
    const peopleUrl =
      "https://people.googleapis.com/v1/people/me/connections" +
      "?personFields=names,emailAddresses,phoneNumbers&pageSize=10";

    const response = await fetch(peopleUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const status = response.status;
    const data = await response.json();

    // 6. Return everything
    return res.json({
      // Session info — which Winston account is logged in
      session: {
        userName: session.userName,
        sessionEmail: session.email,
        googleId: session.googleId,
      },
      // google_auth — which Google account holds the API token
      google_auth: {
        storedEmail: row.email,
        storedScope: row.scope,
        hasContactsReadonly: row.scope?.includes("contacts.readonly"),
        tokenExpiredWas: isExpired,
        tokenPrefix: accessToken ? accessToken.substring(0, 20) : "none",
      },
      // Userinfo — whose Google account the token actually authenticates as
      tokenBelongsTo: {
        email: userInfo.email,
        name: userInfo.name,
        sub: userInfo.sub,
      },
      // People API raw result
      status,
      data,
      // Derived summary
      totalConnections: (data as any)?.connections?.length ?? 0,
      totalPeople: (data as any)?.totalPeople ?? null,
    });
  } catch (e: unknown) {
    return res.json({ error: (e as Error).message });
  }
});

export default router;
