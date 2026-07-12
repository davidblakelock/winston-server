import cron from "node-cron";
import { sendFcmNotification } from "../push/fcmSender.js";
import {
  getMedications,
  hasTakenMedicationsToday,
  hasAcknowledgedSlot,
  getMedicationRemindersEnabled,
  hasMedicationReminderSentToday,
  logMedicationReminderSent,
} from "./medicationManager.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";


const _takenLoggedToday = new Set<string>();
let _takenLogDay: string | null = null;

function clearTakenLogIfNewDay() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  if (_takenLogDay !== today) { _takenLoggedToday.clear(); _takenLogDay = today; }
}

function getCurrentLocalTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "UTC",
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
      clearTakenLogIfNewDay();
      const users = await getActiveUsers().catch(() => []);
      if (!users.length) return;

      for (const user of users) {
        const { userName } = user;

        const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
        if (!remindersEnabled) continue;

        const meds = await getMedications(userName).catch(() => []);
        if (!meds.length) continue;

        // Flatten reminderTimes arrays across all meds, deduplicated by unique time value.
        const uniqueTimes = [
          ...new Set(meds.flatMap((m) => m.reminderTimes ?? [m.reminderTime])),
        ];

        for (const time of uniqueTimes) {
          if (localTime < time) continue;
          // Don't fire more than 2 hours after the scheduled time — prevents
          // a late server start (e.g. 7 PM deploy) from sending the 7 AM slot.
          const [schedH, schedM] = time.split(":").map(Number);
          const [localH, localM] = localTime.split(":").map(Number);
          if (localH * 60 + localM > schedH * 60 + schedM + 120) continue;

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

          let slotAcknowledged = false;
          try {
            slotAcknowledged = await hasAcknowledgedSlot(userName, time);
          } catch (err) {
            logger.warn({ err, userName, time }, "[MED] hasAcknowledgedSlot threw — treating as not acknowledged");
          }
          if (slotAcknowledged) {
            if (!_takenLoggedToday.has(userName)) {
              const allTaken = await hasTakenMedicationsToday(userName).catch(() => false);
              logger.info({ userName, time, localTime, allTaken }, "[MED] Medications already taken today — suppressing all remaining times");
              _takenLoggedToday.add(userName);
            }
            continue;
          }

          sendFcmNotification({
            userName,
            notificationType: "medication",
            title: "Time for your medications 💊",
            body: "Have you taken your medications?",
            data: { reminderTime: time },
          }).catch((err: unknown) => {
            logger.error({ err, userName, time }, "[MED] FCM push delivery failed");
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
