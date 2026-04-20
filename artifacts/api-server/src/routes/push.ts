import { Router } from "express";
import {
  saveSubscription,
  saveSubscriptionWithAction,
  removeSubscription,
  getSubscriptions,
  sendPushToAll,
  getVapidPublicKey,
  saveExpoToken,
  removeExpoToken,
  getExpoTokens,
  type PushSubscriptionData,
} from "../push/pushManager.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";
import { authenticate, tryAuthenticate, NATIVE_USER } from "../auth/middleware.js";

const router = Router();

// GET /api/push/vapid-public-key — return the VAPID public key to the frontend
router.get("/push/vapid-public-key", (_req, res) => {
  const key = getVapidPublicKey();
  logger.info({ configured: !!key }, "[PUSH] VAPID public key requested");
  if (!key) {
    res.status(503).json({ error: "Push notifications not configured — VAPID keys missing" });
    return;
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — save a push subscription to Supabase
router.post("/push/subscribe", async (req, res) => {
  const body = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userName?: string;
    deviceId?: string;
  };

  logger.info(
    { endpointTail: body.endpoint?.slice(-40) ?? "MISSING", userName: body.userName, deviceId: body.deviceId },
    "[PUSH STEP B1] Subscribe request received"
  );

  // STEP B2 — Resolve user: prefer auth header, fall back to body.userName (native compat)
  const authedUser = await tryAuthenticate(req);
  const { endpoint, keys, userName: bodyUserName, deviceId } = body;
  const userName = authedUser ?? bodyUserName ?? NATIVE_USER;

  if (!endpoint) {
    logger.warn("[PUSH STEP B2] FAIL — Missing endpoint in request body");
    res.status(400).json({ error: "Missing endpoint" });
    return;
  }
  if (!keys?.p256dh || !keys?.auth) {
    logger.warn({ hasP256dh: !!keys?.p256dh, hasAuth: !!keys?.auth }, "[PUSH STEP B2] FAIL — Missing subscription keys");
    res.status(400).json({ error: "Missing subscription keys (p256dh / auth)" });
    return;
  }
  logger.info("[PUSH STEP B2] Payload validated — endpoint, p256dh, auth all present");

  try {
    const sub: PushSubscriptionData = {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    };

    const userAgent = (req.headers["user-agent"] ?? "unknown").slice(0, 200);

    // STEP B3 — Upsert into Supabase
    logger.info(
      { userName, endpointTail: endpoint.slice(-40), deviceId: deviceId ?? "none", userAgent: userAgent.slice(0, 100) },
      "[PUSH STEP B3] Upserting subscription into Supabase push_subscriptions…"
    );

    const { id, action } = await saveSubscriptionWithAction(userName, sub, userAgent, deviceId);

    // STEP B4 — Return result
    logger.info(
      { userName, deviceId: deviceId ?? "none", endpointTail: endpoint.slice(-40), id, action },
      "[PUSH STEP B4] ✅ Subscription saved successfully"
    );

    res.json({ success: true, id, action });
  } catch (err) {
    logger.error({ err, endpoint: endpoint?.slice(-40), userName }, "[PUSH STEP B3] ❌ Supabase upsert failed");
    res.status(500).json({ error: "Failed to save subscription to database" });
  }
});

// DELETE /api/push/subscribe — remove a push subscription
router.delete("/push/subscribe", async (req, res) => {
  try {
    const { endpoint } = req.body as { endpoint: string };
    if (!endpoint) {
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    logger.info({ endpointTail: endpoint.slice(-30) }, "[PUSH] Removing subscription");
    await removeSubscription(endpoint);
    logger.info({ endpointTail: endpoint.slice(-30) }, "[PUSH] Subscription removed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[PUSH] Unsubscribe error");
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

// GET /api/push/status — check subscription count for current user (diagnostic)
router.get("/push/status", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const userName = authedUser ?? (req.query.userName as string) ?? NATIVE_USER;
    const subs = await getSubscriptions(userName);
    logger.info({ userName, count: subs.length }, "[PUSH] Status check");
    res.json({
      userName,
      subscriptionCount: subs.length,
      endpoints: subs.map((s) => "…" + s.endpoint.slice(-30)),
    });
  } catch (err) {
    logger.error({ err }, "[PUSH] Status check error");
    res.status(500).json({ error: "Status check failed" });
  }
});

// POST /api/push/test — send an immediate test push to all subscriptions for the user
router.post("/push/test", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const { userName: bodyUserName } = req.body as { userName?: string };
    const userName = authedUser ?? bodyUserName ?? NATIVE_USER;
    logger.info({ userName }, "[PUSH] Test push requested");

    const vapidKey = getVapidPublicKey();
    if (!vapidKey) {
      res.status(503).json({ error: "Push not configured — VAPID keys missing on server" });
      return;
    }

    const subs = await getSubscriptions(userName);
    logger.info({ userName, subCount: subs.length }, "[PUSH] Subscriptions found for test");

    if (subs.length === 0) {
      res.status(404).json({
        error: "No push subscriptions found for this user",
        hint: "Open Winston in your browser, grant notification permission, then try again",
      });
      return;
    }

    const profile = await getProfile(userName).catch(() => null);
    const companionNameForTest = profile?.companionName ?? "Your Companion";

    const result = await sendPushToAll(
      {
        title: "Winston — Test Notification ✅",
        body: `Push notifications are working. ${companionNameForTest} can reach you.`,
        tag: "winston-test",
        requireInteraction: false,
      },
      userName
    );

    logger.info({ userName, ...result }, "[PUSH] Test push complete");
    res.json({ success: true, sent: result.sent, failed: result.failed, total: subs.length });
  } catch (err) {
    logger.error({ err }, "[PUSH] Test push error");
    res.status(500).json({ error: "Test push failed" });
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
  const userName = authedUser ?? bodyUserName ?? NATIVE_USER;

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

// GET /api/push/expo-status — diagnostic: count registered Expo tokens
router.get("/push/expo-status", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const userName = authedUser ?? (req.query.userName as string) ?? NATIVE_USER;
    const tokens = await getExpoTokens(userName);
    res.json({ userName, tokenCount: tokens.length, tokens: tokens.map((t) => "…" + t.slice(-20)) });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Status check error");
    res.status(500).json({ error: "Status check failed" });
  }
});

export default router;
