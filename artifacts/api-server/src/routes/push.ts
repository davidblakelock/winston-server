/**
 * Push notification routes.
 *
 * Two channels are supported:
 *   1. Web push (browser/PWA via VAPID) — handled by the service worker (sw.js)
 *      which shows OS-level notifications with action buttons ("Taken ✓", etc.)
 *   2. Expo push — native Android app
 *
 * Web push routes:
 *   GET    /push/vapid-public-key  Return server's VAPID public key
 *   POST   /push/subscribe         Register a browser push subscription
 *   DELETE /push/subscribe         Remove a browser push subscription
 *
 * Expo push routes:
 *   POST   /push/expo-token        Register an Expo push token
 *   DELETE /push/expo-token        Remove an Expo push token
 *   GET    /push/expo-status       Diagnostic: count registered Expo tokens
 *   GET    /push/calendar-debug    Full diagnostic: Google auth + calendar + Expo tokens
 */

import { Router } from "express";
import {
  saveExpoToken,
  removeExpoToken,
  getExpoTokens,
  getVapidPublicKey,
  saveWebPushSubscription,
  removeWebPushSubscription,
} from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { tryAuthenticate, NATIVE_USER, resolveUserAlias } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { fetchTodayEvents } from "../google/calendar.js";

const router = Router();

// ── Web Push (VAPID) endpoints ────────────────────────────────────────────────

// GET /push/vapid-public-key — return the server's VAPID public key for subscription
router.get("/push/vapid-public-key", (_req, res) => {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    res.status(503).json({ error: "VAPID not configured on server" });
    return;
  }
  res.json({ publicKey });
});

// POST /push/subscribe — register a browser web push subscription
router.post("/push/subscribe", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const { endpoint, keys, userName: bodyUserName, deviceId } = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userName?: string;
    deviceId?: string;
  };
  const userName = authedUser ?? (resolveUserAlias(bodyUserName ?? "") || NATIVE_USER);

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: "Missing endpoint or keys (p256dh/auth)" });
    return;
  }

  try {
    const { id, action } = await saveWebPushSubscription(userName, endpoint, keys.p256dh, keys.auth, deviceId);
    logger.info({ userName, deviceId, endpointTail: endpoint.slice(-30), id, action }, "[WebPush] Subscription saved");
    res.json({ success: true, id, action });
  } catch (err) {
    logger.error({ err }, "[WebPush] Failed to save subscription");
    res.status(500).json({ error: "Failed to save web push subscription" });
  }
});

// DELETE /push/subscribe — remove a browser web push subscription
router.delete("/push/subscribe", async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }
  try {
    await removeWebPushSubscription(endpoint);
    logger.info({ endpointTail: endpoint.slice(-30) }, "[WebPush] Subscription removed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[WebPush] Failed to remove subscription");
    res.status(500).json({ error: "Failed to remove web push subscription" });
  }
});

// ── Expo Push Token endpoints ─────────────────────────────────────────────────

// POST /api/push/expo-token — register an Expo push token from the native app
router.post("/push/expo-token", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const { expoPushToken, userName: bodyUserName, deviceId } = req.body as {
    expoPushToken?: string;
    userName?: string;
    deviceId?: string;
  };
  const userName = authedUser ?? (resolveUserAlias(bodyUserName ?? "") || NATIVE_USER);

  if (!expoPushToken || typeof expoPushToken !== "string") {
    res.status(400).json({ error: "Missing expoPushToken" });
    return;
  }
  if (!expoPushToken.startsWith("ExponentPushToken[") && !expoPushToken.startsWith("ExpoPushToken[")) {
    res.status(400).json({ error: "Invalid expoPushToken format — expected ExponentPushToken[...] or ExpoPushToken[...]" });
    return;
  }

  try {
    const userAgent = (req.headers["user-agent"] ?? "unknown").slice(0, 200);
    const { id, action } = await saveExpoToken(userName, expoPushToken, deviceId, userAgent);
    logger.info({ userName, deviceId, tokenTail: expoPushToken.slice(-20), id, action }, "[Expo Push] Token registered");
    res.json({ success: true, id, action });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Failed to save token");
    res.status(500).json({ error: "Failed to save Expo push token" });
  }
});

// DELETE /api/push/expo-token — remove an Expo push token (on logout / unsubscribe)
router.delete("/push/expo-token", async (req, res) => {
  const { expoPushToken } = req.body as { expoPushToken?: string };
  if (!expoPushToken) {
    res.status(400).json({ error: "Missing expoPushToken" });
    return;
  }
  try {
    await removeExpoToken(expoPushToken);
    logger.info({ tokenTail: expoPushToken.slice(-20) }, "[Expo Push] Token removed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Failed to remove token");
    res.status(500).json({ error: "Failed to remove Expo push token" });
  }
});

// GET /api/push/subscriptions — diagnostic: count all registered push subscriptions
// Helps identify why multiple notifications are received (stale/duplicate subscriptions).
router.get("/push/subscriptions", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const rawQueryUser = req.query.userName as string | undefined;
    const userName = authedUser ?? (rawQueryUser ? resolveUserAlias(rawQueryUser) : null) ?? NATIVE_USER;

    const { query: dbQuery } = await import("../db.js");
    const [webRows, expoTokens] = await Promise.all([
      dbQuery<{ id: number; device_id: string | null; endpoint: string; updated_at: string }>(
        `SELECT id, device_id, right(endpoint, 40) AS endpoint, updated_at::text
           FROM web_push_subscriptions WHERE user_name = $1
           ORDER BY updated_at DESC`,
        [userName]
      ).then((r) => r.rows).catch(() => [] as Array<{ id: number; device_id: string | null; endpoint: string; updated_at: string }>),
      getExpoTokens(userName),
    ]);

    res.json({
      userName,
      webPushCount: webRows.length,
      expoTokenCount: expoTokens.length,
      totalChannels: webRows.length + expoTokens.length,
      webSubscriptions: webRows.map((r) => ({
        id: r.id, deviceId: r.device_id, endpointTail: "…" + r.endpoint, updatedAt: r.updated_at,
      })),
      expoTokenTails: expoTokens.map((t) => "…" + t.slice(-20)),
      note: (webRows.length + expoTokens.length) > 2 ? `⚠️ ${webRows.length + expoTokens.length} channels registered — you may receive duplicate notifications. Use POST /api/push/prune to keep only the most recent.` : "OK",
    });
  } catch (err) {
    logger.error({ err }, "[Push] Subscriptions diagnostic error");
    res.status(500).json({ error: "Diagnostic failed" });
  }
});

// POST /api/push/prune — keep only the most recent N web push subscriptions per user.
// Use this to stop receiving duplicate/triple notifications from stale browser subscriptions.
router.post("/push/prune", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const userName = authedUser ?? NATIVE_USER;
  const keep = Math.max(1, parseInt(String((req.body as Record<string, unknown>).keep ?? "1"), 10));

  try {
    const { query: dbQuery } = await import("../db.js");
    const { rows } = await dbQuery<{ id: number; endpoint: string }>(
      `SELECT id, right(endpoint, 40) AS endpoint
         FROM web_push_subscriptions WHERE user_name = $1
         ORDER BY updated_at DESC`,
      [userName]
    );
    const toDelete = rows.slice(keep);
    if (toDelete.length === 0) {
      res.json({ pruned: 0, kept: rows.length, message: "Nothing to prune" });
      return;
    }
    const ids = toDelete.map((r) => r.id);
    await dbQuery(
      `DELETE FROM web_push_subscriptions WHERE id = ANY($1::int[]) RETURNING id`,
      [ids]
    );
    logger.info({ userName, pruned: ids.length, kept: rows.length - ids.length }, "[WebPush] Pruned old subscriptions");
    res.json({ pruned: ids.length, kept: rows.length - ids.length, message: `Removed ${ids.length} old subscription(s). You should now receive only ${rows.length - ids.length} notification per push.` });
  } catch (err) {
    logger.error({ err }, "[Push] Prune error");
    res.status(500).json({ error: "Prune failed" });
  }
});

// GET /api/push/expo-status — diagnostic: count registered Expo tokens
router.get("/push/expo-status", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const rawQueryUser = req.query.userName as string | undefined;
    const userName = authedUser ?? (rawQueryUser ? resolveUserAlias(rawQueryUser) : null) ?? NATIVE_USER;
    const tokens = await getExpoTokens(userName);
    res.json({ userName, tokenCount: tokens.length, tokens: tokens.map((t) => "…" + t.slice(-20)) });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Status check error");
    res.status(500).json({ error: "Status check failed" });
  }
});

// GET /api/push/calendar-debug — full diagnostic: Google auth + calendar + Expo tokens
router.get("/push/calendar-debug", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const userName = authedUser ?? (req.query.userName as string | undefined) ?? NATIVE_USER;

  const result: Record<string, unknown> = { userName, ts: new Date().toISOString() };

  // Step 1: Can we get an auth client?
  let authClient: Awaited<ReturnType<typeof getAuthClientForUser>> | null = null;
  try {
    authClient = await getAuthClientForUser(userName);
    result.authClientOk = !!authClient;
  } catch (err) {
    result.authClientOk = false;
    result.authClientError = (err as Error)?.message ?? String(err);
    res.json(result);
    return;
  }

  // Step 2: Explicitly refresh/check the access token
  if (authClient) {
    try {
      const tokenResp = await authClient.getAccessToken();
      result.accessTokenOk = !!tokenResp?.token;
      result.accessTokenPrefix = tokenResp?.token ? tokenResp.token.slice(0, 20) + "…" : null;
    } catch (err) {
      result.accessTokenOk = false;
      result.accessTokenError = (err as Error)?.message ?? String(err);
    }
  }

  // Step 3: Fetch today's events
  try {
    const events = await fetchTodayEvents(userName);
    result.eventsNull = events === null;
    result.eventCount = events?.length ?? 0;
    result.events = events?.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      startIso: e.startIso,
      hasLocation: !!(e.location || e.description),
      allDay: e.allDay,
    })) ?? [];
  } catch (err) {
    result.fetchEventsError = (err as Error)?.message ?? String(err);
  }

  // Step 4: Check Expo tokens
  try {
    const tokens = await getExpoTokens(userName);
    result.expoTokenCount = tokens.length;
    result.expoTokenTails = tokens.map((t) => "…" + t.slice(-20));
  } catch (err) {
    result.expoTokenError = (err as Error)?.message ?? String(err);
  }

  logger.info(result, "[CalendarDebug] Full diagnostic result");
  res.json(result);
});

export default router;
