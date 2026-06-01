import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { getStoicForUser } from "../stoic/stoicManager.js";

const router: IRouter = Router();

// GET /api/stoic/today
// Returns the current day's Stoic entry for the authenticated user.
// Auth: x-api-key: winston-native-2026 + x-user-name, or Bearer token.
//
// Response:
//   { dayNumber, quote, author, source, theme, phase, introContext? }
//
// Note: does NOT increment stoicDay — that only happens when a morning
// briefing is generated. This endpoint is read-only.
router.get("/stoic/today", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const entry = await getStoicForUser(userName);
    if (!entry) {
      res.status(404).json({ error: "No Stoic entry found" });
      return;
    }
    res.json(entry);
  } catch (err) {
    req.log.warn({ err }, "[Stoic] getStoicForUser failed");
    res.status(500).json({ error: "Failed to retrieve Stoic entry" });
  }
});

export default router;
