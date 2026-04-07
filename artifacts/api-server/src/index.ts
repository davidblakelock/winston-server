import app from "./app";
import { logger } from "./lib/logger";
import { query } from "./db";
import { startScheduler } from "./reminders/scheduler";
import { startWinddownScheduler } from "./winddown/winddownScheduler";
import { ensureWinddownTables } from "./winddown/winddownManager";
import { ensureMemoryTable } from "./memory/memoryManager";
import { ensureProfileTable } from "./profile/profileManager";
import { ensureOnboardingTable } from "./onboarding/onboardingManager";
import { startMedicationScheduler } from "./medications/medicationScheduler";
import { seedDefaultMedications } from "./medications/medicationManager";
import { startMorningPushScheduler } from "./push/morningPushScheduler";
import { startWeatherAlertScheduler } from "./push/weatherAlertScheduler";
import { startBillScheduler } from "./bills/billScheduler";
import { startDatesScheduler } from "./dates/datesScheduler";
import { startDepartureScheduler } from "./departure/departureScheduler";
import { startCalendarSyncScheduler, ensureCalendarSyncTable } from "./departure/calendarSyncScheduler";
import { startCalendarAlertScheduler } from "./departure/calendarAlertScheduler";
import { startPickleballScheduler, ensureProactiveMessageLogTable } from "./pickleball/pickleballScheduler";
import { startConversationStarterScheduler } from "./push/conversationStarterScheduler";
import { ensureRelationshipTable } from "./relationships/relationshipManager";
import { ensureContactMentionsTable } from "./olivia/oliviaTracker";
import { initDallasContentTable } from "./morning/dallasContent";
import { startDallasProactiveScheduler } from "./morning/dallasProactiveScheduler";
import { initConcertsTable, startVenueMonitorScheduler } from "./morning/venueMonitor";
import { addProfileItem } from "./profile/profileManager";
import { ensureContactsTable } from "./google/contacts";

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

  try {
    await ensureWinddownTables();
    await ensureMemoryTable();
    await ensureProfileTable();
    await ensureOnboardingTable();
    await ensureRelationshipTable();
    await ensureContactMentionsTable();
    await ensureCalendarSyncTable();
  } catch (e) {
    logger.warn({ e }, "Table initialization warning");
  }

  // Isolated block so a failure above never skips this critical table
  try {
    await ensureProactiveMessageLogTable();
    logger.info("[startup] proactive_message_log table ready");
  } catch (e) {
    logger.warn({ e }, "proactive_message_log table initialization warning");
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
    await ensureContactsTable();
  } catch (e) {
    logger.warn({ e }, "Contacts table initialization warning");
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
  startCalendarAlertScheduler();
  startPickleballScheduler();
  startConversationStarterScheduler();
  startDallasProactiveScheduler();
  startVenueMonitorScheduler();

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
      await addProfileItem("music", pref.name, pref.detail, "David").catch(() => {});
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
      await addProfileItem("favorite_venues", venue.name, venue.detail, "David").catch(() => {});
    }
    // Clean up any stale 'David' rows left from before user_name was added
    logger.info("Music preferences and favorite venues seeded to profile_items");
  } catch (e) {
    logger.warn({ e }, "Music preference seeding warning");
  }

  try {
    await seedDefaultMedications();
  } catch (e) {
    logger.warn({ e }, "Medication seed warning");
  }

  // Add device_id column to push_subscriptions for multi-device notification routing.
  try {
    await query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS device_id text`);
    logger.info("Startup migration: push_subscriptions.device_id column ready");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: push_subscriptions device_id");
  }

  // companion_name migration removed — it used UPDATE...FROM (cross-table join) which
  // the Supabase exec_sql client silently ignores, stripping the WHERE guard and
  // unconditionally overwriting user-chosen companion names with 'Emma Peel' on every restart.
  logger.info("Startup migration: companion_name check complete (migration removed)");
});
