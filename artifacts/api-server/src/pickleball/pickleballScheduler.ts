import cron from "node-cron";
import { query } from "../db.js";
import { broadcastToUser } from "../reminders/sseStore.js";
import { logger } from "../lib/logger.js";
import {
  isTodayPickleballDay,
  getTodaySession,
} from "./pickleballManager.js";

const TZ = "America/Chicago";

function localTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── DB-backed deduplication ────────────────────────────────────────────────────
// Survives server restarts — the in-memory flag was causing repeated check-ins
// whenever the server restarted after 11am on a pickleball day.

export async function ensureProactiveMessageLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS proactive_message_log (
      id         SERIAL PRIMARY KEY,
      user_name  TEXT NOT NULL,
      message_type TEXT NOT NULL,
      sent_date  DATE NOT NULL,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_name, message_type, sent_date)
    )
  `);
}

async function wasAlreadySentToday(userName: string, messageType: string): Promise<boolean> {
  const today = localDateStr();
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM proactive_message_log
      WHERE user_name = $1 AND message_type = $2 AND sent_date = $3
      LIMIT 1`,
    [userName, messageType, today]
  );
  return rows.length > 0;
}

async function recordSent(userName: string, messageType: string): Promise<void> {
  const today = localDateStr();
  await query(
    `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_name, message_type, sent_date) DO NOTHING`,
    [userName, messageType, today]
  );
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startPickleballScheduler(): void {
  cron.schedule("* * * * *", async () => {
    try {
      if (!isTodayPickleballDay()) return;

      // Fire at 11:00am on pickleball days — after the typical session ends
      if (localTime() !== "11:00") return;

      // Only ask if we haven't already logged a session today
      const session = await getTodaySession();
      if (session) return;

      // DB-backed guard — prevents re-firing on server restart or scheduler hiccup
      const alreadySent = await wasAlreadySentToday("David", "pickleball_checkin");
      if (alreadySent) {
        logger.info("Pickleball check-in: already sent today — skipping");
        return;
      }

      const message = "How was pickleball this morning, David? Did you win?";

      // Record first — if the broadcast fails we still won't double-send
      await recordSent("David", "pickleball_checkin");

      broadcastToUser("David", "reminder", {
        id: `pickleball-checkin-${Date.now()}`,
        userName: "David",
        reminderText: message,
        speakText: message,
        isPickleball: true,
      });

      logger.info("Pickleball post-session check-in fired");
    } catch (err) {
      logger.error({ err }, "Pickleball scheduler error");
    }
  });

  logger.info("Pickleball scheduler started");
}
