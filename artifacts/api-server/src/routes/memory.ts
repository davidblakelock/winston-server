import { Router, type IRouter, type Request, type Response } from "express";
import { saveMemory } from "../memory/memoryManager.js";

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
    const saved = await saveMemory(history);
    res.json({ saved });
  } catch (err) {
    req.log.warn({ err }, "Memory save endpoint error");
    res.status(500).json({ error: "Failed to save memory" });
  }
});

export default router;
