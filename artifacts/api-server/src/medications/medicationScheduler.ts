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
import { query } from "../db.js";
import { getActiveUsers } from "../onboarding/onboardingManager.js";
import { logger } from "../lib/logger.js";

async function getInitialReminderSentAt(userName: string): Promise<Date | null> {
  const { rows } = await query<{ sent_at: string }>(
    `SELECT sent_at FROM medication_reminder_log
     WHERE user_name = $1 AND reminder_date = CURRENT_DATE AND reminder_type = 'initial'
     LIMIT 1`,
    [userName]
  );
  return rows.length > 0 ? new Date(rows[0].sent_at) : null;
}

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
            let alreadySent = false;
            try {
              alreadySent = await hasMedicationReminderSentToday(userName, "initial");
            } catch (err) {
              // Table missing or query failed — SKIP this tick rather than firing.
              // Continuous firing (the old "treat as not sent" behavior) is far worse
              // than missing one tick. The table will be created on startup.
              logger.warn({ err, userName, rt }, "[MED] hasMedicationReminderSentToday threw — skipping tick (safe default)");
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
            logger.info({ userName, rt, localTime, taken }, "[MED] Reminder check — about to fire or skip");

            if (!taken) {
              const medText = buildMedReminderText(meds);
              sendPushToAll({
                title: `💊 Medication Reminder — ${companion}`,
                body: `Time to take your ${medText}.`,
                tag: "medication-morning",
                notificationType: "medication",
                // categoryId "medication-reminder" — native app must register this category
                // with two action buttons:
                //   { identifier: "MEDICATION_DONE",      title: "Done ✓",                   destructive: false }
                //   { identifier: "MEDICATION_SNOOZE_30", title: "Remind me in 30 minutes",  destructive: false }
                categoryId: "medication-reminder",
                requireInteraction: true,
              }, userName).catch((err: unknown) => {
                logger.error({ err, userName }, "[MED] Push delivery failed");
              });
              logger.info({ time: rt, userName, medText }, "Medication initial reminder fired");
            } else {
              logger.info({ userName, rt }, "[MED] Skipping push — medications already taken today");
            }
            // Mark as sent regardless of taken status — prevents re-firing if server restarts
            await logMedicationReminderSent(userName, "initial").catch((err: unknown) => {
              logger.warn({ err, userName }, "[MED] logMedicationReminderSent failed");
            });
          }
        }

        // ── 10-minute follow-up check ────────────────────────────────────────
        // If initial reminder was sent 10+ min ago and meds still not taken,
        // fire a gentle follow-up push once per day.
        const initialSentAt = await getInitialReminderSentAt(userName).catch(() => null);
        if (initialSentAt) {
          const minutesSinceSent = (Date.now() - initialSentAt.getTime()) / 60000;
          if (minutesSinceSent >= 10) {
            const followupAlreadySent = await hasMedicationReminderSentToday(userName, "followup").catch(() => true);
            if (!followupAlreadySent) {
              const stillNotTaken = !(await hasTakenMedicationsToday(userName).catch(() => true));
              if (stillNotTaken) {
                const medText = buildMedReminderText(meds);
                sendPushToAll({
                  title: `💊 Gentle Reminder — ${companion}`,
                  body: `Just checking — have you taken your ${medText}?`,
                  tag: "medication-followup",
                  notificationType: "medication",
                  categoryId: "medication-reminder",
                  requireInteraction: false,
                }, userName).catch((err: unknown) => {
                  logger.warn({ err, userName }, "[MED] Follow-up push delivery failed");
                });
                logger.info({ userName }, "[MED] 10-min follow-up fired");
              }
              await logMedicationReminderSent(userName, "followup").catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Medication scheduler error");
    }
  });

  logger.info("Medication scheduler started");
}
