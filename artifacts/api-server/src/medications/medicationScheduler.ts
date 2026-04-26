import cron from "node-cron";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { broadcast } from "../reminders/sseStore.js";
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

function buildInitialMessage(medText: string, displayName = NATIVE_STORED_NAME): string {
  return `Good morning, ${displayName} — don't forget to take ${medText} today. Take them with food if you can.`;
}

function buildFollowUpMessage(medText: string, displayName = NATIVE_STORED_NAME): string {
  return `Just a gentle nudge, ${displayName} — have you taken ${medText} yet? Whenever you're ready.`;
}

export function startMedicationScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const localTime = getCurrentLocalTime();

      const users = await getActiveUsers().catch(() => []);
      if (!users.length) return;

      for (const user of users) {
        const { userName, name: displayName, companionName } = user;
        const userDisplay = displayName ?? userName;
        const companion = companionName ?? "Winston";

        // Check mute preference first — skip everything if reminders are disabled
        const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
        if (!remindersEnabled) continue;

        const meds = await getMedications(userName).catch(() => []);
        if (!meds.length) continue;

        // Collect unique reminder times
        const reminderTimes = [...new Set(meds.map((m) => m.reminderTime))];

        for (const rt of reminderTimes) {
          if (localTime === rt) {
            // DB-backed check — survives server restarts
            const alreadySent = await hasMedicationReminderSentToday(userName, "initial").catch(() => false);
            if (alreadySent) continue;

            const taken = await hasTakenMedicationsToday(userName).catch(() => false);
            if (!taken) {
              const medText = buildMedReminderText(meds);
              broadcast("reminder", {
                id: `med-init-${userName}-${Date.now()}`,
                userName,
                reminderText: `Don't forget to take ${medText} today. Take them with food if you can.`,
                speakText: buildInitialMessage(medText, userDisplay),
                isMedication: true,
              });
              sendPushToAll({
                title: `💊 Medication Reminder — ${companion}`,
                body: `Don't forget your ${medText} this morning. Take with food if you can.`,
                tag: "medication-morning",
                notificationType: "medication",
                requireInteraction: true,
              }, userName).catch(() => {});
              logger.info({ time: rt, userName }, "Medication initial reminder fired");
            }
            // Mark as sent regardless of taken status — prevents re-firing if server restarts
            await logMedicationReminderSent(userName, "initial").catch(() => {});
          }
        }

        // Follow-up 1 hour after earliest reminder time
        const [h, m] = meds[0].reminderTime.split(":").map(Number);
        const followUpH = (h + 1) % 24;
        const followUpTime = `${String(followUpH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

        if (localTime === followUpTime) {
          // DB-backed check — survives server restarts
          const alreadySent = await hasMedicationReminderSentToday(userName, "followup").catch(() => false);
          if (alreadySent) continue;

          const taken = await hasTakenMedicationsToday(userName).catch(() => false);
          if (!taken) {
            const medText = buildMedReminderText(meds);
            broadcast("reminder", {
              id: `med-followup-${userName}-${Date.now()}`,
              userName,
              reminderText: `Gentle nudge — have you taken ${medText} yet?`,
              speakText: buildFollowUpMessage(medText, userDisplay),
              isMedication: true,
            });
            sendPushToAll({
              title: `💊 Gentle Nudge — ${companion}`,
              body: `Have you taken your ${medText} yet? Tap to confirm.`,
              tag: "medication-followup",
              notificationType: "medication",
              requireInteraction: false,
            }, userName).catch(() => {});
            logger.info({ time: followUpTime, userName }, "Medication follow-up reminder fired");
          }
          // Mark follow-up as sent — prevents re-firing if server restarts
          await logMedicationReminderSent(userName, "followup").catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "Medication scheduler error");
    }
  });

  logger.info("Medication scheduler started");
}
