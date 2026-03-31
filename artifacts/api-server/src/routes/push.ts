import { Router } from "express";
import {
  saveSubscription,
  removeSubscription,
  getVapidPublicKey,
  type PushSubscriptionData,
} from "../push/pushManager.js";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /api/push/vapid-public-key — return the VAPID public key to the frontend
router.get("/push/vapid-public-key", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — save a push subscription
router.post("/push/subscribe", async (req, res) => {
  try {
    const { endpoint, keys, userName = "David" } = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userName?: string;
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ error: "Invalid subscription data" });
      return;
    }

    const sub: PushSubscriptionData = {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    };

    const userAgent = req.headers["user-agent"];
    await saveSubscription(userName, sub, userAgent);
    logger.info({ userName, endpoint: endpoint.slice(-20) }, "Push subscription saved");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Push subscribe error");
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
    await removeSubscription(endpoint);
    logger.info({ endpoint: endpoint.slice(-20) }, "Push subscription removed");
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Push unsubscribe error");
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

export default router;
