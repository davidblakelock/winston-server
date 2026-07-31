import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import {
  getAllCaptures,
  saveLifeCapture,
  getPendingObservation,
  getPendingSuggestion,
} from "../lifeCaptures/lifeCapturesManager.js";
import { getStoicForUser } from "../stoic/stoicManager.js";

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

  const validContexts = ["morning", "evening", "goal", "observation", "manual"] as const;
  const ctx = validContexts.includes(context as typeof validContexts[number])
    ? (context as typeof validContexts[number])
    : "morning";

  try {
    // Same fact-storage-alongside-the-capture pattern chatHandlerCore.ts uses
    // for Evening Wind Down (chatHandlerCore.ts:374-375) — every reflection
    // gets tagged with the phase it was written under, regardless of source.
    const stoicEntry = await getStoicForUser(userName).catch(() => null);
    const capture = await saveLifeCapture(userName, content.trim(), ctx, stoicEntry?.phase ?? null);
    if (!capture) {
      res.status(200).json({ duplicate: true });
      return;
    }
    res.status(201).json(capture);
  } catch (err) {
    req.log.warn({ err }, "[Life] saveLifeCapture failed");
    res.status(500).json({ error: "Failed to save capture" });
  }
});

// PUT /api/life/:id — edit a capture's content
// Body: { content: string }
router.put("/life/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const rawId = req.params["id"];
  const id = parseInt(rawId as string, 10);
  req.log.info({ rawId, parsedId: id }, "[Life] PUT id param");

  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const { content } = req.body as { content?: string };
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  try {
    const { rows } = await query<{ id: number; content: string }>(
      `UPDATE life_captures
       SET content = $1
       WHERE id = $2 AND user_name = $3
       RETURNING id, content`,
      [content.trim(), id, userName]
    );
    if (!rows.length) {
      res.status(404).json({ error: "Capture not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    req.log.warn({ err }, "[Life] PUT failed");
    res.status(500).json({ error: "Failed to update capture" });
  }
});

// DELETE /api/life/:id — delete a capture by id
// Note: if the native app sends DELETE /api/life/undefined, rawId will be the
// string "undefined" — logged here so we can diagnose client-side ID bugs.
router.delete("/life/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const rawId = req.params["id"];
  const id = parseInt(rawId as string, 10);
  req.log.info({ rawId, parsedId: id }, "[Life] DELETE id param");

  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer", received: rawId });
    return;
  }

  try {
    const { rows } = await query<{ id: number }>(
      `DELETE FROM life_captures WHERE id = $1 AND user_name = $2 RETURNING id`,
      [id, userName]
    );
    if (!rows.length) {
      res.status(404).json({ error: "Capture not found" });
      return;
    }
    res.json({ deleted: rows[0]!.id });
  } catch (err) {
    req.log.warn({ err }, "[Life] delete failed");
    res.status(500).json({ error: "Failed to delete capture" });
  }
});

export default router;
