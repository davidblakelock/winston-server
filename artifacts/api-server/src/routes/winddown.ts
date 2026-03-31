import { Router, type IRouter, type Request, type Response } from "express";
import { getSettings, updateSettings } from "../winddown/winddownManager.js";

const router: IRouter = Router();

router.get("/winddown/settings", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to get wind-down settings" });
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
