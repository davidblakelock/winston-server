import { Router, type IRouter, type Request, type Response } from "express";
import {
  getSettings,
  updateSettings,
  getTonightMessage,
  markFiredToday,
  setWinddownActive,
} from "../winddown/winddownManager.js";

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

// Native app "Evening Check-In" button calls this to activate the check-in on-demand,
// independent of the scheduled 9 PM push notification. Idempotent — safe to call multiple times.
// Returns the pre-generated opening message if the scheduled job already fired tonight,
// or null if the opening message hasn't been generated yet (chat route will handle it).
router.post("/winddown/activate", async (_req: Request, res: Response) => {
  try {
    await markFiredToday();        // Ensures today's row exists (no-op if already present)
    await setWinddownActive(true); // Ensures active = true (re-activates if previously deactivated)
    const message = await getTonightMessage();
    res.json({ activated: true, message });
  } catch (err) {
    res.status(500).json({ error: "Failed to activate evening check-in" });
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
