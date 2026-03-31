import { Router } from "express";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const router = Router();

interface StoryRow {
  id: number;
  prompt_question: string;
  response: string;
  captured_at: string;
}

// GET /api/stories/archive?password=xxx — returns all stories if password matches
router.get("/stories/archive", async (req, res) => {
  try {
    const { password } = req.query;
    const expected = process.env.OLIVIA_PASSWORD;

    if (!expected) {
      logger.warn("OLIVIA_PASSWORD not configured");
      res.status(503).json({ error: "not_configured" });
      return;
    }

    if (!password || password !== expected) {
      res.status(401).json({ error: "incorrect_password" });
      return;
    }

    const { rows } = await query<StoryRow>(
      `SELECT id, prompt_question, response, captured_at
       FROM stories
       ORDER BY captured_at ASC`
    );

    logger.info({ count: rows.length }, "Olivia archive accessed");

    res.json({
      stories: rows.map((r) => ({
        id: r.id,
        promptQuestion: r.prompt_question,
        response: r.response,
        capturedAt: r.captured_at,
      })),
      count: rows.length,
    });
  } catch (err) {
    logger.error({ err }, "Stories archive error");
    res.status(500).json({ error: "server_error" });
  }
});

export default router;
