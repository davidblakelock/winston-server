import { Router, type IRouter, type Request, type Response } from "express";
import {
  getSettings,
  updateSettings,
  getTonightMessage,
  saveTonightMessage,
  markFiredToday,
  setWinddownActive,
} from "../winddown/winddownManager.js";
import { generateOpeningMessage } from "../winddown/winddownScheduler.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { authenticate } from "../auth/middleware.js";

const router: IRouter = Router();

router.get("/winddown/settings", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const settings = await getSettings(userName);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to get evening check-in settings" });
  }
});

// Native app calls this after tapping the push notification to retrieve
// tonight's pre-generated opening message (stored when the scheduler fired).
// Returns { message, firedTonight } — message is null if check-in hasn't fired yet today.
router.get("/winddown/tonight-message", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const message = await getTonightMessage(userName);
    res.json({ message, firedTonight: message !== null });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve tonight's check-in message" });
  }
});

// Native app "Evening Check-In" button calls this to activate on-demand,
// independent of the scheduled 9 PM push notification. Idempotent — safe to call multiple times.
// Generates and returns an opening message immediately if the scheduler hasn't fired yet,
// so the native app always gets a real AI-generated opening, not a null/fallback.
router.post("/winddown/activate", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    await markFiredToday(userName);        // Ensures today's row exists (no-op if already present)
    await setWinddownActive(userName, true); // Ensures active = true (re-activates if deactivated)

    const profile = await getProfile(userName).catch(() => null);
    const companionName = profile?.companionName ?? "your companion";
    const message = await generateOpeningMessage(companionName, userName);
    await saveTonightMessage(userName, message).catch(() => {});

    res.json({ activated: true, message });
  } catch (err) {
    res.status(500).json({ error: "Failed to activate evening check-in" });
  }
});

router.put("/winddown/settings", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
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

    const settings = await updateSettings(userName, { enabled, scheduledTime });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to update evening check-in settings" });
  }
});

export default router;
