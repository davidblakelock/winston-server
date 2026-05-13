import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { getAllCaptures } from "../lifeCaptures/lifeCapturesManager.js";

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

export default router;
