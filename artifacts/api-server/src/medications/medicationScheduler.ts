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
  cron.schedule("* * * * *", async () => {
    try {
      const localTime = getCurrentLocalTime();

      const users = await getActiveUsers().catch(() => []);
      if (!users.length) return;

      for (const user of users) {
        const { userName, companionName } = user;
        const companion = companionName ?? "Winston";

        // Check mute preference first — skip everything if reminders are disabled
        const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
        if (!remindersEnabled) continue;

        const meds = await getMedications(userName).catch(() => []);
        if (!meds.length) continue;

        // Collect unique reminder times
        const reminderTimes = [...new Set(meds.map((m) => m.reminderTime))];

        // Use >= comparison rather than exact match so a missed cron tick doesn't
        // silently skip the reminder for the whole day. The DB-backed
        // hasMedicationReminderSentToday guard ensures we fire at most once per day.
        for (const rt of reminderTimes) {
          if (localTime >= rt) {
            // DB-backed check — survives server restarts
            const alreadySent = await hasMedicationReminderSentToday(userName, "initial").catch(() => false);
            if (alreadySent) continue;

            const taken = await hasTakenMedicationsToday(userName).catch(() => false);
            if (!taken) {
              const medText = buildMedReminderText(meds);
              sendPushToAll({
                title: `💊 Medication Reminder — ${companion}`,
                body: `Time to take your ${medText}.`,
                tag: "medication-morning",
                notificationType: "medication",
                // "medication-action" shows "Taken ✓" and "Remind in 30 min" buttons.
                categoryId: "medication-action",
                requireInteraction: true,
              }, userName).catch(() => {});
              logger.info({ time: rt, userName }, "Medication initial reminder fired");
            }
            // Mark as sent regardless of taken status — prevents re-firing if server restarts
            await logMedicationReminderSent(userName, "initial").catch(() => {});
          }
        }

        // No automatic follow-up — the initial reminder shows "Taken ✓" and
        // "Remind in 1 hour" action buttons. The user triggers any follow-up
        // themselves by tapping "Remind in 1 hour" on the notification.
      }
    } catch (err) {
      logger.error({ err }, "Medication scheduler error");
    }
  });

  logger.info("Medication scheduler started");
}
