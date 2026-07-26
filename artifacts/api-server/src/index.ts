// Build: 2026-06-11
declare const __GIT_COMMIT__: string;
console.log('RAILWAY_GIT_COMMIT_SHA=', process.env.RAILWAY_GIT_COMMIT_SHA);
console.log('RAILWAY_GIT_BRANCH=', process.env.RAILWAY_GIT_BRANCH);
console.log(`[startup] Build commit: ${__GIT_COMMIT__}`);
import app from "./app";
import { logger } from "./lib/logger";
import { setSchedulersEnabled } from "./routes/health";
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
import { startBillScheduler } from "./bills/billScheduler";
import { startDatesScheduler } from "./dates/datesScheduler";
import { startCalendarSyncScheduler, ensureCalendarSyncTable } from "./departure/calendarSyncScheduler";
import { ensureRelationshipTable } from "./relationships/relationshipManager";
import { startProactiveEventScheduler } from "./morning/proactiveEventScheduler";
import { initConcertsTable, startVenueMonitorScheduler } from "./morning/venueMonitor";
import { initBriefingStoriesTable } from "./morning/storyDedup";
import { runBriefingCacheMigrations } from "./morning/briefingCache";
import { syncPeopleDatesToImportantDates } from "./people/peopleManager.js";
import { ensureContactsTable } from "./google/contacts";
import { ensureJournalInsightsTable, startJournalPatternScheduler } from "./journal/journalPatternAnalyzer";
import { ensureMoodTable } from "./mood/moodManager";
import { ensureFollowupsTable } from "./followups/followupManager";
import { ensureMemoryArchiveTable } from "./memory/memoryArchiveManager";
import { ensureJournalSourceColumn } from "./routes/journal";
import { ensureConnectTables } from "./connect/connectManager";
import { ensureGroupTables } from "./connect/groupManager";
import { ensureCalendarSmartTables } from "./routes/calendarSmart";
import { ensureRestaurantCacheTable } from "./restaurants/restaurantIntelligence";
import { ensureOrdersTable } from "./orders/ordersManager";
import { ensureUserRecordsColumns, ensureSocialScanStateTable } from "./records/recordsManager";
import { ensureGoalsTables } from "./goals/goalsManager";
import { startTodoReminderScheduler } from "./lists/todoReminderScheduler";
import { startConnectionEngineScheduler } from "./connectionEngine/connectionEngineManager";

import { startBackgroundEmailScanner } from "./email/backgroundEmailScanner";
import { startRecordsArchiver } from "./records/recordsArchiver";
import { ensureListItemColumns } from "./lists/listManager";
import { ensureListShareTable } from "./lists/listShareManager";
import { ensureBookingColumns } from "./restaurants/bookingCredentialsManager";
import { ensureServiceProvidersTable, ensureProviderCategoriesTable } from "./providers/providerManager";
import { startTvEpisodeScheduler } from "./tv/tvEpisodeScheduler";
import { ensureStoicTables } from "./stoic/stoicManager";
import { ensureEmailScanSettingsTable } from "./email/emailScanSettings";
import { ensureVoiceOptionsTable, seedVoiceOptions } from "./voices/voiceOptionsManager";

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

  // ── Startup env diagnostics (helps debug Railway deployments) ──────────────
  const envCheck = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    ELEVENLABS_API_KEY: !!(process.env.ELEVENLABS_API_KEY || process.env.EL_API_KEY),
    ELEVENLABS_VOICE_ID: !!(process.env.ELEVENLABS_VOICE_ID || process.env.EL_VOICE_ID),
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
    DATABASE_URL: !!process.env.DATABASE_URL,
  };
  const missing = Object.entries(envCheck).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    logger.warn({ missing }, "[ENV] Missing environment variables — some features will be disabled");
  } else {
    logger.info({ envCheck }, "[ENV] All critical environment variables present");
  }

  // ── Firebase Admin SDK diagnostic — confirm FIREBASE_SERVICE_ACCOUNT_JSON loads ─
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      logger.warn("[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM unavailable");
    } else {
      const serviceAccount = JSON.parse(raw) as Record<string, unknown>;
      const { initializeApp, cert, getApps } = await import("firebase-admin/app");
      if (!getApps().length) {
        initializeApp({ credential: cert(serviceAccount as Parameters<typeof cert>[0]) });
      }
      logger.info({ projectId: serviceAccount.project_id }, "[Firebase] Admin SDK initialised OK");
    }
  } catch (e) {
    logger.error({ err: e }, "[Firebase] Admin SDK init FAILED — check FIREBASE_SERVICE_ACCOUNT_JSON");
  }

  // ── Explicit DB backend probe — logs which backend resolved at startup ────────
  try {
    const { rows: probeRows } = await query<{ ok: number }>(`SELECT 1 AS ok`);
    logger.info({ ok: probeRows[0]?.ok === 1 }, "[startup] DB backend probe complete — using Supabase REST");
  } catch (e) {
    logger.error({ err: e }, "[startup] DB backend probe FAILED — check SUPABASE_URL / SUPABASE_SERVICE_KEY");
  }

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
      "recommendations",
      "sunday_summaries",
      "winddown_schedules",
      "onboarding_state",
      "bill_payment_log",
      "chat_messages",
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
  } catch (e) {
    logger.warn({ err: e }, "winddown tables initialization warning");
  }
  try {
    await ensureBriefingPreferencesTable();
  } catch (e) {
    logger.warn({ err: e }, "briefing preferences table initialization warning");
  }
  try {
    await ensureMemoryTable();
  } catch (e) {
    logger.warn({ err: e }, "memory table initialization warning");
  }
  try {
    await ensureProfileTable();
  } catch (e) {
    logger.warn({ err: e }, "profile_items table initialization warning");
  }
  try {
    await ensureOnboardingTable();
  } catch (e) {
    logger.warn({ err: e }, "onboarding/user_profiles table initialization warning");
  }
  try {
    await ensureRelationshipTable();
  } catch (e) {
    logger.warn({ err: e }, "relationship table initialization warning");
  }

  // Isolated so a failure in the block above never skips the calendar migration
  try {
    await ensureCalendarSyncTable();
  } catch (e) {
    logger.warn({ err: e }, "calendar_sync_state table initialization warning");
  }

  try {
    await ensureMoodTable();
    await ensureFollowupsTable();
    await ensureMemoryArchiveTable();
    await ensureJournalSourceColumn();
    logger.info("[startup] mood_checkins, conversation_followups, memory_archive, journal source column ready");
  } catch (e) {
    logger.warn({ err: e }, "New feature table initialization warning");
  }

  // Isolated block so a failure above never skips this critical table

  try {
    await ensureUsersTable();
    logger.info("[startup] users table ready");
  } catch (e) {
    logger.warn({ err: e }, "users table initialization warning");
  }

  try {
    await ensureStoicTables();
    logger.info("[startup] stoic_curriculum + user_settings tables ready");
  } catch (e) {
    logger.warn({ err: e }, "Stoic tables initialization warning");
  }

  try {
    await initConcertsTable();
  } catch (e) {
    logger.warn({ err: e }, "Concerts table initialization warning");
  }

  try {
    await initBriefingStoriesTable();
    logger.info("[startup] daily_briefing_stories table ready");
  } catch (e) {
    logger.warn({ err: e }, "Briefing stories table initialization warning");
  }

  try {
    await runBriefingCacheMigrations();
  } catch (e) {
    logger.warn({ err: e }, "Briefing cache migration warning");
  }

  try {
    const { ensureApifyCacheTable } = await import("./lib/apifyCache.js");
    await ensureApifyCacheTable();
  } catch (e) {
    logger.warn({ err: e }, "apify_cache table initialization warning");
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
    logger.warn({ err: e }, "chat_messages message_id migration warning");
  }

  try {
    await ensureContactsTable();
  } catch (e) {
    logger.warn({ err: e }, "Contacts table initialization warning");
  }

  try {
    await ensureJournalInsightsTable();
    logger.info("[startup] journal_insights table ready");
  } catch (e) {
    logger.warn({ err: e }, "Journal insights table initialization warning");
  }

  try {
    await ensureConnectTables();
  } catch (e) {
    logger.warn({ err: e }, "Winston Connect table initialization warning");
  }

  try {
    await ensureGroupTables();
    logger.info("[startup] Connect group tables ready");
  } catch (e) {
    logger.warn({ err: e }, "Connect group table initialization warning");
  }

  try {
    await ensureCalendarSmartTables();
  } catch (e) {
    logger.warn({ err: e }, "Calendar smart settings table initialization warning");
  }

  try {
    await ensureRestaurantCacheTable();
    logger.info("[startup] restaurant_places_cache table ready");
  } catch (e) {
    logger.warn({ err: e }, "Restaurant places cache table initialization warning");
  }

  try {
    await ensureOrdersTable();
    await ensureGoalsTables();
  } catch (e) {
    logger.warn({ err: e }, "Orders table initialization warning");
  }

  try {
    await ensureUserRecordsColumns();
    await ensureSocialScanStateTable();
  } catch (e) {
    logger.warn({ err: e }, "Records table migration warning");
  }

  try {
    await ensureListItemColumns();
    logger.info("[startup] list_items columns ready (added_by, category, url)");
  } catch (e) {
    logger.warn({ err: e }, "List items column initialization warning");
  }

  try {
    await ensureListShareTable();
  } catch (e) {
    logger.warn({ err: e }, "List share permissions table initialization warning");
  }

  try {
    await ensureBookingColumns();
  } catch (e) {
    logger.warn({ err: e }, "Booking credentials columns initialization warning");
  }

  try {
    await ensureServiceProvidersTable();
    logger.info("[startup] service_providers table ready");
  } catch (e) {
    logger.warn({ err: e }, "Service providers table initialization warning");
  }

  try {
    await ensureProviderCategoriesTable();
    logger.info("[startup] provider_categories table ready");
  } catch (e) {
    logger.warn({ err: e }, "Provider categories table initialization warning");
  }

  // Migrate auto_pay column onto financial_obligations if it doesn't exist yet
  try {
    await query(`ALTER TABLE financial_obligations ADD COLUMN IF NOT EXISTS auto_pay boolean DEFAULT false`);
    logger.info("[startup] financial_obligations.auto_pay column ready");
  } catch (e) {
    logger.warn({ err: e }, "auto_pay column migration warning");
  }

  try {
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS watched_shows_user_name_lower_idx
       ON watched_shows (user_name, lower(show_name))`
    );
    logger.info("[startup] watched_shows unique index ready");
  } catch (e) {
    logger.warn({ err: e }, "watched_shows unique index warning (non-fatal)");
  }

  // Initialize medication reminder log table (DB-backed dedup so reminders don't
  // re-fire when the server restarts mid-morning)
  try {
    await initMedicationReminderLogTable();
    logger.info("[startup] medication_reminder_log table ready");
  } catch (e) {
    logger.warn({ err: e }, "medication_reminder_log table init warning");
  }

  // Onboarding nudge log — tracks the last date we reminded a user to finish setup
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS onboarding_nudge_log (
        user_name TEXT PRIMARY KEY,
        last_mention_date DATE NOT NULL
      )`,
      []
    );
    logger.info("[startup] onboarding_nudge_log table ready");
  } catch (e) {
    logger.warn({ err: e }, "onboarding_nudge_log table init warning");
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
    logger.warn({ err: e }, "[startup] onboarding_completed repair failed — notifications may not fire");
  }

  try {
    await syncPeopleDatesToImportantDates();
    logger.info("[startup] key_people dates synced → important_dates");
  } catch (e) {
    logger.warn({ err: e }, "[startup] key_people dates sync warning");
  }

  // Schedulers run only on Railway (production). Replit is dev-only.
  // RAILWAY_ENVIRONMENT is set automatically by Railway on all deployments.
  if (process.env.RAILWAY_ENVIRONMENT) {
    logger.info("[startup] Railway environment detected — starting all schedulers");
    startScheduler();
    startWinddownScheduler();
    startMedicationScheduler();
    startMorningPushScheduler();
    startBillScheduler();
    await startDatesScheduler().catch((err: unknown) => {
      logger.warn({ err }, "Dates scheduler startup failed — server continues normally");
    });
    startCalendarSyncScheduler();
    startVenueMonitorScheduler();
    startProactiveEventScheduler();
    startJournalPatternScheduler();
    startTodoReminderScheduler();
    startConnectionEngineScheduler();
    startBackgroundEmailScanner();
    startRecordsArchiver();
    void startTvEpisodeScheduler();
    setSchedulersEnabled();
    logger.info("[startup] ✅ All schedulers started");
  } else {
    logger.info("[startup] Non-Railway environment — schedulers disabled (dev mode)");
  }

  // Create user_service_preferences table for managing preferred grocery/health/shopping services.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS user_service_preferences (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_name text NOT NULL,
        service_name text NOT NULL,
        service_type text NOT NULL,
        is_connected boolean NOT NULL DEFAULT false,
        preferred boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(user_name, service_name)
      )
    `);
    logger.info("Startup migration: user_service_preferences table ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: user_service_preferences table");
  }

  // Create user_email_scan_settings table for per-user email scan interval and vacation mode.
  try {
    await ensureEmailScanSettingsTable();
    logger.info("Startup migration: user_email_scan_settings table ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: user_email_scan_settings table");
  }

  // Create voice_options table and seed with curated ElevenLabs voice list.
  try {
    await ensureVoiceOptionsTable();
    await seedVoiceOptions();
    logger.info("Startup migration: voice_options table ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: voice_options table");
  }

  // Add device_id column to push_subscriptions for multi-device notification routing.
  try {
    await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS device_id text`);
    logger.info("Startup migration: push_subscriptions.device_id column ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: push_subscriptions device_id");
  }

  // Add updated_at column to push_subscriptions.
  try {
    await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz`);
    logger.info("Startup migration: push_subscriptions.updated_at column ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: push_subscriptions updated_at");
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
    logger.warn({ err: e }, "Startup migration warning: push_subscriptions dedup");
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
    logger.warn({ err: e }, "Startup migration warning: push_subscriptions unique index");
  }

  // Restore voice_id for davidblakelock if it has been wiped.
  // Idempotent — only touched when NULL so a user-chosen voice is never overwritten.
  try {
    await query(
      `UPDATE user_profiles SET voice_id = 'Fahco4VZzobUeiPqni1S'
       WHERE user_name = 'davidblakelock'
         AND voice_id IS NULL`
    );
    logger.info("Startup migration: davidblakelock voice_id default ensured");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: profile defaults fix");
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
    logger.warn({ err: e }, "Startup migration warning: watched_shows user_name");
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
    logger.warn({ err: e }, "Startup migration warning: watched_shows dedup");
  }

  // Create fcm_push_tokens table for native FCM token storage.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fcm_push_tokens (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_name text NOT NULL,
        fcm_token text NOT NULL UNIQUE,
        device_id text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `);
    logger.info("Startup migration: fcm_push_tokens table ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: fcm_push_tokens table");
  }
  try {
    await query(`ALTER TABLE profile_items ADD COLUMN IF NOT EXISTS notes TEXT`);
    logger.info("Startup migration: profile_items.notes column ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: profile_items notes column");
  }

  // Create medication_reminder_times table for per-medication scheduled times.
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS medication_reminder_times (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        medication_id integer NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        reminder_time text NOT NULL,
        created_at timestamptz DEFAULT now()
      )
    `);
    logger.info("Startup migration: medication_reminder_times table ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: medication_reminder_times table");
  }

  // Unique index — prevents duplicate times per medication, also makes the backfill ON CONFLICT safe.
  try {
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS medication_reminder_times_med_time_uidx
        ON medication_reminder_times (medication_id, reminder_time)
    `);
    logger.info("Startup migration: medication_reminder_times unique index ready");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: medication_reminder_times unique index");
  }

  // One-time backfill: seed one row per existing medication that has a non-null reminder_time.
  // ON CONFLICT DO NOTHING makes this idempotent — safe on every subsequent startup.
  try {
    const { rows: seeded } = await query<{ id: number }>(`
      INSERT INTO medication_reminder_times (medication_id, reminder_time)
      SELECT id, reminder_time
        FROM medications
       WHERE reminder_time IS NOT NULL
      ON CONFLICT (medication_id, reminder_time) DO NOTHING
      RETURNING id
    `);
    logger.info({ seeded: seeded.length }, "Startup migration: medication_reminder_times backfill complete");
  } catch (e) {
    logger.warn({ err: e }, "Startup migration warning: medication_reminder_times backfill");
  }
});
