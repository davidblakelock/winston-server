import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";
import {
  getDates,
  nextOccurrence,
  buildDateReminderMessage,
  type ImportantDate,
  type UpcomingDate,
} from "./datesManager.js";
import { query } from "../db.js";

const LEAD_DAYS = [7, 2, 0]; // reminder thresholds in days before event

function localDateStr(tz = "UTC"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function daysBetween(a: Date, b: Date, tz = "UTC"): number {
  const aStr = a.toLocaleDateString("en-CA", { timeZone: tz });
  const bStr = b.toLocaleDateString("en-CA", { timeZone: tz });
  const [aY, aM, aD] = aStr.split("-").map(Number);
  const [bY, bM, bD] = bStr.split("-").map(Number);
  return Math.round((Date.UTC(bY, bM - 1, bD) - Date.UTC(aY, aM - 1, aD)) / 86400000);
}

async function hasReminderBeenSent(dateId: number, daysUntil: number, today: string): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM date_reminder_log
     WHERE date_id = $1 AND days_until = $2 AND reminded_date = $3`,
    [dateId, daysUntil, today]
  );
  return parseInt(rows[0]?.count ?? "0", 10) > 0;
}

async function markReminderSent(dateId: number, daysUntil: number, today: string): Promise<void> {
  await query(
    `INSERT INTO date_reminder_log (date_id, days_until, reminded_date)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [dateId, daysUntil, today]
  ).catch(() => {});
}

async function ensureLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS date_reminder_log (
      id SERIAL PRIMARY KEY,
      date_id INTEGER NOT NULL,
      days_until INTEGER NOT NULL,
      reminded_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(date_id, days_until, reminded_date)
    )
  `);
}

const TARGET_LOCAL_HOUR = 9;
// userName -> local date (in that user's own timezone) already checked
const _checkedToday = new Map<string, string>();

async function checkDatesForUser(user: ActiveUser, userTz: string): Promise<void> {
  const { userName, name: displayName, companionName } = user;
  const today = localDateStr(userTz);
  const userDisplay = displayName ?? userName;
  const companion = companionName ?? "Winston";
  const now = new Date();

  const dates = await getDates(userName).catch(() => [] as ImportantDate[]);

  for (const d of dates) {
    const occ = nextOccurrence(d.month, d.day, now, userTz);
    const daysUntil = daysBetween(now, occ, userTz);

    if (!LEAD_DAYS.includes(daysUntil)) continue;

    const alreadySent = await hasReminderBeenSent(d.id, daysUntil, today);
    if (alreadySent) continue;

    const upcoming: UpcomingDate = {
      ...d,
      nextOccurrence: occ,
      daysUntil,
      yearsCount: null,
      label: occ.toLocaleDateString("en-US", { month: "long", day: "numeric" }),
    };

    const message = buildDateReminderMessage(upcoming, userDisplay);

    // Build a personalized autoSendMessage so tapping the notification opens
    // the app and Winston immediately responds with planning/message help.
    const name = d.personName;
    const isBirthday = d.eventType === "birthday";
    let autoSendMessage: string;
    if (daysUntil === 7) {
      autoSendMessage = isBirthday
        ? `${name}'s birthday is in 7 days — can you help me plan something?`
        : `My anniversary with ${name} is in 7 days — can you help me plan something special?`;
    } else if (daysUntil === 2) {
      autoSendMessage = isBirthday
        ? `${name}'s birthday is in 2 days — have I done anything about it yet?`
        : `My anniversary with ${name} is in 2 days — have I done anything about it yet?`;
    } else {
      // daysUntil === 0 — day of
      autoSendMessage = isBirthday
        ? `Today is ${name}'s birthday — help me send them a birthday message.`
        : `Today is my anniversary with ${name} — help me make it a special day.`;
    }

    broadcast("reminder", {
      id: `date-${d.id}-${daysUntil}-${Date.now()}`,
      userName,
      reminderText: message,
      speakText: message,
      isDateReminder: true,
    });

    await sendFcmNotification({
      userName,
      notificationType: 'date-reminder',
      title: `${isBirthday ? '🎂' : '💍'} Important Date — ${companion}`,
      body: message,
      data: {
        tag: `date-${d.id}-${daysUntil}`,
        requireInteraction: String(daysUntil <= 3),
        action: 'send_message',
        message: autoSendMessage,
      },
    }).catch(() => {});

    await markReminderSent(d.id, daysUntil, today);

    logger.info({ dateId: d.id, personName: d.personName, daysUntil, userName }, "Date reminder fired");
  }
}

async function runPerUserCheck(user: ActiveUser): Promise<void> {
  const tz = user.timezone ?? "UTC";
  const now = new Date();
  const localHour = parseInt(
    now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
    10
  );
  if (localHour < TARGET_LOCAL_HOUR) return;

  const today = now.toLocaleDateString("en-CA", { timeZone: tz });
  if (_checkedToday.get(user.userName) === today) return;
  _checkedToday.set(user.userName, today);

  await checkDatesForUser(user, tz).catch((err) => {
    logger.error({ err, userName: user.userName }, "Dates scheduler — per-user check failed");
  });
}

export async function startDatesScheduler(): Promise<void> {
  await ensureLogTable().catch((err: unknown) => {
    logger.warn({ err }, "Dates scheduler — ensureLogTable failed on startup, will retry next run");
  });

  let _running = false;
  cron.schedule("*/5 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers().catch(() => []);
      await Promise.allSettled(users.map((user) => runPerUserCheck(user)));
    } catch (err) {
      logger.error({ err }, "Dates scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Dates (birthday/anniversary) scheduler started — checks every 5 min, fires once per user at their local 9am");
}
