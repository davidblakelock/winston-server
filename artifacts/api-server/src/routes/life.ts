import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { getAllCaptures, saveLifeCapture } from "../lifeCaptures/lifeCapturesManager.js";

const router: IRouter = Router();

// GET /api/life — all captures for the authenticated user, newest first
router.get("/life", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const captures = await getAllCaptures(userName);
    res.json(captures);
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
