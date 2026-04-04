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
import { startPickleballScheduler } from "./pickleball/pickleballScheduler";
import { startConversationStarterScheduler } from "./push/conversationStarterScheduler";

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
  } catch (e) {
    logger.warn({ e }, "Table initialization warning");
  }

  startScheduler();
  startWinddownScheduler();
  startMedicationScheduler();
  startMorningPushScheduler();
  startWeatherAlertScheduler();
  startBillScheduler();
  await startDatesScheduler();
  startDepartureScheduler();
  startPickleballScheduler();
  startConversationStarterScheduler();

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

  // One-time data migration: set companion_name for David if it was never saved during onboarding.
  // Safe to run every startup — WHERE condition makes it a no-op once the name is set.
  try {
    await query(
      `UPDATE user_profiles up
       SET companion_name = 'Emma Peel'
       FROM app_sessions s
       WHERE up.user_name = s.user_name
         AND s.google_id = '105826305820216987064'
         AND (up.companion_name IS NULL OR up.companion_name = '')
         AND up.onboarding_completed = true`,
      []
    );
    logger.info("Startup migration: companion_name check complete");
  } catch (e) {
    logger.warn({ e }, "Startup migration warning: companion_name");
  }
});
