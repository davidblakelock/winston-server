import { Router, type IRouter, type Request, type Response } from "express";
import { saveMemory } from "../memory/memoryManager.js";
import { tryAuthenticate } from "../auth/middleware.js";
import { getProfile } from "../onboarding/onboardingManager.js";

const router: IRouter = Router();

// POST /api/memory/save — called by the frontend with conversation history
router.post("/memory/save", async (req: Request, res: Response) => {
  const { history } = req.body as {
    history?: Array<{ role: string; content: string }>;
  };

  if (!history || !Array.isArray(history) || history.length < 4) {
    res.json({ saved: false, reason: "too short" });
    return;
  }

  try {
    const userName = await tryAuthenticate(req);
    let companionName: string | null = null;
    let displayName: string | null = null;
    if (userName) {
      const profile = await getProfile(userName).catch(() => null);
      companionName = profile?.companionName ?? null;
      displayName = profile?.name ?? null;
    }

    const saved = await saveMemory(history, companionName, displayName);
    res.json({ saved });
  } catch (err) {
    req.log.warn({ err }, "Memory save endpoint error");
    res.status(500).json({ error: "Failed to save memory" });
  }
});

export default router;
