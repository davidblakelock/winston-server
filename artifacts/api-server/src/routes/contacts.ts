import { Router, type Request, type Response } from "express";
import express from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";
import { authenticate, NATIVE_STORED_NAME, NATIVE_API_KEY } from "../auth/middleware.js";
import { createGoogleContact, updateGoogleContact, searchContacts } from "../google/contacts.js";

const router = Router();

// ── GET /api/contacts/search?q={query} ───────────────────────────────────────
// Live search of the user's Google Contacts via the People API.
// Returns matching contacts with name, email, and phone fields.
// Response: { contacts: [{ name, email?, phone? }] }
// If the Google account isn't connected or lacks contacts scope, returns
// { contacts: [], needsReauth: true }.
router.get("/contacts/search", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const q = (req.query["q"] as string | undefined)?.trim();
  if (!q) {
    res.status(400).json({ error: "q query parameter is required" });
    return;
  }

  try {
    const result = await searchContacts(q, userName);

    const contacts = result.contacts.map((c) => ({
      name: c.name,
      ...(c.phone        ? { phone: c.phone }               : {}),
      ...(c.email        ? { email: c.email }               : {}),
      ...(c.address      ? { address: c.address }           : {}),
      ...(c.organization ? { organization: c.organization } : {}),
      ...(c.website      ? { website: c.website }           : {}),
      ...(c.birthday     ? { birthday: c.birthday }         : {}),
      ...(c.notes        ? { notes: c.notes }               : {}),
      ...(c.resourceName ? { resourceName: c.resourceName } : {}),
    }));

    req.log.info({ userName, q, count: contacts.length }, "[CONTACTS] GET /contacts/search");
    res.json({ contacts, needsReauth: result.needsReauth ?? false });
  } catch (err) {
    req.log.error({ err }, "[CONTACTS] GET /contacts/search error");
    res.status(500).json({ error: "Failed to search contacts" });
  }
});

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

// ── POST /api/contacts/create ─────────────────────────────────────────────────
// Create a new contact in the user's Google Contacts (requires contacts write scope).
// Body: { name: string, phone?: string, email?: string, address?: string, notes?: string }
// Response: { ok: true, resourceName?, needsReauth? }
router.post("/contacts/create", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { name, phone, email, address, notes } = req.body as {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const result = await createGoogleContact(
      { name: name.trim(), phone: phone?.trim(), email: email?.trim(), address: address?.trim(), notes: notes?.trim() },
      userName,
    );
    if (!result.ok) {
      if (result.needsReauth) {
        res.status(403).json({ error: result.error, needsReauth: true });
        return;
      }
      res.status(500).json({ error: result.error ?? "Failed to create contact" });
      return;
    }
    req.log.info({ userName, name, resourceName: result.resourceName }, "[CONTACTS] Contact created");
    res.json({ ok: true, resourceName: result.resourceName });
  } catch (err) {
    req.log.error({ err }, "[CONTACTS] POST /contacts/create error");
    res.status(500).json({ error: "Failed to create contact" });
  }
});

// ── POST /api/contacts/update ─────────────────────────────────────────────────
// Update fields on an existing Google contact.
// Looks up by resourceName (preferred) or searches by name to find resourceName.
// Body: { resourceName?: string, name?: string, phone?: string, email?: string, address?: string, notes?: string }
// Response: { ok: true, resourceName }
router.post("/contacts/update", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { resourceName, name, phone, email, address, notes } = req.body as {
    resourceName?: string;
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
  };

  const updates = { phone, email, address, notes };
  const hasUpdates = Object.values(updates).some((v) => v !== undefined);

  if (!hasUpdates) {
    res.status(400).json({ error: "At least one field to update (phone, email, address, notes) is required" });
    return;
  }

  try {
    let resolvedResourceName = resourceName;

    // If no resourceName, look it up by name via Google search
    if (!resolvedResourceName && name) {
      const searchResult = await searchContacts(name.trim(), userName);
      const contact = searchResult.contacts[0];
      if (!contact?.resourceName) {
        res.status(404).json({ error: `Contact "${name}" not found` });
        return;
      }
      resolvedResourceName = contact.resourceName;
    }

    if (!resolvedResourceName) {
      res.status(400).json({ error: "Either resourceName or name is required to identify the contact" });
      return;
    }

    const result = await updateGoogleContact(userName, resolvedResourceName, updates);
    if (!result.ok) {
      if (result.needsReauth) {
        res.status(403).json({ error: result.error, needsReauth: true });
        return;
      }
      res.status(500).json({ error: result.error ?? "Failed to update contact" });
      return;
    }

    req.log.info({ userName, resourceName: resolvedResourceName }, "[CONTACTS] Contact updated");
    res.json({ ok: true, resourceName: resolvedResourceName });
  } catch (err) {
    req.log.error({ err }, "[CONTACTS] POST /contacts/update error");
    res.status(500).json({ error: "Failed to update contact" });
  }
});

// ── Contact push links ────────────────────────────────────────────────────────
// These endpoints allow a contact (e.g. Sarah) to link her Winston account to
// an entry in another user's (David's) contact list, enabling David to send
// push notifications directly to Sarah's device via reminders.

// POST /api/contacts/push-link
// Called by the contact (Sarah) to register themselves under another user's contacts.
// Body: { ownerUserName: "davidblakelock", contactName: "Sarah" }
router.post("/contacts/push-link", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers["x-api-key"] as string | undefined;
    let linkedUserName: string | null = null;

    if (apiKey === NATIVE_API_KEY) {
      linkedUserName = NATIVE_STORED_NAME;
    } else if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) linkedUserName = session.userName;
    }

    if (!linkedUserName) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const { ownerUserName, contactName } = req.body as {
      ownerUserName?: string;
      contactName?: string;
    };

    if (!ownerUserName || !contactName) {
      res.status(400).json({ error: "ownerUserName and contactName are required" });
      return;
    }

    // Confirm the owner actually exists
    const { rows: ownerRows } = await query<{ user_name: string }>(
      "SELECT user_name FROM user_profiles WHERE user_name = $1 LIMIT 1",
      [ownerUserName]
    );
    if (!ownerRows.length) {
      res.status(404).json({ error: "Owner user not found" });
      return;
    }

    await query(
      `INSERT INTO contact_push_links (owner_user_name, contact_name, linked_user_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_name, linked_user_name) DO UPDATE SET
         contact_name = EXCLUDED.contact_name
       RETURNING owner_user_name`,
      [ownerUserName, contactName.trim(), linkedUserName]
    );

    res.json({ ok: true, ownerUserName, contactName: contactName.trim(), linkedUserName });
  } catch (err) {
    req.log.error({ err }, "[ContactPush] push-link POST error");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/contacts/push-links
// Returns all push links for the authenticated user (as owner), so David can
// see which of his contacts have Winston installed and are linked.
router.get("/contacts/push-links", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers["x-api-key"] as string | undefined;
    let ownerUserName: string | null = null;

    if (apiKey === NATIVE_API_KEY) {
      ownerUserName = NATIVE_STORED_NAME;
    } else if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) ownerUserName = session.userName;
    }

    if (!ownerUserName) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const { rows } = await query<{
      id: number;
      contact_name: string;
      linked_user_name: string;
      created_at: string;
    }>(
      `SELECT id, contact_name, linked_user_name, created_at
       FROM contact_push_links
       WHERE owner_user_name = $1
       ORDER BY contact_name`,
      [ownerUserName]
    );

    res.json({ links: rows });
  } catch (err) {
    req.log.error({ err }, "[ContactPush] push-links GET error");
    res.status(500).json({ error: "internal_error" });
  }
});

// DELETE /api/contacts/push-link
// Called by either the owner (David) or the linked user (Sarah) to remove a link.
// Body: { ownerUserName?, linkedUserName? } — at least one must match the caller.
router.delete("/contacts/push-link", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const apiKey = req.headers["x-api-key"] as string | undefined;
    let callerUserName: string | null = null;

    if (apiKey === NATIVE_API_KEY) {
      callerUserName = NATIVE_STORED_NAME;
    } else if (authHeader?.startsWith("Bearer ")) {
      const session = await validateSession(authHeader.slice(7));
      if (session) callerUserName = session.userName;
    }

    if (!callerUserName) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const { ownerUserName, linkedUserName } = req.body as {
      ownerUserName?: string;
      linkedUserName?: string;
    };

    // Caller must be either the owner or the linked user
    if (callerUserName !== ownerUserName && callerUserName !== linkedUserName) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    await query(
      `DELETE FROM contact_push_links
       WHERE owner_user_name = $1 AND linked_user_name = $2
       RETURNING owner_user_name`,
      [ownerUserName ?? callerUserName, linkedUserName ?? callerUserName]
    );

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[ContactPush] push-link DELETE error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
