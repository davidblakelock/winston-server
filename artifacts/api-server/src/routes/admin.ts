import { Router, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { lookupRestaurantUrl } from "../lists/autoUrlLookup.js";
import { upsertProfile } from "../onboarding/onboardingManager.js";
import { isApifyApiKeyConfigured } from "../restaurants/apifyBooking.js";
import { getResySession } from "../restaurants/bookingCredentialsManager.js";

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

/**
 * PATCH /api/admin/update-interests
 *
 * Replaces the authenticated user's interests array in raw_data.
 * Also removes any matching profile_items entries for the removed interests.
 * Use this to clean up stale interests (e.g. woodworking) from production.
 *
 * Body: { "interests": ["pickleball", "running", ...] }
 */
router.patch("/admin/update-interests", express.json(), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { interests } = req.body as { interests?: string[] };
  if (!Array.isArray(interests)) {
    res.status(400).json({ error: "interests array required" });
    return;
  }

  try {
    await upsertProfile({ interests }, userName);
    req.log.info({ userName, interests }, "[ADMIN] update-interests — profile rawData.interests updated");
    res.json({ ok: true, interests });
  } catch (err) {
    req.log.error({ err }, "[ADMIN] update-interests error");
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/admin/timezone-check
 *
 * Diagnostic: confirms that reminder times are stored as UTC TIMESTAMPTZ
 * and shows pending to-do reminders in both UTC and America/Chicago time.
 * Use this to verify that computeFireAt() is producing correct local times.
 */
router.get("/admin/timezone-check", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const nowUTC = new Date();
    const nowChicago = nowUTC.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      dateStyle: "short",
      timeStyle: "short",
    });

    const { rows: todoRows } = await query<{
      id: number;
      item_text: string;
      reminder_time: Date;
      user_name: string;
    }>(
      `SELECT id, item_text, reminder_time, user_name
         FROM list_items
        WHERE list_name = 'to do'
          AND reminder_time IS NOT NULL
          AND reminder_fired = FALSE
        ORDER BY reminder_time ASC
        LIMIT 10`
    );

    const { rows: reminderRows } = await query<{
      id: number;
      reminder_text: string;
      fire_at: Date;
      status: string;
    }>(
      `SELECT id, reminder_text, fire_at, status
         FROM reminders
        WHERE user_name = $1
          AND status = 'pending'
        ORDER BY fire_at ASC
        LIMIT 10`,
      [userName]
    );

    const resySession = await getResySession(userName).catch(() => null);
    const bookingStatus = {
      openTableConnected: isApifyApiKeyConfigured(), // guest booking — no login needed
      resyConnected:      !!resySession,
    };

    const todoReminders = todoRows.map((r) => {
      const fireMs = new Date(r.reminder_time).getTime();
      const diffMin = Math.round((fireMs - nowUTC.getTime()) / 60_000);
      return {
        id: r.id,
        text: r.item_text,
        utc: new Date(r.reminder_time).toISOString(),
        chicago: new Date(r.reminder_time).toLocaleString("en-US", {
          timeZone: "America/Chicago",
          dateStyle: "short",
          timeStyle: "short",
        }),
        firesIn: diffMin >= 0 ? `${diffMin} min` : `${Math.abs(diffMin)} min overdue`,
      };
    });

    const scheduledReminders = reminderRows.map((r) => {
      const fireMs = new Date(r.fire_at).getTime();
      const diffMin = Math.round((fireMs - nowUTC.getTime()) / 60_000);
      return {
        id: r.id,
        text: r.reminder_text,
        utc: new Date(r.fire_at).toISOString(),
        chicago: new Date(r.fire_at).toLocaleString("en-US", {
          timeZone: "America/Chicago",
          dateStyle: "short",
          timeStyle: "short",
        }),
        firesIn: diffMin >= 0 ? `${diffMin} min` : `${Math.abs(diffMin)} min overdue`,
      };
    });

    res.json({
      serverNowUTC: nowUTC.toISOString(),
      serverNowChicago: nowChicago,
      timezoneImpl:
        "computeFireAt() uses Intl.DateTimeFormat(America/Chicago) to offset user's local time to UTC. " +
        "reminder_time / fire_at are TIMESTAMPTZ (stored as UTC). " +
        "Scheduler comparison `reminder_time <= NOW()` is UTC vs UTC — correct.",
      apifyStatus: {
        apifyKeyConfigured: isApifyApiKeyConfigured(),
        openTableReady: isApifyApiKeyConfigured() && bookingStatus.openTableConnected,
        resyReady:      isApifyApiKeyConfigured() && bookingStatus.resyConnected,
        openTableConnected: bookingStatus.openTableConnected,
        resyConnected:      bookingStatus.resyConnected,
      },
      pendingTodoReminders: todoReminders,
      pendingScheduledReminders: scheduledReminders,
    });
  } catch (err) {
    req.log.error({ err }, "[ADMIN] timezone-check error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
