import { Router, type IRouter, type Request, type Response } from "express";
import { getSettings, updateSettings, getTonightMessage } from "../winddown/winddownManager.js";

const router: IRouter = Router();

router.get("/winddown/settings", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to get wind-down settings" });
  }
});

// Native app calls this after tapping the wind-down push notification to retrieve
// tonight's pre-generated opening message (stored when the scheduler fired).
// Returns { message, firedTonight } — message is null if wind-down hasn't fired yet today.
router.get("/winddown/tonight-message", async (_req: Request, res: Response) => {
  try {
    const message = await getTonightMessage();
    res.json({ message, firedTonight: message !== null });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve tonight's wind-down message" });
  }
});

router.put("/winddown/settings", async (req: Request, res: Response) => {
  try {
    const { enabled, scheduledTime } = req.body as {
      enabled?: boolean;
      scheduledTime?: string;
    };

    if (
      scheduledTime !== undefined &&
      !/^\d{2}:\d{2}$/.test(scheduledTime)
    ) {
      res.status(400).json({ error: "scheduledTime must be HH:MM format" });
      return;
    }

    const settings = await updateSettings({ enabled, scheduledTime });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to update wind-down settings" });
  }
});

export default router;
