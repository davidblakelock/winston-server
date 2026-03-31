import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import {
  getMedications,
  hasTakenMedicationsToday,
  buildMedReminderText,
} from "./medicationManager.js";
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

function buildInitialMessage(medText: string): string {
  return `Good morning, David — don't forget to take ${medText} today. Take them with food if you can.`;
}

function buildFollowUpMessage(medText: string): string {
  return `Just a gentle nudge, David — have you taken ${medText} yet? Whenever you're ready.`;
}

async function checkAndFireMedicationReminder(
  targetTime: string,
  isFollowUp: boolean
): Promise<void> {
  const localTime = getCurrentLocalTime();
  if (localTime !== targetTime) return;

  const meds = await getMedications();
  if (!meds.length) return;

  const taken = await hasTakenMedicationsToday();
  if (taken) return;

  const medText = buildMedReminderText(meds);
  const message = isFollowUp ? buildFollowUpMessage(medText) : buildInitialMessage(medText);

  broadcast("reminder", {
    id: `med-${Date.now()}`,
    userName: "David",
    reminderText: isFollowUp
      ? `Gentle nudge — have you taken ${medText} yet?`
      : `Don't forget to take ${medText} today. Take them with food if you can.`,
    speakText: message,
    isMedication: true,
  });

  logger.info({ targetTime, isFollowUp, medCount: meds.length }, "Medication reminder fired");
}

let _initialFiredDate: string | null = null;
let _followUpFiredDate: string | null = null;

export function startMedicationScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      const meds = await getMedications().catch(() => []);
      if (!meds.length) return;

      // Collect unique reminder times; also check 9am follow-up
      const reminderTimes = [...new Set(meds.map((m) => m.reminderTime))];

      for (const rt of reminderTimes) {
        const localTime = getCurrentLocalTime();
        if (localTime === rt && _initialFiredDate !== today) {
          const taken = await hasTakenMedicationsToday();
          if (!taken) {
            const medText = buildMedReminderText(meds);
            broadcast("reminder", {
              id: `med-init-${Date.now()}`,
              userName: "David",
              reminderText: `Don't forget to take ${medText} today. Take them with food if you can.`,
              speakText: buildInitialMessage(medText),
              isMedication: true,
            });
            sendPushToAll({
              title: "💊 Medication Reminder — Emma Peel",
              body: `Don't forget your ${medText} this morning. Take with food if you can.`,
              tag: "medication-morning",
              url: "/",
              requireInteraction: true,
            }).catch(() => {});
            logger.info({ time: rt }, "Medication initial reminder fired");
          }
          _initialFiredDate = today;
        }
      }

      // Follow-up 1 hour after earliest reminder time
      const [h, m] = meds[0].reminderTime.split(":").map(Number);
      const followUpH = (h + 1) % 24;
      const followUpTime = `${String(followUpH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const localTime = getCurrentLocalTime();

      if (localTime === followUpTime && _followUpFiredDate !== today) {
        const taken = await hasTakenMedicationsToday();
        if (!taken) {
          const medText = buildMedReminderText(meds);
          broadcast("reminder", {
            id: `med-followup-${Date.now()}`,
            userName: "David",
            reminderText: `Gentle nudge — have you taken ${medText} yet?`,
            speakText: buildFollowUpMessage(medText),
            isMedication: true,
          });
          sendPushToAll({
            title: "💊 Gentle Nudge — Emma Peel",
            body: `Have you taken your ${medText} yet? Tap to confirm.`,
            tag: "medication-followup",
            url: "/",
            requireInteraction: false,
          }).catch(() => {});
          logger.info({ time: followUpTime }, "Medication follow-up reminder fired");
        }
        _followUpFiredDate = today;
      }
    } catch (err) {
      logger.error({ err }, "Medication scheduler error");
    }
  });

  logger.info("Medication scheduler started");
}
