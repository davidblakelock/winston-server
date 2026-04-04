import { Router } from "express";
import {
  saveSubscription,
  removeSubscription,
  getSubscriptions,
  sendPushToAll,
  getVapidPublicKey,
  type PushSubscriptionData,
} from "../push/pushManager.js";
import { logger } from "../lib/logger.js";

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
  logger.info({ body: JSON.stringify(req.body).slice(0, 200) }, "[PUSH] /subscribe received");

  try {
    const {
      endpoint,
      keys,
      userName = "David",
      deviceId,
    } = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userName?: string;
      deviceId?: string;
    };

    // Validate required fields
    if (!endpoint) {
      logger.warn("[PUSH] Missing endpoint in subscribe request");
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    if (!keys?.p256dh || !keys?.auth) {
      logger.warn({ keys: JSON.stringify(keys) }, "[PUSH] Missing keys in subscribe request");
      res.status(400).json({ error: "Missing subscription keys (p256dh / auth)" });
      return;
    }

    const sub: PushSubscriptionData = {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    };

    const userAgent = req.headers["user-agent"] ?? "unknown";

    logger.info(
      {
        userName,
        endpointTail: endpoint.slice(-30),
        userAgent: userAgent.slice(0, 80),
        deviceId: deviceId ?? "none",
      },
      "[PUSH] Saving subscription to Supabase…"
    );

    const savedId = await saveSubscription(userName, sub, userAgent, deviceId);

    logger.info(
      { userName, endpointTail: endpoint.slice(-30), savedId },
      "[PUSH] ✅ Subscription saved to Supabase successfully"
    );

    res.json({ success: true, id: savedId });
  } catch (err) {
    logger.error({ err }, "[PUSH] ❌ Subscribe failed");
    res.status(500).json({ error: "Failed to save subscription" });
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
    const userName = (req.query.userName as string) ?? "David";
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
    const { userName = "David" } = req.body as { userName?: string };
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

    const result = await sendPushToAll(
      {
        title: "Winston — Test Notification ✅",
        body: "Push notifications are working. Emma Peel can reach you.",
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

export default router;
