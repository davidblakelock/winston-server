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
import { tryAuthenticate, NATIVE_STORED_NAME } from "../auth/middleware.js";

const router: IRouter = Router();

router.get("/winddown/settings", async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to get wind-down settings" });
  }
});

// Native app calls this after tapping the push notification to retrieve
// tonight's pre-generated opening message (stored when the scheduler fired).
// Returns { message, firedTonight } — message is null if check-in hasn't fired yet today.
router.get("/winddown/tonight-message", async (_req: Request, res: Response) => {
  try {
    const message = await getTonightMessage();
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
  try {
    await markFiredToday();        // Ensures today's row exists (no-op if already present)
    await setWinddownActive(true); // Ensures active = true (re-activates if deactivated)

    // Resolve the authenticated user; fall back to primary user from active users list.
    const sessionUserName = await tryAuthenticate(req) ?? NATIVE_STORED_NAME;

    // Always generate fresh — the opening message includes tonight's story question,
    // calendar events, and all 6 check-in elements. Caching would serve stale content.
    const profile = await getProfile(sessionUserName).catch(() => null);
    const companionName = profile?.companionName ?? "Your Companion";
    const message = await generateOpeningMessage(companionName);
    await saveTonightMessage(message).catch(() => {});

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
    res.status(500).json({ error: "Failed to update check-in settings" });
  }
});

export default router;
