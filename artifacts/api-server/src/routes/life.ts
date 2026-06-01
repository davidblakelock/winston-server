import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import {
  getAllCaptures,
  saveLifeCapture,
  getPendingObservation,
  getPendingSuggestion,
} from "../lifeCaptures/lifeCapturesManager.js";

const router: IRouter = Router();

// GET /api/life — captures + most recent insight (Socratic Mirror or Dot-Connector)
// Response shape: { captures: LifeCapture[], insight: string | null }
// Native app reads `insight` for the gold card at the top of My Day.
// Priority: pending Socratic Mirror observation > pending Dot-Connector suggestion > null.
router.get("/life", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const [captures, observation, suggestion] = await Promise.all([
      getAllCaptures(userName),
      getPendingObservation(userName).catch(() => null),
      getPendingSuggestion(userName).catch(() => null),
    ]);
    const insight = observation?.observation ?? suggestion?.suggestion ?? null;
    res.json({ captures, insight });
  } catch (err) {
    req.log.warn({ err }, "[Life] getAllCaptures failed");
    res.status(500).json({ error: "Failed to retrieve life captures" });
  }
});

// POST /api/life — manually save a capture
router.post("/life", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { content, context } = req.body as { content?: string; context?: string };
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const validContexts = ["morning", "evening", "goal", "observation"] as const;
  const ctx = validContexts.includes(context as typeof validContexts[number])
    ? (context as typeof validContexts[number])
    : "morning";

  try {
    const capture = await saveLifeCapture(userName, content.trim(), ctx);
    res.status(201).json(capture);
  } catch (err) {
    req.log.warn({ err }, "[Life] saveLifeCapture failed");
    res.status(500).json({ error: "Failed to save capture" });
  }
});

export default router;
