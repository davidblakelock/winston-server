import cron from "node-cron";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getMedications,
  hasTakenMedicationsToday,
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
        const { userName } = user;

        const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
        if (!remindersEnabled) continue;

        const meds = await getMedications(userName).catch(() => []);
        if (!meds.length) continue;

        // Upfront check: once the user confirms taken, suppress every remaining time slot for today.
        let taken = false;
        try {
          taken = await hasTakenMedicationsToday(userName);
        } catch (err) {
          logger.warn({ err, userName }, "[MED] hasTakenMedicationsToday threw — treating as not taken");
        }
        if (taken) {
          logger.info({ userName, localTime }, "[MED] Medications already taken today — suppressing all remaining times");
          continue;
        }

        // Flatten reminderTimes arrays across all meds, deduplicated by unique time value.
        const uniqueTimes = [
          ...new Set(meds.flatMap((m) => m.reminderTimes ?? [m.reminderTime])),
        ];

        for (const time of uniqueTimes) {
          if (localTime < time) continue;

          // Dedup key is per user+time — each time slot fires independently.
          const reminderKey = `${userName}:${time}`;
          let alreadySent = false;
          try {
            alreadySent = await hasMedicationReminderSentToday(userName, reminderKey);
          } catch (err) {
            logger.warn({ err, userName, time }, "[MED] hasMedicationReminderSentToday threw — skipping tick");
            continue;
          }

          if (alreadySent) {
            logger.info({ userName, time, localTime }, "[MED] Reminder already sent for this time today — skipping");
            continue;
          }

          sendPushToAll({
            title: "Time for your medications 💊",
            body: "Have you taken your medications?",
            tag: "medication-morning",
            notificationType: "medication",
            categoryIdentifier: "medication-action",
            requireInteraction: true,
            actionTaken: "/api/medications/confirm-taken",
            actionSnooze: "/api/medications/snooze-reminder",
            snoozeMinutes: 60,
          }, userName).catch((err: unknown) => {
            logger.error({ err, userName, time }, "[MED] Push delivery failed");
          });
          logger.info({ time, userName }, "[MED] Reminder fired");

          await logMedicationReminderSent(userName, reminderKey).catch((err: unknown) => {
            logger.warn({ err, userName, time }, "[MED] logMedicationReminderSent failed");
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
