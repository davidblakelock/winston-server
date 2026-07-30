import { Router, type IRouter, type Request, type Response } from "express";
import { parseWebhookEvent } from "../orders/easypostManager.js";
import { applyEasyPostTrackerUpdate } from "../orders/easypostSync.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.post("/easypost/webhook", async (req: Request, res: Response) => {
  // Respond immediately — EasyPost requires 2XX within 30 seconds
  res.status(200).json({ received: true });

  // Process in background
  (async () => {
    logger.info({ body: JSON.stringify(req.body).slice(0, 200) }, "[EasyPost] Webhook received");
    try {
      const parsed = parseWebhookEvent(req.body);
      if (!parsed) {
        logger.info("[EasyPost] Webhook ignored — not a tracker.updated event");
        return;
      }

      await applyEasyPostTrackerUpdate(parsed.trackerId, {
        status: parsed.status,
        carrier: parsed.carrier,
        estDeliveryDate: parsed.estDeliveryDate,
        trackingEvents: parsed.trackingEvents,
      });
    } catch (err) {
      logger.error({ err }, "[EasyPost] Webhook processing failed");
    }
  })();
});

export default router;
