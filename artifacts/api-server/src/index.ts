import app from "./app";
import { logger } from "./lib/logger";
import { query } from "./db";
import { startScheduler } from "./reminders/scheduler";
import { startWinddownScheduler } from "./winddown/winddownScheduler";
import { ensureWinddownTables } from "./winddown/winddownManager";
import { ensureBriefingPreferencesTable } from "./briefingPreferences/briefingPreferencesManager";
import { ensureUsersTable } from "./auth/passwordAuth";
import { ensureMemoryTable } from "./memory/memoryManager";
import { ensureProfileTable } from "./profile/profileManager";
import { NATIVE_STORED_NAME } from "./auth/middleware";
import { ensureOnboardingTable } from "./onboarding/onboardingManager";
import { startMedicationScheduler } from "./medications/medicationScheduler";
import { initMedicationReminderLogTable } from "./medications/medicationManager";
import { startMorningPushScheduler } from "./push/morningPushScheduler";
import { startWeatherAlertScheduler } from "./push/weatherAlertScheduler";
import { startBillScheduler } from "./bills/billScheduler";
import { startDatesScheduler } from "./dates/datesScheduler";
import { startDepartureScheduler } from "./departure/departureScheduler";
import { startCalendarSyncScheduler, ensureCalendarSyncTable } from "./departure/calendarSyncScheduler";
import { startPickleballScheduler, ensureProactiveMessageLogTable } from "./pickleball/pickleballScheduler";
import { ensureRelationshipTable } from "./relationships/relationshipManager";
import { ensureContactMentionsTable } from "./olivia/oliviaTracker";
import { initDallasContentTable } from "./morning/dallasContent";
import { startDallasProactiveScheduler } from "./morning/dallasProactiveScheduler";
import { initConcertsTable, startVenueMonitorScheduler } from "./morning/venueMonitor";
import { initBriefingStoriesTable } from "./morning/storyDedup";
import { runBriefingCacheMigrations } from "./morning/briefingCache";
import { addProfileItem } from "./profile/profileManager";
import { ensureContactsTable } from "./google/contacts";
import { startGarminScheduler } from "./garmin/garminScheduler";
import { ensureJournalInsightsTable, startJournalPatternScheduler } from "./journal/journalPatternAnalyzer";
import { ensurePressureTable, startPressureScheduler } from "./weather/pressureScheduler";
import { ensureFitTable } from "./google/fit";
import { ensureMoodTable } from "./mood/moodManager";
import { ensureFollowupsTable } from "./followups/followupManager";
import { ensureMemoryArchiveTable } from "./memory/memoryArchiveManager";
import { ensureJournalSourceColumn } from "./routes/journal";
import { ensureConnectTables } from "./connect/connectManager";
import { ensureGroupTables } from "./connect/groupManager";
import { ensureCalendarSmartTables } from "./routes/calendarSmart";
import { ensureRestaurantCacheTable } from "./restaurants/restaurantIntelligence";
import { ensureOrdersTable } from "./orders/ordersManager";
import { startOrderTrackingScheduler } from "./orders/orderTrackingScheduler";
import { startTodoReminderScheduler } from "./lists/todoReminderScheduler";
import { ensureTripPlansTable } from "./travel/tripPlanningManager";
import { ensureContextReminderColumns } from "./reminders/contextReminderManager";
import { ensureProactiveModeTable, ensureTrustedSendersTable } from "./proactiveMode/proactiveModeManager";
import { ensureContactCommunicationLogTable } from "./intelligence/crossDomainEngine";
import { ensureNotificationVipsTable } from "./push/notificationVips";
import { startBackgroundEmailScanner } from "./email/backgroundEmailScanner";
import { ensureSavedPlacesTable } from "./location/geofenceManager";
import { ensureListItemColumns } from "./lists/listManager";
import { ensureListShareTable } from "./lists/listShareManager";
import { ensureBookingColumns } from "./restaurants/bookingCredentialsManager";
import { ensureServiceProvidersTable, ensureProviderCategoriesTable } from "./providers/providerManager";
import { startProviderScheduler } from "./providers/providerScheduler";
import { startConnectBirthdayScheduler } from "./connect/connectBirthdayScheduler";
import { startContactBirthdayScheduler } from "./google/contactBirthdayScheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // ── One-time: migrate any rows still stored under legacy user_name 'David' ──
  // The session may have been created before the canonical name was set to
  // 'davidblakelock'. We sweep every user-data table on startup so stale rows
  // are found and renamed regardless of which feature saved them.
  try {
    const userDataTables = [
      // Auth / session tables — most important: clean up the session store itself
      "app_sessions",
      "google_users",
      "microsoft_users",
      "apple_users",
      "user_profiles",
      // Feature data tables
      "financial_obligations",
      "reminders",
      "messages",
      "memory_items",
      "profile_items",
      "medications",
      "medication_schedules",
      "medication_reminder_log",
      "mood_checkins",
      "conversation_followups",
      "journal_entries",
      "dates_tracker",
      "push_tokens",
      "push_subscriptions",
      "briefing_preferences",
      "tv_shows",
      "watched_shows",
      "lists",
      "list_items",
      "relationships",
      "contact_mentions",
      "recommendations",
      "sunday_summaries",
      "winddown_schedules",
      "onboarding_state",
      "bill_payment_log",
    ];
    let totalMigrated = 0;
    for (const table of userDataTables) {
      try {
        const result = await query(
          `UPDATE ${table} SET user_name = 'davidblakelock'
            WHERE user_name IN ('David', 'david')
            RETURNING id`,
          []
        );
        if (result.rows.length > 0) {
          logger.info(`[USER-MIGRATE] ${table}: renamed ${result.rows.length} row(s) from 'David' → 'davidblakelock'`);
          totalMigrated += result.rows.length;
        }
      } catch {
        // Table may not exist yet — non-fatal
      }
    }
    if (totalMigrated > 0) {
      logger.info(`[USER-MIGRATE] Total rows renamed: ${totalMigrated}`);
    } else {
      logger.info("[USER-MIGRATE] No legacy 'David' rows found — nothing to migrate");
    }
  } catch (err) {
    logger.warn({ err }, "[USER-MIGRATE] Migration sweep failed (non-fatal)");
  }

  try {
    await ensureWinddownTables();
    await ensureBriefingPreferencesTable();
    await ensureMemoryTable();
    await ensureProfileTable();
    await ensureOnboardingTable();
    await ensureRelationshipTable();
    await ensureContactMentionsTable();
  } catch (e) {
    logger.warn({ e }, "Table initialization warning");
  }

  // Isolated so a failure in the block above never skips the calendar migration
  try {
    await ensureCalendarSyncTable();
  } catch (e) {
    logger.warn({ e }, "calendar_sync_state table initialization warning");
  }

  try {
    await ensureFitTable();
    logger.info("[startup] google_fit_data table ready");
  } catch (e) {
    logger.warn({ e }, "Google Fit table initialization warning");
  }

  try {
    await ensureMoodTable();
    await ensureFollowupsTable();
    await ensureMemoryArchiveTable();
    await ensureJournalSourceColumn();
    logger.info("[startup] mood_checkins, conversation_followups, memory_archive, journal source column ready");
  } catch (e) {
    logger.warn({ e }, "New feature table initialization warning");
  }

  // Isolated block so a failure above never skips this critical table
  try {
    await ensureProactiveMessageLogTable();
    logger.info("[startup] proactive_message_log table ready");
  } catch (e) {
    logger.warn({ e }, "proactive_message_log table initialization warning");
  }

  try {
    await ensureUsersTable();
    logger.info("[startup] users table ready");
  } catch (e) {
    logger.warn({ e }, "users table initialization warning");
  }

  try {
    await initDallasContentTable();
  } catch (e) {
    logger.warn({ e }, "Dallas content table initialization warning");
  }

  try {
    await initConcertsTable();
  } catch (e) {
    logger.warn({ e }, "Concerts table initialization warning");
  }

  try {
    await initBriefingStoriesTable();
    logger.info("[startup] daily_briefing_stories table ready");
  } catch (e) {
    logger.warn({ e }, "Briefing stories table initialization warning");
  }

  try {
    await runBriefingCacheMigrations();
  } catch (e) {
    logger.warn({ e }, "Briefing cache migration warning");
  }

  try {
    const { ensureApifyCacheTable } = await import("./lib/apifyCache.js");
    await ensureApifyCacheTable();
  } catch (e) {
    logger.warn({ e }, "apify_cache table initialization warning");
  }

  try {
    await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_id TEXT`);
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_message_id_idx
       ON chat_messages (message_id)
       WHERE message_id IS NOT NULL`
    );
    logger.info("[startup] chat_messages.message_id dedup column ready");
  } catch (e) {
    logger.warn({ e }, "chat_messages message_id migration warning");
  }

  try {
    await ensureContactsTable();
  } catch (e) {
    logger.warn({ e }, "Contacts table initialization warning");
  }

  try {
    await ensureJournalInsightsTable();
    logger.info("[startup] journal_insights table ready");
  } catch (e) {
    logger.warn({ e }, "Journal insights table initialization warning");
  }

  try {
    await ensurePressureTable();
    logger.info("[startup] pressure_readings table ready");
  } catch (e) {
    logger.warn({ e }, "Pressure readings table initialization warning");
  }

  try {
    await ensureConnectTables();
  } catch (e) {
    logger.warn({ e }, "Winston Connect table initialization warning");
  }

  try {
    await ensureGroupTables();
    logger.info("[startup] Connect group tables ready");
  } catch (e) {
    logger.warn({ e }, "Connect group table initialization warning");
  }

  try {
    await ensureCalendarSmartTables();
  } catch (e) {
    logger.warn({ e }, "Calendar smart settings table initialization warning");
  }

  try {
    await ensureRestaurantCacheTable();
    logger.info("[startup] restaurant_places_cache table ready");
  } catch (e) {
    logger.warn({ e }, "Restaurant places cache table initialization warning");
  }

  try {
    await ensureOrdersTable();
  } catch (e) {
    logger.warn({ e }, "Orders table initialization warning");
  }

  try {
    await ensureTripPlansTable();
  } catch (e) {
    logger.warn({ e }, "Trip plans table initialization warning");
  }

  try {
    await ensureContextReminderColumns();
    logger.info("[startup] context reminder columns ready");
  } catch (e) {
    logger.warn({ e }, "Context reminder columns initialization warning");
  }

  try {
    await ensureProactiveModeTable();
    logger.info("[startup] user_proactive_settings table ready");
  } catch (e) {
    logger.warn({ e }, "Proactive mode table initialization warning");
  }

  try {
    await ensureContactCommunicationLogTable();
    logger.info("[startup] contact_communication_log table ready");
  } catch (e) {
    logger.warn({ e }, "Contact communication log table initialization warning");
  }

  try {
    await ensureNotificationVipsTable();
    logger.info("[startup] notification VIPs table ready");
  } catch (e) {
    logger.warn({ e }, "Notification intelligence tables initialization warning");
  }

  try {
    await ensureTrustedSendersTable();
    logger.info("[startup] trusted_senders table ready");
  } catch (e) {
    logger.warn({ e }, "Trusted senders table initialization warning");
  }

  try {
    await ensureSavedPlacesTable();
    logger.info("[startup] saved_places table ready");
  } catch (e) {
    logger.warn({ e }, "Saved places table initialization warning");
  }

  try {
    await ensureListItemColumns();
    logger.info("[startup] list_items columns ready (added_by, category, url)");
  } catch (e) {
    logger.warn({ e }, "List items column initialization warning");
  }

  try {
    await ensureListShareTable();
  } catch (e) {
    logger.warn({ e }, "List share permissions table initialization warning");
  }

  try {
    await ensureBookingColumns();
  } catch (e) {
    logger.warn({ e }, "Booking credentials columns initialization warning");
  }

  try {
    await ensureServiceProvidersTable();
    logger.info("[startup] service_providers table ready");
  } catch (e) {
    logger.warn({ e }, "Service providers table initialization warning");
  }

  try {
    await ensureProviderCategoriesTable();
    logger.info("[startup] provider_categories table ready");
  } catch (e) {
    logger.warn({ e }, "Provider categories table initialization warning");
  }

  // Migrate auto_pay column onto financial_obligations if it doesn't exist yet
  try {
    await query(`ALTER TABLE financial_obligations ADD COLUMN IF NOT EXISTS auto_pay boolean DEFAULT false`);
    logger.info("[startup] financial_obligations.auto_pay column ready");
  } catch (e) {
    logger.warn({ e }, "auto_pay column migration warning");
  }

  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS watched_shows_user_name_lower_idx
       ON watched_shows (user_name, lower(show_name))`
    );
    logger.info("[startup] watched_shows unique index ready");
  } catch (e) {
    logger.warn({ e }, "watched_shows unique index warning (non-fatal)");
  }

  // Initialize medication reminder log table (DB-backed dedup so reminders don't
  // re-fire when the server restarts mid-morning)
  try {
    await initMedicationReminderLogTable();
    logger.info("[startup] medication_reminder_log table ready");
  } catch (e) {
    logger.warn({ e }, "medication_reminder_log table init warning");
  }

  // Repair: ensure the native user's profile is always marked onboarding_completed.
  // If this flag is false, getActiveUsers() returns empty and ALL schedulers silently
  // skip — no medication, bill, date, departure, or digest notifications fire.
  try {
    const repairResult = await query(
      `UPDATE user_profiles
          SET onboarding_completed = true
        WHERE user_name = $1 AND onboarding_completed = false
        RETURNING user_name`,
      [NATIVE_STORED_NAME]
    );
    if (repairResult.rows.length > 0) {
      logger.info({ userName: NATIVE_STORED_NAME }, "[startup] ✅ Repaired onboarding_completed flag — schedulers will now fire");
    } else {
      logger.info({ userName: NATIVE_STORED_NAME }, "[startup] onboarding_completed check OK — flag already true");
    }
  } catch (e) {
    logger.warn({ e }, "[startup] onboarding_completed repair failed — notifications may not fire");
  }

  startScheduler();
  startWinddownScheduler();
  startMedicationScheduler();
  startMorningPushScheduler();
  startWeatherAlertScheduler();
  startBillScheduler();
  await startDatesScheduler().catch((err: unknown) => {
    logger.warn({ err }, "Dates scheduler startup failed — server continues normally");
  });
  startDepartureScheduler();
  startCalendarSyncScheduler();
  startPickleballScheduler();
  startDallasProactiveScheduler();
  startVenueMonitorScheduler();
  startGarminScheduler();
  startJournalPatternScheduler();
  startPressureScheduler();
  startOrderTrackingScheduler();
  startTodoReminderScheduler();
  startBackgroundEmailScanner();
  startProviderScheduler();
  startConnectBirthdayScheduler();
  startContactBirthdayScheduler();

  // Seed David's music preferences into profile_items so they persist and
  // can be referenced in any conversation naturally.
  try {
    const musicPrefs: Array<{ name: string; detail: string }> = [
      { name: "Jimmy Buffett",     detail: "Favorite artist — loves his laid-back tropical rock style" },
      { name: "Bonnie Raitt",      detail: "Favorite artist — appreciates her blues-infused sound and slide guitar" },
      { name: "Jackson Browne",    detail: "Favorite artist — classic 70s rock/folk songwriting" },
      { name: "The Rolling Stones",detail: "Favorite band — classic rock 60s/70s" },
      { name: "Gordon Lightfoot",  detail: "Favorite artist — Canadian folk/rock legend" },
      { name: "Van Morrison",      detail: "Favorite artist — classic rock, Van Morrison's soulful style" },
      { name: "Classic Rock",      detail: "Primary genre preference — 1960s and 1970s rock" },
      { name: "Classic Jazz",      detail: "Loves classic jazz — bebop, big band, standards" },
    ];
    for (const pref of musicPrefs) {
      await addProfileItem("music", pref.name, pref.detail, NATIVE_STORED_NAME).catch(() => {});
    }
    const favoriteVenues: Array<{ name: string; detail: string }> = [
      { name: "Kessler Theater",               detail: "Favorite Dallas music venue — intimate, eclectic bookings" },
      { name: "Granada Theater",               detail: "Favorite Dallas music venue — mid-size, great sound" },
      { name: "Dos Equis Pavilion",            detail: "Favorite Dallas outdoor amphitheater" },
      { name: "AT&T Performing Arts Center",   detail: "Favorite Dallas performing arts venue" },
      { name: "Klyde Warren Park",             detail: "Favorite Dallas outdoor concert/event space" },
      { name: "Dallas Arboretum",              detail: "Loves Music Under the Stars concert series here" },
      { name: "Jazz at the Meyerson",          detail: "Favorite jazz venue — Meyerson Symphony Center" },
    ];
    for (const venue of favoriteVenues) {
      await addProfileItem("favorite_venues", venue.name, venue.detail, NATIVE_STORED_NAME).catch(() => {});
    }
    // Clean up any stale 'David' rows left from before user_name was added
    logger.info("Music preferences and favorite venues seeded to profile_items");
  } catch (e) {
    logger.warn({ e }, "Music preference seeding warning");
  }

  // Add device_id column to push_subscriptions for multi-device notification routing.
  try {
    await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS device_id text`);
    logger.info("Startup migration: push_subscriptions.device_id column ready");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: push_subscriptions device_id");
  }

  // Add updated_at column to push_subscriptions.
  try {
    await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz`);
    logger.info("Startup migration: push_subscriptions.updated_at column ready");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: push_subscriptions updated_at");
  }

  // Remove duplicate rows keeping the newest id per (user_name, device_id).
  // Must run before the unique index creation below.
  try {
    await query(
      `DELETE FROM push_subscriptions
       WHERE device_id IS NOT NULL
         AND id NOT IN (
           SELECT MAX(id)
           FROM push_subscriptions
           WHERE device_id IS NOT NULL
           GROUP BY user_name, device_id
         )
       RETURNING id`
    );
    logger.info("Startup migration: push_subscriptions duplicate rows cleaned");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: push_subscriptions dedup");
  }

  // Create partial unique index on (user_name, device_id) for non-null device_ids.
  // This lets the upsert use ON CONFLICT (user_name, device_id) WHERE device_id IS NOT NULL.
  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS push_subs_user_device_uidx
       ON push_subscriptions (user_name, device_id)
       WHERE device_id IS NOT NULL`
    );
    logger.info("Startup migration: push_subscriptions unique index on (user_name, device_id) ready");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: push_subscriptions unique index");
  }

  // Restore companion_name and voice_id for davidblakelock if they've been wiped.
  // Idempotent — companion_name only touched when it's still the old default or NULL;
  // voice_id only touched when NULL so a user-chosen voice is never overwritten.
  try {
    await query(
      `UPDATE user_profiles SET companion_name = 'James Bond'
       WHERE user_name = 'davidblakelock'
         AND (companion_name = 'Emma Peel' OR companion_name IS NULL)`
    );
    await query(
      `UPDATE user_profiles SET voice_id = 'Fahco4VZzobUeiPqni1S'
       WHERE user_name = 'davidblakelock'
         AND voice_id IS NULL`
    );
    logger.info("Startup migration: davidblakelock profile defaults ensured (companion_name + voice_id)");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: profile defaults fix");
  }

  // Migrate watched_shows rows stored under old user_name 'David' → 'davidblakelock'.
  // This happened when the system used a short display name instead of the login ID.
  try {
    const { rows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM watched_shows WHERE user_name = 'David'`
    );
    const stale = parseInt(rows[0]?.cnt ?? "0", 10);
    if (stale > 0) {
      await query(
        `UPDATE watched_shows SET user_name = 'davidblakelock' WHERE user_name = 'David' RETURNING id`
      );
      logger.info({ migratedCount: stale }, "Startup migration: watched_shows user_name 'David' → 'davidblakelock'");
    } else {
      logger.info("Startup migration: watched_shows user_name already clean");
    }
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: watched_shows user_name");
  }

  // Remove duplicate watched_shows rows — keep only the oldest (lowest id) per user+show.
  // Pass 1: deduplicate by exact (user_name, lower(show_name)).
  // Pass 2: deduplicate by (user_name, tvmaze_id) — catches "Lincoln Lawyer" vs "The Lincoln Lawyer"
  //         where TVmaze resolves both to the same show ID.
  try {
    // Log all current shows for diagnostics
    const { rows: allShows } = await query<{ user_name: string; show_name: string; tvmaze_id: number | null }>(
      `SELECT user_name, show_name, tvmaze_id FROM watched_shows ORDER BY user_name, show_name`
    );
    logger.info({ shows: allShows.map((s) => `${s.user_name}|${s.show_name}|tvmaze=${s.tvmaze_id}`) }, "Startup migration: watched_shows inventory");

    // Pass 1: deduplicate by (user_name, lower(show_name))
    const { rows: dupRows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM watched_shows w
       WHERE w.id NOT IN (
         SELECT DISTINCT ON (user_name, lower(show_name)) id
         FROM watched_shows
         ORDER BY user_name, lower(show_name), id ASC
       )`
    );
    const dupCount = parseInt(dupRows[0]?.cnt ?? "0", 10);
    if (dupCount > 0) {
      await query(
        `DELETE FROM watched_shows WHERE id NOT IN (
           SELECT DISTINCT ON (user_name, lower(show_name)) id
           FROM watched_shows
           ORDER BY user_name, lower(show_name), id ASC
         ) RETURNING id`
      );
      logger.info({ removed: dupCount }, "Startup migration: removed name-duplicate watched_shows rows");
    } else {
      logger.info("Startup migration: watched_shows has no exact-name duplicates");
    }

    // Pass 2: deduplicate by (user_name, tvmaze_id) — catches same show stored under different spellings
    const { rows: tvDupRows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM watched_shows w
       WHERE tvmaze_id IS NOT NULL
         AND w.id NOT IN (
           SELECT DISTINCT ON (user_name, tvmaze_id) id
           FROM watched_shows
           WHERE tvmaze_id IS NOT NULL
           ORDER BY user_name, tvmaze_id, id ASC
         )`
    );
    const tvDupCount = parseInt(tvDupRows[0]?.cnt ?? "0", 10);
    if (tvDupCount > 0) {
      await query(
        `DELETE FROM watched_shows WHERE tvmaze_id IS NOT NULL AND id NOT IN (
           SELECT DISTINCT ON (user_name, tvmaze_id) id
           FROM watched_shows
           WHERE tvmaze_id IS NOT NULL
           ORDER BY user_name, tvmaze_id, id ASC
         ) RETURNING id`
      );
      logger.info({ removed: tvDupCount }, "Startup migration: removed tvmaze-id-duplicate watched_shows rows");
    } else {
      logger.info("Startup migration: watched_shows has no tvmaze-id duplicates");
    }
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: watched_shows dedup");
  }
});
