import { Router, type IRouter, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { getStoicForUser, ensureStoicDayCurrent } from "../stoic/stoicManager.js";

const router: IRouter = Router();

// GET /api/stoic/today
// Returns the current day's Stoic entry for the authenticated user.
// Auth: x-api-key: winston-native-2026 + x-user-name, or Bearer token.
//
// Response:
//   { dayNumber, quote, author, source, theme, phase, introContext? }
//
// This is one of two real-engagement call sites (the other is the Morning
// Run Down) sharing ensureStoicDayCurrent()'s advance-eligibility gate —
// whichever of the two is opened first each day is the one that advances
// stoic_day for today; the other reads back that same settled value for the
// rest of the day. See stoicManager.ts for the full gating logic.
router.get("/stoic/today", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    await ensureStoicDayCurrent(userName).catch((err) =>
      req.log.warn({ err }, "[Stoic] ensureStoicDayCurrent failed — serving current value as-is")
    );
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
