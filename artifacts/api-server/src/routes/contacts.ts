import { Router, type Request, type Response } from "express";
import { validateSession } from "../auth/sessionAuth.js";
import { query } from "../db.js";
import { authenticate, NATIVE_STORED_NAME, NATIVE_API_KEY } from "../auth/middleware.js";

const router = Router();

// ── Fuzzy name matching helpers ───────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Returns true when two contact names are likely the same person. */
function areLikelyDuplicates(nameA: string, nameB: string): boolean {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (a === b) return true;

  // One name's tokens are all present in the other (e.g. "Olivia" vs "Olivia Blakelock")
  const tokA = a.split(" ").filter(Boolean);
  const tokB = b.split(" ").filter(Boolean);
  const aInB = tokA.every((t) => tokB.includes(t));
  const bInA = tokB.every((t) => tokA.includes(t));
  if (aInB || bInA) return true;

  // Edit distance ≤ 2 on full normalized name (catches Bonnet/Bonnett)
  if (levenshtein(a, b) <= 2) return true;

  // Edit distance ≤ 1 on the longer token when first tokens match (Dr David Bonnet / David Bonnett)
  if (tokA[0] === tokB[0] && tokA.length >= 2 && tokB.length >= 2) {
    const lastA = tokA[tokA.length - 1];
    const lastB = tokB[tokB.length - 1];
    if (levenshtein(lastA, lastB) <= 2) return true;
  }

  return false;
}

/** Merge two detail strings: combine unique semicolon-separated facts. */
function mergeDetails(a: string, b: string): string {
  const parse = (s: string) =>
    s.split("|").map((p) => p.trim()).filter(Boolean);
  const combined = [...new Set([...parse(a), ...parse(b)])];
  return combined.join(" | ");
}

interface ContactRow {
  id: number;
  name: string;
  detail: string;
  created_at: string;
}

export interface DuplicateGroup {
  contacts: ContactRow[];
  suggestedMerge: {
    name: string;
    detail: string;
    keepId: number;
    discardIds: number[];
  };
}

// ── GET /api/contacts/duplicates ──────────────────────────────────────────────
router.get("/contacts/duplicates", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { rows } = await query<ContactRow>(
    `SELECT id, name, detail, created_at FROM profile_items
     WHERE user_name = $1 AND category = 'people'
     ORDER BY created_at ASC`,
    [userName]
  );

  // Build groups of duplicates using union-find
  const parent = new Map<number, number>();
  const getId = (id: number) => {
    while (parent.get(id) !== undefined && parent.get(id) !== id) {
      id = parent.get(id)!;
    }
    return id;
  };
  const union = (a: number, b: number) => {
    const ra = getId(a), rb = getId(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (areLikelyDuplicates(rows[i].name, rows[j].name)) {
        union(rows[i].id, rows[j].id);
      }
    }
  }

  // Collect groups
  const groups = new Map<number, ContactRow[]>();
  for (const row of rows) {
    const root = getId(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row);
  }

  const duplicateGroups: DuplicateGroup[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Pick the richest name (longest, most complete) as canonical
    const canonical = [...group].sort(
      (a, b) => b.name.trim().length - a.name.trim().length
    )[0];
    const mergedDetail = group.reduce(
      (acc, c) => mergeDetails(acc, c.detail),
      ""
    );

    duplicateGroups.push({
      contacts: group,
      suggestedMerge: {
        name: canonical.name.trim(),
        detail: mergedDetail,
        keepId: canonical.id,
        discardIds: group.filter((c) => c.id !== canonical.id).map((c) => c.id),
      },
    });
  }

  res.json({ duplicates: duplicateGroups, total: duplicateGroups.length });
});

// ── POST /api/contacts/merge ──────────────────────────────────────────────────
// Body: { keepId: number, discardIds: number[], mergedName?: string, mergedDetail?: string }
router.post("/contacts/merge", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { keepId, discardIds, mergedName, mergedDetail } =
    req.body as {
      keepId: number;
      discardIds: number[];
      mergedName?: string;
      mergedDetail?: string;
    };

  if (!keepId || !discardIds?.length) {
    res.status(400).json({ error: "keepId and discardIds are required" });
    return;
  }

  // Verify all IDs belong to this user
  const allIds = [keepId, ...discardIds];
  const { rows: owned } = await query<{ id: number }>(
    `SELECT id FROM profile_items WHERE id = ANY($1::int[]) AND user_name = $2`,
    [allIds, userName]
  );
  if (owned.length !== allIds.length) {
    res.status(403).json({ error: "one or more contact IDs not found for this user" });
    return;
  }

  // Fetch all rows to build merged detail if not supplied
  const { rows: contactRows } = await query<ContactRow>(
    `SELECT id, name, detail FROM profile_items WHERE id = ANY($1::int[])`,
    [allIds]
  );

  const finalDetail =
    mergedDetail ??
    contactRows.reduce((acc, c) => mergeDetails(acc, c.detail), "");
  const keepRow = contactRows.find((r) => r.id === keepId)!;
  const finalName = mergedName ?? keepRow.name.trim();

  // Update the keeper
  await query(
    `UPDATE profile_items SET name = $1, detail = $2 WHERE id = $3`,
    [finalName, finalDetail, keepId]
  );

  // Delete the discards
  await query(
    `DELETE FROM profile_items WHERE id = ANY($1::int[]) AND user_name = $2`,
    [discardIds, userName]
  );

  res.json({
    merged: { id: keepId, name: finalName, detail: finalDetail },
    deleted: discardIds,
  });
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
         contact_name = EXCLUDED.contact_name`,
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
       WHERE owner_user_name = $1 AND linked_user_name = $2`,
      [ownerUserName ?? callerUserName, linkedUserName ?? callerUserName]
    );

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[ContactPush] push-link DELETE error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
