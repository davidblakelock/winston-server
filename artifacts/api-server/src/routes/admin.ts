import { Router, type Request, type Response } from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { lookupRestaurantUrl } from "../lists/autoUrlLookup.js";

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
       WHERE user_name = $1
       RETURNING user_name`,
      [userName]
    );

    req.log.info({ userName, doWipe }, "[ADMIN] reset-profile — onboarding fields cleared");

    if (doWipe) {
      // Destructive: only runs when caller explicitly passes the confirmation token
      await query("DELETE FROM profile_items WHERE user_name = $1 RETURNING id", [userName]);
      await query("DELETE FROM list_items WHERE user_name = $1 RETURNING id", [userName]);
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

/**
 * POST /api/admin/backfill-restaurant-urls
 *
 * Scans all restaurants in profile_items and populates missing URLs.
 * Also upgrades any plain website URLs to OpenTable/Resy booking links where available.
 * Runs sequentially (not in parallel) to avoid hammering the APIs.
 */
router.post("/admin/backfill-restaurant-urls", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const { rows } = await query<{ id: number; name: string; url: string | null; detail: string | null }>(
      `SELECT id, name, url, detail FROM profile_items
       WHERE user_name = $1 AND category = 'restaurants'
       ORDER BY id`,
      [userName]
    );

    const city = (req.body as { city?: string }).city ?? "Dallas";
    const results: Array<{ id: number; name: string; before: string | null; after: string | null; status: string }> = [];

    for (const row of rows) {
      // Skip rows that already have a booking platform URL
      const alreadyBooked = row.url && /opentable\.com|resy\.com/i.test(row.url);
      if (alreadyBooked) {
        results.push({ id: row.id, name: row.name, before: row.url, after: row.url, status: "skipped_already_booked" });
        continue;
      }

      req.log.info({ id: row.id, name: row.name, city }, "[ADMIN] backfill-restaurant-urls — looking up");
      const url = await lookupRestaurantUrl(row.name, city);

      if (url) {
        await query(
          `UPDATE profile_items SET url = $1 WHERE id = $2`,
          [url, row.id]
        );
        results.push({ id: row.id, name: row.name, before: row.url, after: url, status: "updated" });
      } else {
        results.push({ id: row.id, name: row.name, before: row.url, after: null, status: "not_found" });
      }
    }

    const updated = results.filter((r) => r.status === "updated").length;
    const notFound = results.filter((r) => r.status === "not_found").length;
    const skipped = results.filter((r) => r.status === "skipped_already_booked").length;

    req.log.info({ updated, notFound, skipped }, "[ADMIN] backfill-restaurant-urls — complete");
    res.json({ ok: true, updated, notFound, skipped, results });
  } catch (err) {
    req.log.error({ err }, "[ADMIN] backfill-restaurant-urls — error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
