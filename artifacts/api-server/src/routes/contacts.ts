import { Router, type Request, type Response } from "express";
import { query } from "../db.js";

const router = Router();

// ── GET /contacts/test ────────────────────────────────────────────────────────
// Calls the People API with David's current stored OAuth token and returns the
// raw response so we can diagnose why connections returns empty.
// Full public URL: /api/contacts/test
router.get("/contacts/test", async (_req: Request, res: Response) => {
  try {
    // 1. Load token from DB (same pattern as contacts.ts getAccessToken)
    const { rows } = await query<{
      access_token: string;
      refresh_token: string;
      token_expiry: string;
      scope: string;
      email: string;
    }>(
      `SELECT access_token, refresh_token, token_expiry, scope, email
       FROM google_auth WHERE user_name = 'David' LIMIT 1`
    );

    if (!rows || !rows.length) {
      return res.status(404).json({ error: "No google_auth row for David" });
    }

    const row = rows[0];
    const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
    const isExpired = expiry > 0 && Date.now() > expiry - 60_000;
    let accessToken = row.access_token;

    // 2. Refresh if expired
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
        scope?: string;
        error?: string;
      };
      if (refreshData.access_token) {
        accessToken = refreshData.access_token;
      }
    }

    // 3. Confirm whose account this token is for (userinfo)
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userInfo = (await userInfoRes.json()) as { email?: string; name?: string; sub?: string };

    // 4. people/me — sanity check (own profile card)
    const meRes = await fetch(
      "https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses,phoneNumbers",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const meStatus = meRes.status;
    const meData = await meRes.json();

    // 5. connections — the main contacts endpoint
    const connectionsUrl =
      "https://people.googleapis.com/v1/people/me/connections" +
      "?personFields=names,emailAddresses,phoneNumbers" +
      "&pageSize=10" +
      "&sortOrder=LAST_MODIFIED_DESCENDING";

    const connRes = await fetch(connectionsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const connStatus = connRes.status;
    const connRaw = await connRes.text();
    let connData: unknown;
    try { connData = JSON.parse(connRaw); } catch { connData = connRaw; }

    // 6. otherContacts — contacts not in a group
    const otherUrl =
      "https://people.googleapis.com/v1/otherContacts" +
      "?readMask=names,emailAddresses,phoneNumbers" +
      "&pageSize=10";

    const otherRes = await fetch(otherUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const otherStatus = otherRes.status;
    const otherRaw = await otherRes.text();
    let otherData: unknown;
    try { otherData = JSON.parse(otherRaw); } catch { otherData = otherRaw; }

    return res.json({
      step2_token_diagnosis: {
        stored_email: row.email,
        token_expired_was: isExpired,
        stored_scope: row.scope,
        has_contacts_readonly: row.scope?.includes("contacts.readonly"),
        token_length: accessToken?.length,
      },
      step2_userinfo: {
        authenticated_as_email: userInfo.email,
        authenticated_as_name: userInfo.name,
        google_sub: userInfo.sub,
      },
      step4_people_me: {
        status: meStatus,
        data: meData,
      },
      step1_step3_step5_connections: {
        url: connectionsUrl,
        status: connStatus,
        raw_response: connRaw.slice(0, 2000),
        total_connections: (connData as any)?.connections?.length ?? 0,
        total_people_in_api: (connData as any)?.totalPeople ?? null,
        error: (connData as any)?.error ?? null,
      },
      other_contacts: {
        url: otherUrl,
        status: otherStatus,
        raw_response: otherRaw.slice(0, 1000),
        total: (otherData as any)?.otherContacts?.length ?? 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
