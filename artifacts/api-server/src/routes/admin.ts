import { Router, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";

const router = Router();

/**
 * POST /api/admin/reset-profile
 *
 * Resets the authenticated user's onboarding data so they can redo the
 * onboarding flow. Clears:
 *   - user_profiles: raw_data, core profile fields, onboarding_completed → false
 *   - profile_items: all rows for user
 *   - list_items: all rows for user
 *
 * Google auth tokens and app sessions are intentionally preserved.
 */
router.post("/admin/reset-profile", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    // 1. Reset user_profiles — clear profile data, keep voice/photo/companion prefs
    await query(
      `UPDATE user_profiles SET
         raw_data            = '{}',
         onboarding_completed = false,
         name                = NULL,
         city                = NULL,
         latitude            = NULL,
         longitude           = NULL,
         timezone            = NULL,
         wake_time           = NULL,
         health_notes        = NULL
       WHERE user_name = $1`,
      [userName]
    );

    // 2. Delete all structured profile items
    await query("DELETE FROM profile_items WHERE user_name = $1", [userName]);

    // 3. Delete all list items
    await query("DELETE FROM list_items WHERE user_name = $1", [userName]);

    req.log.info({ userName }, "[ADMIN] reset-profile — onboarding data cleared");

    res.json({
      ok: true,
      message: `Profile reset for ${userName}. Onboarding data cleared.`,
    });
  } catch (err) {
    req.log.error({ err }, "[ADMIN] reset-profile — error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
