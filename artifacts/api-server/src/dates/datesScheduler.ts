import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import {
  getDates,
  nextOccurrence,
  buildDateReminderMessage,
  type ImportantDate,
  type UpcomingDate,
} from "./datesManager.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

const LEAD_DAYS = [14, 7, 3, 0]; // reminder thresholds in days before event

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function localTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function daysBetween(a: Date, b: Date): number {
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bDay.getTime() - aDay.getTime()) / 86400000);
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

let _lastChecked: string | null = null;

async function checkDateReminders(): Promise<void> {
  const today = localDateStr();
  if (_lastChecked === today) return;
  _lastChecked = today;

  const dates = await getDates("David");
  const now = new Date();

  for (const d of dates) {
    const occ = nextOccurrence(d.month, d.day, now);
    const daysUntil = daysBetween(now, occ);

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

    const message = buildDateReminderMessage(upcoming);

    broadcast("reminder", {
      id: `date-${d.id}-${daysUntil}-${Date.now()}`,
      userName: "David",
      reminderText: message,
      speakText: message,
      isDateReminder: true,
    });

    await sendPushToAll({
      title: `${d.eventType === "birthday" ? "🎂" : "💍"} Important Date — Emma Peel`,
      body: message,
      tag: `date-${d.id}-${daysUntil}`,

      requireInteraction: daysUntil <= 3,
    }).catch(() => {});

    await markReminderSent(d.id, daysUntil, today);

    logger.info({ dateId: d.id, personName: d.personName, daysUntil }, "Date reminder fired");
  }
}

export async function startDatesScheduler(): Promise<void> {
  await ensureLogTable();

  cron.schedule("* * * * *", async () => {
    try {
      if (localTime() !== "09:00") return;
      await checkDateReminders();
    } catch (err) {
      logger.error({ err }, "Dates scheduler error");
    }
  });

  logger.info("Dates (birthday/anniversary) scheduler started");
}
