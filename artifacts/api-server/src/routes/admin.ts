import { Router, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";

const router = Router();

/**
 * POST /api/admin/reset-profile
 *
 * Resets the authenticated user's onboarding so they can redo the flow.
 *
 * DEFAULT behaviour (safe): clears onboarding fields only — name, city,
 * raw_data, onboarding_completed — so the user re-enters the onboarding
 * flow without losing any saved profile items, lists, or history.
 *
 * DESTRUCTIVE behaviour (requires explicit opt-in): also deletes
 * profile_items and list_items.  Caller must pass
 *   { "wipeUserData": "DELETE_ALL_PROFILE_DATA" }
 * in the request body or the hard-delete is skipped and a warning is
 * returned instead.  This exists purely as a last-resort recovery tool
 * and should NEVER be called during normal debugging.
 */
router.post("/admin/reset-profile", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { wipeUserData } = req.body as { wipeUserData?: string };
  const doWipe = wipeUserData === "DELETE_ALL_PROFILE_DATA";

  try {
    // Always: reset onboarding fields only
    await query(
      `UPDATE user_profiles SET
         raw_data             = '{}',
         onboarding_completed = false,
         name                 = NULL,
         city                 = NULL,
         latitude             = NULL,
         longitude            = NULL,
         timezone             = NULL,
         wake_time            = NULL,
         health_notes         = NULL
       WHERE user_name = $1`,
      [userName]
    );

    req.log.info({ userName, doWipe }, "[ADMIN] reset-profile — onboarding fields cleared");

    if (doWipe) {
      // Destructive: only runs when caller explicitly passes the confirmation token
      await query("DELETE FROM profile_items WHERE user_name = $1", [userName]);
      await query("DELETE FROM list_items WHERE user_name = $1", [userName]);
      req.log.warn({ userName }, "[ADMIN] reset-profile — profile_items and list_items DELETED (explicit wipe requested)");

      res.json({
        ok: true,
        wiped: true,
        message: `Full profile reset for ${userName}. Onboarding data, profile items, and lists cleared.`,
      });
    } else {
      res.json({
        ok: true,
        wiped: false,
        message: `Onboarding reset for ${userName}. Profile items and lists were preserved. Pass { wipeUserData: "DELETE_ALL_PROFILE_DATA" } to also delete those.`,
      });
    }
  } catch (err) {
    req.log.error({ err }, "[ADMIN] reset-profile — error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
