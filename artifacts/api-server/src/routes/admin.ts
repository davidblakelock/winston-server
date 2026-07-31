import { Router, type Request, type Response } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import { query } from "../db.js";
import { lookupOfficialWebsite } from "../lists/autoUrlLookup.js";
import { upsertProfile } from "../onboarding/onboardingManager.js";
import { isApifyApiKeyConfigured } from "../restaurants/apifyBooking.js";
import { getResySession } from "../restaurants/bookingCredentialsManager.js";
import { estimateDriveTime } from "../departure/departureManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";

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
 * Scans all restaurants in profile_items and populates missing official-site URLs.
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

    const body = req.body as { city?: string; force?: boolean };
    // If caller doesn't supply a city, look it up from the user's profile so
    // the booking URL search is always location-aware (never hardcoded).
    let city = body.city ?? "";
    if (!city) {
      const profileRow = await query<{ city: string | null }>(
        `SELECT city FROM user_profiles WHERE user_name = $1`,
        [userName]
      ).catch(() => ({ rows: [] as Array<{ city: string | null }> }));
      city = profileRow.rows[0]?.city ?? "";
    }
    // force=true → re-run lookup for ALL restaurants, even those that already have a URL.
    // Default (force=false) → skip any restaurant that already has one.
    const force = body.force === true;
    const results: Array<{ id: number; name: string; before: string | null; after: string | null; status: string }> = [];

    for (const row of rows) {
      if (!force && row.url) {
        results.push({ id: row.id, name: row.name, before: row.url, after: row.url, status: "skipped_already_has_url" });
        continue;
      }

      req.log.info({ id: row.id, name: row.name, city, force }, "[ADMIN] backfill-restaurant-urls — looking up");
      const url = await lookupOfficialWebsite(row.name, city);

      await query(
        `UPDATE profile_items SET url = $1, booking_platform = NULL WHERE id = $2`,
        [url, row.id]
      );
      results.push({ id: row.id, name: row.name, before: row.url, after: url, status: url ? "updated" : "not_found" });

      // Small delay between lookups to stay gentle on the Places/Anthropic APIs
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
    }

    const updated = results.filter((r) => r.status === "updated").length;
    const notFound = results.filter((r) => r.status === "not_found").length;
    const skipped = results.filter((r) => r.status === "skipped_already_has_url").length;

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
 * and shows pending to-do reminders in both UTC and user local time.
 * Use this to verify that computeFireAt() is producing correct local times.
 */
router.get("/admin/timezone-check", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const nowUTC = new Date();
    const nowChicago = nowUTC.toLocaleString("en-US", {
      timeZone: "UTC",// admin debug — use UTC for consistency,
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
          timeZone: "UTC", // admin debug — use UTC for consistency,
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
          timeZone: "UTC", // admin debug — use UTC for consistency,
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
        "computeFireAt() uses Intl.DateTimeFormat(user timezone) to offset user's local time to UTC. " +
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

/**
 * GET /api/admin/test-maps?destination=...&origin=...
 *
 * Manually triggers a Google Maps Directions + Geocoding call and returns the
 * raw result. Check server logs for full request/response details including
 * status codes and response body snippets.
 */
router.get("/admin/test-maps", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const destination = String(req.query["destination"] ?? "Prestonwood Country Club, Dallas, TX");
  const origin      = String(req.query["origin"]      ?? "");

  req.log.info({ destination, origin }, "[AdminTestMaps] Starting test");

  try {
    // Pull home address from profile if no origin provided
    let homeAddress = origin;
    let homeLat = 32.9; // fallback approx
    let homeLon = -96.8;

    if (!homeAddress) {
      const { rows } = await query<{ home_address?: string; home_lat?: number; home_lon?: number }>(
        `SELECT raw_data->>'home_address' AS home_address,
                (raw_data->>'home_lat')::float AS home_lat,
                (raw_data->>'home_lon')::float AS home_lon
           FROM user_profiles WHERE user_name = $1 LIMIT 1`,
        [userName]
      );
      homeAddress = rows[0]?.home_address ?? "6230 Orchid Ln, Dallas TX 75230";
      homeLat     = rows[0]?.home_lat ?? 32.9;
      homeLon     = rows[0]?.home_lon ?? -96.8;
    }

    req.log.info({ homeAddress, homeLat, homeLon, destination }, "[AdminTestMaps] Calling estimateDriveTime");

    const result = await estimateDriveTime(destination, homeAddress, homeLat, homeLon);

    req.log.info({ result }, "[AdminTestMaps] estimateDriveTime complete");

    res.json({
      destination,
      homeAddress,
      homeLat,
      homeLon,
      result,
      note: "Check server logs for full [GoogleMaps] request/response details including status codes and response bodies.",
    });
  } catch (err) {
    req.log.error({ err }, "[AdminTestMaps] Error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /admin/search-text?q=<term>
 * Temporary debug endpoint — searches key tables for a text term.
 */
router.get("/admin/search-text", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const term = String(req.query["q"] ?? "").trim();
  if (!term) { res.status(400).json({ error: "q param required" }); return; }

  const results: Record<string, unknown[]> = {};

  const searches: Array<{ label: string; sql: string; params: unknown[] }> = [
    {
      label: "conversation_memories",
      sql: `SELECT id, conversation_date::text, summary FROM conversation_memories WHERE summary ILIKE $1 ORDER BY conversation_date DESC LIMIT 5`,
      params: [`%${term}%`],
    },
    {
      label: "user_profiles_raw_data",
      sql: `SELECT user_name, raw_data::text AS raw FROM user_profiles WHERE raw_data::text ILIKE $1 LIMIT 3`,
      params: [`%${term}%`],
    },
    {
      label: "profile_items",
      sql: `SELECT id, category, name, detail FROM profile_items WHERE (name ILIKE $1 OR detail ILIKE $1) LIMIT 10`,
      params: [`%${term}%`],
    },
    {
      label: "chat_messages_recent",
      sql: `SELECT id, role, LEFT(content, 300) AS content, created_at FROM chat_messages WHERE content ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
      params: [`%${term}%`],
    },
    {
      label: "digest_log",
      sql: `SELECT id, LEFT(digest_text, 500) AS digest_text, sent_at FROM digest_log WHERE digest_text ILIKE $1 ORDER BY sent_at DESC LIMIT 3`,
      params: [`%${term}%`],
    },
    {
      label: "calendar_sync_state",
      sql: `SELECT user_name, event_id, event_summary, event_start_iso FROM calendar_sync_state WHERE event_summary ILIKE $1 OR event_location ILIKE $1 LIMIT 5`,
      params: [`%${term}%`],
    },
    {
      label: "key_people",
      sql: `SELECT id, user_name, name, relationship, notes FROM key_people WHERE (name ILIKE $1 OR notes ILIKE $1) LIMIT 10`,
      params: [`%${term}%`],
    },
  ];

  for (const s of searches) {
    try {
      const { rows } = await query(s.sql, s.params);
      if (rows.length > 0) results[s.label] = rows;
    } catch (e) {
      results[s.label] = [{ error: String(e) }];
    }
  }

  res.json({ term, results });
});

/**
 * DELETE /admin/delete-memory/:id
 * Temporary debug endpoint — deletes a single conversation_memory row by id.
 */
router.delete("/admin/delete-memory/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  try {
    const { rowCount } = await query(`DELETE FROM conversation_memories WHERE id = $1`, [id]);
    res.json({ deleted: rowCount ?? 0, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * DELETE /admin/delete-profile-item/:id
 * Temporary debug endpoint — deletes a single profile_items row by id.
 */
router.delete("/admin/delete-profile-item/:id", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  try {
    const { rowCount } = await query(`DELETE FROM profile_items WHERE id = $1`, [id]);
    res.json({ deleted: rowCount ?? 0, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/admin/test-push
 * Sends a test push notification to the authenticated user.
 * Body: { type: "medication" | "bill-reminder" }
 * For bill-reminder, also accepts: { billId?, billName?, amount?, dueDateISO? }
 */
router.post("/admin/test-push", express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { type, billId, billName, amount, dueDateISO } = req.body as {
    type?: string;
    billId?: number;
    billName?: string;
    amount?: string;
    dueDateISO?: string;
  };

  if (type === "medication") {
    const result = await sendFcmNotification({
      userName,
      notificationType: "medication",
      title: "Medication Reminder",
      body: "Time to take your medications.",
    });
    req.log.info({ userName, sent: result.sent }, "[AdminTestPush] Medication test push sent");
    res.json({ ok: true, type: "medication", sent: result.sent });
    return;
  }

  if (type === "bill-reminder") {
    const name = billName ?? "Test Bill";
    const amt = amount ?? "$99.00";
    const due = dueDateISO ?? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = await sendFcmNotification({
      userName,
      notificationType: "bill",
      title: "Bill Reminder",
      body: `${name} (${amt}) is due soon.`,
      data: {
        billId: String(billId ?? 0),
        billName: name,
        amount: amt,
        dueDateISO: due,
      },
    });
    req.log.info({ userName, sent: result.sent }, "[AdminTestPush] Bill test push sent");
    res.json({ ok: true, type: "bill-reminder", sent: result.sent });
    return;
  }

  res.status(400).json({ error: "type must be 'medication' or 'bill-reminder'" });
});

/**
 * POST /api/admin/test-daily-brief
 *
 * Diagnostic tool for manually testing long-running background generation
 * (generateDailyBriefDeepResearch) without being constrained by chat request
 * timeouts — deep research needs several minutes, but both the client and
 * server infrastructure abort HTTP requests around 38-60 seconds. This route
 * fires the job and returns immediately; the result is logged separately
 * once it completes (search server logs for [DailyBriefDeepResearch]).
 */
router.post("/admin/test-daily-brief", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  // Fire and forget — do not await. Respond immediately so the HTTP
  // connection isn't held open for the several minutes deep research needs.
  res.json({ ok: true, message: "Deep research briefing started — check server logs for progress and the final result (search for [DailyBriefDeepResearch])." });

  import("../morning/briefingPregenerate.js").then(({ generateDailyBriefDeepResearch }) => {
    generateDailyBriefDeepResearch(userName)
      .then((result) => {
        if (result) {
          req.log.info(
            { userName, resultLength: result.length, resultPreview: result.slice(0, 200) },
            "[DailyBriefDeepResearch] TEST ROUTE — completed successfully, full result below"
          );
          req.log.info(
            { userName, fullResult: result },
            "[DailyBriefDeepResearch] TEST ROUTE — full text"
          );
        } else {
          req.log.warn({ userName }, "[DailyBriefDeepResearch] TEST ROUTE — returned null");
        }
      })
      .catch((err) => {
        req.log.warn({ err, userName }, "[DailyBriefDeepResearch] TEST ROUTE — threw an error");
      });
  });
});

/**
 * POST /api/admin/test-daily-brief-searchapi
 *
 * Diagnostic tool for manually testing generateDailyBriefSearchApi
 * (gpt-5-search-api via Chat Completions) without touching the chat trigger.
 * Same fire-and-forget pattern as /admin/test-daily-brief — fires the job and
 * returns immediately; the result is logged separately once it completes
 * (search server logs for [DailyBriefSearchApi]).
 */
router.post("/admin/test-daily-brief-searchapi", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  // Fire and forget — do not await. Respond immediately.
  res.json({ ok: true, message: "gpt-5-search-api briefing started — check server logs for the result (search for [DailyBriefSearchApi])." });

  import("../morning/briefingPregenerate.js").then(({ generateDailyBriefSearchApi }) => {
    generateDailyBriefSearchApi(userName)
      .then((result) => {
        if (result) {
          req.log.info(
            { userName, resultLength: result.length, resultPreview: result.slice(0, 200) },
            "[DailyBriefSearchApi] TEST ROUTE — completed successfully, full result below"
          );
          req.log.info(
            { userName, fullResult: result },
            "[DailyBriefSearchApi] TEST ROUTE — full text"
          );
        } else {
          req.log.warn({ userName }, "[DailyBriefSearchApi] TEST ROUTE — returned null");
        }
      })
      .catch((err) => {
        req.log.warn({ err, userName }, "[DailyBriefSearchApi] TEST ROUTE — threw an error");
      });
  });
});

/**
 * POST /api/admin/test-daily-brief-live
 *
 * Diagnostic tool for manually testing generateDailyBrief — the actual live
 * morning-briefing path (gpt-4o + web_search_preview, verified weather
 * injected directly, search-count-gated retry) — without going through chat.
 * Same fire-and-forget pattern as the other test-daily-brief routes.
 */
router.post("/admin/test-daily-brief-live", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  res.json({ ok: true, message: "generateDailyBrief started — check server logs for the result (search for [DailyBrief])." });

  import("../morning/briefingPregenerate.js").then(({ generateDailyBrief }) => {
    generateDailyBrief(userName)
      .then((result) => {
        if (result) {
          req.log.info(
            { userName, resultLength: result.length, fullResult: result },
            "[DailyBrief] TEST ROUTE — completed successfully, full result below"
          );
        } else {
          req.log.warn({ userName }, "[DailyBrief] TEST ROUTE — returned null");
        }
      })
      .catch((err) => {
        req.log.warn({ err, userName }, "[DailyBrief] TEST ROUTE — threw an error");
      });
  });
});

/**
 * POST /api/admin/test-stoic-rewind
 *
 * Diagnostic tool for testing ensureStoicDayCurrent()'s shared advance gate
 * without waiting for a real calendar-day rollover. Sets stoic_day_advanced_
 * date back by one day for the authenticated user, simulating "not yet
 * engaged today" — the next call to either GET /api/stoic/today or a real
 * Morning Run Down should then advance stoic_day by exactly one and report
 * the new day number. Read-only diagnostics elsewhere (test-daily-brief-live
 * etc.) deliberately never touch this gate; this route exists solely to make
 * the gate testable on demand instead of waiting a day.
 */
router.post("/admin/test-stoic-rewind", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const before = await query<{ stoic_day: number; stoic_day_advanced_date: string | null }>(
    `SELECT stoic_day, stoic_day_advanced_date FROM user_settings WHERE user_name = $1`,
    [userName]
  );

  await query(
    `UPDATE user_settings SET stoic_day_advanced_date = stoic_day_advanced_date - INTERVAL '1 day' WHERE user_name = $1`,
    [userName]
  );

  const after = await query<{ stoic_day: number; stoic_day_advanced_date: string | null }>(
    `SELECT stoic_day, stoic_day_advanced_date FROM user_settings WHERE user_name = $1`,
    [userName]
  );

  res.json({ ok: true, before: before.rows[0] ?? null, after: after.rows[0] ?? null });
});

/**
 * POST /api/admin/migrate-restaurants-to-table
 *
 * One-time migration: moves davidblakelock's existing restaurant rows out of
 * profile_items (category = 'restaurants') into the new dedicated
 * restaurants table, preserving name/detail/url/booking_platform/notes/
 * created_at exactly. Only deletes the source profile_items rows that were
 * actually migrated (dedup-safe — skips anything that already exists by
 * name in restaurants, and leaves the source row in place if it does, so
 * nothing is silently lost). Hardcoded to davidblakelock's account since
 * this is a one-off repair, not a general-purpose tool.
 */
router.post("/admin/migrate-restaurants-to-table", async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const { rows: source } = await query<{
      id: number;
      name: string;
      detail: string | null;
      url: string | null;
      booking_platform: string | null;
      notes: string | null;
      created_at: string;
    }>(
      `SELECT id, name, detail, url, booking_platform, notes, created_at
       FROM profile_items
       WHERE user_name = $1 AND category = 'restaurants'`,
      ["davidblakelock"]
    );

    const migrated: { sourceId: number; name: string }[] = [];
    for (const r of source) {
      const { rows: insertedRows } = await query<{ id: number; name: string }>(
        `INSERT INTO restaurants (user_name, name, detail, notes, url, booking_platform, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7
         WHERE NOT EXISTS (
           SELECT 1 FROM restaurants
           WHERE user_name = $1 AND lower(name) = lower($2)
         )
         RETURNING id, name`,
        ["davidblakelock", r.name, r.detail, r.notes, r.url, r.booking_platform, r.created_at]
      );
      if (insertedRows.length > 0) migrated.push({ sourceId: r.id, name: insertedRows[0].name });
    }

    let deletedFromProfileItems = 0;
    if (migrated.length > 0) {
      const { rowCount } = await query(
        `DELETE FROM profile_items WHERE id = ANY($1) AND user_name = $2 AND category = 'restaurants'`,
        [migrated.map((m) => m.sourceId), "davidblakelock"]
      );
      deletedFromProfileItems = rowCount ?? 0;
    }

    res.json({
      found: source.length,
      migrated: migrated.length,
      deletedFromProfileItems,
      names: migrated.map((m) => m.name),
    });
  } catch (err) {
    req.log.warn({ err }, "restaurants → restaurants-table migration error");
    res.status(500).json({ error: "Migration failed" });
  }
});

/**
 * POST /api/admin/test-proactive-check
 *
 * Manually triggers proactiveEventScheduler.ts's checkUserForEvent() for the
 * authenticated user, bypassing the normal Monday/Thursday + local-9am gate
 * — for testing the twice-weekly redesign without waiting for a real
 * scheduled window. Body: { runContext?: "week" | "weekend" }, defaults to
 * "week". Runs in the background (real Claude/web-search/API calls, a real
 * push notification, and real proactive_message_log writes) — check server
 * logs (search [Proactive Discovery]) for the result.
 */
router.post("/admin/test-proactive-check", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const runContext = req.body?.runContext === "weekend" ? "weekend" : "week";
  res.json({ ok: true, runContext, message: "checkUserForEvent started — check server logs for [Proactive Discovery]." });

  import("../onboarding/onboardingManager.js").then(async ({ getActiveUsers }) => {
    const users = await getActiveUsers().catch(() => []);
    const user = users.find((u) => u.userName === userName);
    if (!user) {
      req.log.warn({ userName }, "[Proactive Discovery] TEST ROUTE — user not found in getActiveUsers()");
      return;
    }
    const { checkUserForEvent } = await import("../morning/proactiveEventScheduler.js");
    checkUserForEvent(user, runContext)
      .then(() => req.log.info({ userName, runContext }, "[Proactive Discovery] TEST ROUTE — checkUserForEvent completed"))
      .catch((err) => req.log.warn({ err, userName }, "[Proactive Discovery] TEST ROUTE — threw an error"));
  });
});

export default router;

