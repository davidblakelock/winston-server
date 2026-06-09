import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import {
  saveMemoryToArchive,
  getMemoriesGroupedByCategory,
  deleteMemoryEntry,
  recategorizeMemoryEntry,
  VALID_CATEGORIES,
} from "../memory/memoryArchiveManager.js";

const router: IRouter = Router();

// GET /api/memories — all memories grouped by category
router.get("/memories", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    req.log?.info({ userName }, "[Memories] GET resolved user");
    const grouped = await getMemoriesGroupedByCategory(userName);
    res.json({ memories: grouped, categories: VALID_CATEGORIES });
  } catch (err) {
    req.log?.warn({ err }, "Memories GET error");
    res.status(500).json({ error: "Failed to fetch memories" });
  }
});

// POST /api/memories — create entry (auto-categorize if category omitted)
router.post("/memories", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    req.log?.info({ userName }, "[Memories] POST resolved user");
    const { text, category } = req.body as { text?: string; category?: string };

    if (!text?.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const entry = await saveMemoryToArchive(text, userName, category);
    res.status(201).json({ memory: entry });
  } catch (err) {
    req.log?.warn({ err }, "Memories POST error");
    res.status(500).json({ error: "Failed to save memory" });
  }
});

// DELETE /api/memories/:id
router.delete("/memories/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const id = parseInt(String(req.params.id), 10);
    const deleted = await deleteMemoryEntry(id, userName);
    if (!deleted) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log?.warn({ err }, "Memories DELETE error");
    res.status(500).json({ error: "Failed to delete memory" });
  }
});

// PATCH /api/memories/:id/category — re-categorize
router.patch("/memories/:id/category", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const id = parseInt(String(req.params.id), 10);
    const { category } = req.body as { category?: string };

    if (!category) {
      res.status(400).json({ error: "category is required" });
      return;
    }

    const updated = await recategorizeMemoryEntry(id, userName, category);
    if (!updated) {
      res.status(404).json({ error: "Memory not found or invalid category" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    req.log?.warn({ err }, "Memories PATCH error");
    res.status(500).json({ error: "Failed to re-categorize memory" });
  }
});

export default router;
