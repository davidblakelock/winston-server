import cron from "node-cron";
import { broadcast } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile } from "../onboarding/onboardingManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation } from "./departureManager.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

async function getCompanionName(): Promise<string> {
  const profile = await getProfile("David").catch(() => null);
  return profile?.companionName ?? "Emma Peel";
}

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function ensureCalendarSyncTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS calendar_sync_state (
      event_date  DATE    NOT NULL,
      event_id    TEXT    NOT NULL,
      event_summary TEXT,
      alert_sent  BOOLEAN NOT NULL DEFAULT FALSE,
      seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_date, event_id)
    )
  `);
}

async function getKnownEventIds(dateStr: string): Promise<Set<string>> {
  try {
    const { rows } = await query<{ event_id: string }>(
      `SELECT event_id FROM calendar_sync_state WHERE event_date = $1`,
      [dateStr]
    );
    return new Set(rows.map((r) => r.event_id));
  } catch {
    return new Set();
  }
}

async function markEventKnown(
  dateStr: string,
  eventId: string,
  summary: string,
  alertSent: boolean
): Promise<void> {
  try {
    await query(
      `INSERT INTO calendar_sync_state (event_date, event_id, event_summary, alert_sent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_date, event_id) DO NOTHING`,
      [dateStr, eventId, summary, alertSent]
    );
  } catch {}
}

// ── Departure time helper ──────────────────────────────────────────────────────

async function getLeaveByTime(
  event: CalendarEvent
): Promise<{ leaveTimeStr: string; driveMinutes: number; source: string } | null> {
  if (!event.startIso || event.allDay) return null;

  const location = extractEventLocation({
    summary: event.summary,
    location: event.location,
    description: event.description,
  });
  if (!location) return null;

  const drive = await estimateDriveTime(location).catch(() => null);
  if (!drive) return null;

  const eventStart = new Date(event.startIso);
  const BUFFER_MINUTES = 10;
  const leaveAtMs = eventStart.getTime() - (drive.durationMinutes + BUFFER_MINUTES) * 60000;
  const leaveAt = new Date(leaveAtMs);

  const leaveTimeStr = leaveAt.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return {
    leaveTimeStr,
    driveMinutes: drive.durationMinutes,
    source: drive.source,
  };
}

// ── Proactive new-event message ────────────────────────────────────────────────

async function sendNewEventAlert(event: CalendarEvent): Promise<void> {
  const companionName = await getCompanionName();
  const eventTimeStr = event.start || "today";
  const eventName = event.summary;

  let speakText: string;
  let pushBody: string;

  const departure = await getLeaveByTime(event).catch(() => null);

  if (departure) {
    speakText = `Hey David, looks like you just added ${eventName} at ${eventTimeStr}. Based on traffic from home, you'd want to leave around ${departure.leaveTimeStr} — about ${Math.round(departure.driveMinutes)} minutes. I'll remind you when it's time.`;
    pushBody = `${eventName} at ${eventTimeStr} added. Leave home by ${departure.leaveTimeStr} (~${Math.round(departure.driveMinutes)} min drive).`;
  } else {
    speakText = `Hey David, I noticed you just added ${eventName} at ${eventTimeStr} to your calendar. Thought you'd want a heads up.`;
    pushBody = `${eventName} at ${eventTimeStr} added to your calendar.`;
  }

  broadcast("reminder", {
    id: `new-event-${event.id}-${Date.now()}`,
    userName: "David",
    reminderText: speakText,
    speakText,
    isCalendarAlert: true,
  });

  await sendPushToAll({
    title: `📅 New Event — ${companionName}`,
    body: pushBody,
    tag: `new-event-${event.id}`,
    requireInteraction: false,
  }).catch(() => {});

  logger.info({ event: eventName, time: eventTimeStr }, "Calendar sync: new event alert sent");
}

// ── Throttle: track last successful sync time (module-level) ──────────────────
let lastSyncAt: number | null = null;

// ── Main sync check ────────────────────────────────────────────────────────────

async function runCalendarSync(): Promise<void> {
  const now = Date.now();
  if (lastSyncAt !== null && now - lastSyncAt < 55 * 60 * 1000) {
    logger.info(
      { minsAgo: Math.floor((now - lastSyncAt) / 60_000) },
      "Calendar sync: skipped — last sync was less than 55 minutes ago"
    );
    return;
  }
  lastSyncAt = now;
  let events: CalendarEvent[] | null;
  try {
    events = await fetchTodayEvents();
  } catch {
    return;
  }

  if (!events || events.length === 0) return;

  const today = localDateStr();
  const knownIds = await getKnownEventIds(today);
  const isFirstSyncToday = knownIds.size === 0;

  for (const event of events) {
    if (!event.id) continue;

    if (knownIds.has(event.id)) continue;

    if (isFirstSyncToday) {
      // First sync of the day — record all current events silently (no alert)
      // These were either in the morning briefing or existed before we started monitoring
      await markEventKnown(today, event.id, event.summary, true);
      logger.info({ event: event.summary }, "Calendar sync: initial population (no alert)");
    } else {
      // Subsequent sync — this is a genuinely new event added today
      await markEventKnown(today, event.id, event.summary, true);
      await sendNewEventAlert(event);
    }
  }

  if (!isFirstSyncToday) {
    logger.info(
      { eventCount: events.length, newEvents: events.filter((e) => !knownIds.has(e.id)).length },
      "Calendar sync: check complete"
    );
  }
}

// ── Public function for briefing to pre-populate ───────────────────────────────
// Called by briefingPregenerate so events in the morning briefing are never
// treated as "new" by the 30-minute sync scheduler.

export async function populateCalendarSyncState(events: CalendarEvent[]): Promise<void> {
  const today = localDateStr();
  for (const event of events) {
    if (event.id) {
      await markEventKnown(today, event.id, event.summary, true);
    }
  }
  logger.info({ count: events.length }, "Calendar sync state: pre-populated from morning briefing");
}

// ── Scheduler: every 60 minutes, 8am–9pm CT ───────────────────────────────────

export function startCalendarSyncScheduler(): void {
  cron.schedule(
    "0 8-21 * * *",
    async () => {
      try {
        await runCalendarSync();
      } catch (err) {
        logger.error({ err }, "Calendar sync scheduler error");
      }
    },
    { timezone: TZ }
  );

  logger.info("Calendar sync scheduler started");
}
