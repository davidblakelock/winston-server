import cron from "node-cron";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getMedications,
  hasTakenMedicationsToday,
  buildMedReminderText,
  getMedicationRemindersEnabled,
  hasMedicationReminderSentToday,
  logMedicationReminderSent,
} from "./medicationManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";

const TZ = "America/Chicago";

function getCurrentLocalTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function startMedicationScheduler(): void {
  let _running = false;
  cron.schedule("10 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const localTime = getCurrentLocalTime();

      const users = await getActiveUsers().catch(() => []);
      if (!users.length) return;

      for (const user of users) {
        const { userName, companionName } = user;
        const companion = companionName ?? "Winston";

        const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
        if (!remindersEnabled) continue;

        const meds = await getMedications(userName).catch(() => []);
        if (!meds.length) continue;

        const reminderTimes = [...new Set(meds.map((m) => m.reminderTime))];

        for (const rt of reminderTimes) {
          // Only fire within a morning window (reminder time → 11:00 AM max).
          // Without this ceiling, a server restart in the afternoon/evening will
          // re-fire because the production DB has no "sent today" record from dev.
          if (localTime < rt || localTime >= "11:00") continue;

          let alreadySent = false;
          try {
            alreadySent = await hasMedicationReminderSentToday(userName, "initial");
          } catch (err) {
            // Table missing — skip rather than fire. Far safer than firing twice.
            logger.warn({ err, userName, rt }, "[MED] hasMedicationReminderSentToday threw — skipping tick");
            continue;
          }

          if (alreadySent) {
            logger.info({ userName, rt, localTime }, "[MED] Reminder already sent today — skipping");
            continue;
          }

          let taken = false;
          try {
            taken = await hasTakenMedicationsToday(userName);
          } catch (err) {
            logger.warn({ err, userName }, "[MED] hasTakenMedicationsToday threw — treating as not taken");
          }

          if (!taken) {
            const medText = buildMedReminderText(meds);
            sendPushToAll({
              title: "Time for your medications 💊",
              body: "Have you taken your medications?",
              tag: "medication-morning",
              notificationType: "medication",
              categoryIdentifier: "medication-action",
              requireInteraction: true,
            }, userName).catch((err: unknown) => {
              logger.error({ err, userName }, "[MED] Push delivery failed");
            });
            logger.info({ time: rt, userName, medText }, "[MED] Morning reminder fired");
          } else {
            logger.info({ userName, rt }, "[MED] Skipping push — medications already taken today");
          }

          // Mark sent regardless of taken status — prevents re-firing on server restart
          await logMedicationReminderSent(userName, "initial").catch((err: unknown) => {
            logger.warn({ err, userName }, "[MED] logMedicationReminderSent failed");
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "Medication scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Medication scheduler started");
}
