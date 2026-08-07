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

function getCurrentLocalTime(timezone: string): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── Reminder-time cache ─────────────────────────────────────────────────────
// getMedicationRemindersEnabled()+getMedications() used to run fresh on every
// single per-minute tick for every user, regardless of whether any reminder
// time was anywhere close to firing — a full DB round-trip pair 1,440
// times/day/user for no benefit. Caching just the derived {enabled, times}
// set (not full medication rows) and refreshing it lazily every 15 min
// collapses that to ~96 refreshes/day/user. The outer cron tick and firing
// precision are unchanged — these cheap in-memory checks only skip the DB
// fetch; the exact dedup/ack/send logic below still runs unchanged once a
// time is actually in-window. No invalidation hook on medication edits —
// worst case is up to 15 min of staleness, acceptable for now.
interface ReminderTimesCacheEntry {
  remindersEnabled: boolean;
  uniqueTimes: string[];
  refreshedAt: number;
}
const _reminderTimesCache = new Map<string, ReminderTimesCacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000;

async function getReminderTimes(userName: string): Promise<ReminderTimesCacheEntry> {
  const cached = _reminderTimesCache.get(userName);
  if (cached && Date.now() - cached.refreshedAt < CACHE_TTL_MS) {
    return cached;
  }

  const remindersEnabled = await getMedicationRemindersEnabled(userName).catch(() => true);
  const meds = remindersEnabled
    ? await getMedications(userName).catch((): Awaited<ReturnType<typeof getMedications>> => [])
    : [];

  // Per-medication toggle: a medication with remindersEnabled === false never
  // contributes its times to the fire set below. This does NOT suppress a time
  // slot that another (enabled) medication legitimately shares — e.g. if med A
  // (enabled) and med B (disabled) both use 08:00, 08:00 still fires for med A.
  const remindersOnMeds = meds.filter((m) => m.remindersEnabled !== false);

  // Flatten reminderTimes arrays across meds with reminders enabled, deduplicated by unique time value.
  const uniqueTimes = [
    ...new Set(remindersOnMeds.flatMap((m) => m.reminderTimes ?? [m.reminderTime])),
  ];

  const entry: ReminderTimesCacheEntry = { remindersEnabled, uniqueTimes, refreshedAt: Date.now() };
  _reminderTimesCache.set(userName, entry);
  return entry;
}

// True if `time` (HH:MM) is currently within its 2-hour firing window.
// Don't fire more than 2 hours after the scheduled time — prevents a late
// server start (e.g. 7 PM deploy) from sending the 7 AM slot.
function isTimeInWindow(time: string, localTime: string): boolean {
  if (localTime < time) return false;
  const [schedH, schedM] = time.split(":").map(Number);
  const [localH, localM] = localTime.split(":").map(Number);
  return localH * 60 + localM <= schedH * 60 + schedM + 120;
}

export function startMedicationScheduler(): void {
  let _running = false;
  cron.schedule("10 * * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      clearTakenLogIfNewDay();
      const users = await getActiveUsers().catch(() => []);
      if (!users.length) return;

      for (const user of users) {
        const { userName } = user;
        const localTime = getCurrentLocalTime(user.timezone ?? "UTC");

        const { remindersEnabled, uniqueTimes } = await getReminderTimes(userName);
        if (!remindersEnabled || !uniqueTimes.length) continue;

        // Cheap in-memory gate — skip all DB work this tick unless a time is
        // actually in-window for this user.
        const timesInWindow = uniqueTimes.filter((time) => isTimeInWindow(time, localTime));
        if (!timesInWindow.length) continue;

        for (const time of timesInWindow) {
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

          await logMedicationReminderSent(userName, reminderKey).catch((err: unknown) => {
            logger.warn({ err, userName, time }, "[MED] logMedicationReminderSent failed");
          });

          await sendFcmNotification({
            userName,
            notificationType: "medication",
            title: "Time for your medications 💊",
            body: "Have you taken your medications?",
            data: { reminderTime: time },
          }).catch((err: unknown) => {
            logger.error({ err, userName, time }, "[MED] FCM push delivery failed");
          });
          // minutesLate makes a late fire (within the 2h catch-up window
          // above) immediately diagnosable from logs alone — previously a
          // reminder firing well past its scheduled time looked identical
          // in the logs to one firing right on time, with no way to tell
          // after the fact whether the scheduler tick itself was delayed.
          const [schedH, schedM] = time.split(":").map(Number);
          const [localH, localM] = localTime.split(":").map(Number);
          const minutesLate = (localH * 60 + localM) - (schedH * 60 + schedM);
          logger.info({ time, userName, localTime, minutesLate }, "[MED] Reminder fired");
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
