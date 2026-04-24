import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../google/calendar.js";
import { estimateDriveTime, extractEventLocation, computeLeaveAt } from "./departureManager.js";
import { query } from "../db.js";

const TZ = "America/Chicago";

async function getCompanionName(userName: string): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  return profile?.companionName ?? "Your Companion";
}

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function ensureCalendarSyncTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS calendar_sync_state (
      event_date    DATE    NOT NULL,
      event_id      TEXT    NOT NULL,
      event_summary TEXT,
      alert_sent    BOOLEAN NOT NULL DEFAULT FALSE,
      seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_date, event_id)
    )
  `);

  // Migration: add user_name column for per-user isolation
  await query(`
    ALTER TABLE calendar_sync_state
    ADD COLUMN IF NOT EXISTS user_name TEXT NOT NULL DEFAULT 'davidblakelock'
  `).catch(() => {});

  logger.info("calendar_sync_state table ready");
}

/**
 * Returns the set of known event IDs for a given user + date.
 * Returns null on a DB error (so callers can skip the sync rather than
 * treating a query failure as "first sync of the day").
 */
async function getKnownEventIds(dateStr: string, userName: string): Promise<Set<string> | null> {
  try {
    const { rows } = await query<{ event_id: string }>(
      `SELECT event_id FROM calendar_sync_state WHERE event_date = $1 AND user_name = $2`,
      [dateStr, userName]
    );
    return new Set(rows.map((r) => r.event_id));
  } catch (err) {
    logger.warn({ err, dateStr, userName }, "Calendar sync: getKnownEventIds query failed — skipping sync");
    return null;
  }
}

async function markEventKnown(
  dateStr: string,
  eventId: string,
  summary: string,
  alertSent: boolean,
  userName: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO calendar_sync_state (event_date, event_id, event_summary, alert_sent, user_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_date, event_id) DO NOTHING`,
      [dateStr, eventId, summary, alertSent, userName]
    );
  } catch {}
}

// ── Departure time helper ──────────────────────────────────────────────────────

async function getLeaveByTime(
  event: CalendarEvent,
  userName: string
): Promise<{ leaveTimeStr: string; driveMinutes: number; source: string } | null> {
  if (!event.startIso || event.allDay) return null;

  const location = extractEventLocation({
    summary: event.summary,
    location: event.location,
    description: event.description,
  });
  if (!location) return null;

  const profile = await getProfile(userName).catch(() => null);
  const homeAddress =
    profile?.homeAddress ??
    ((profile?.rawData as CollectedData)?.homeAddress) ?? "";
  const homeLat = profile?.latitude ?? 0;
  const homeLon = profile?.longitude ?? 0;

  const drive = await estimateDriveTime(location, homeAddress, homeLat, homeLon).catch(() => null);
  if (!drive) return null;

  const eventStart = new Date(event.startIso);
  const leaveAt = computeLeaveAt(eventStart, drive.durationMinutes);

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

async function sendNewEventAlert(event: CalendarEvent, userName: string): Promise<void> {
  const companionName = await getCompanionName(userName);
  const eventTimeStr = event.start || "today";
  const eventName = event.summary;

  let speakText: string;
  let pushBody: string;

  const departure = await getLeaveByTime(event, userName).catch(() => null);
  const hasLocation = !!(event.location || event.description);

  if (departure) {
    speakText = `Hey, looks like you just added ${eventName} at ${eventTimeStr}. Based on traffic from home, you'd want to leave around ${departure.leaveTimeStr} — about ${Math.round(departure.driveMinutes)} minutes. I'll remind you when it's time.`;
    pushBody = `${eventName} at ${eventTimeStr} added. Leave home by ${departure.leaveTimeStr} (~${Math.round(departure.driveMinutes)} min drive).`;
  } else if (!hasLocation) {
    speakText = `Hey, I noticed you just added ${eventName} at ${eventTimeStr} to your calendar. It doesn't have an address — do you want to add one so I can give you departure reminders?`;
    pushBody = `${eventName} at ${eventTimeStr} added. No address on file — tap to add one for departure reminders.`;
  } else {
    speakText = `Hey, I noticed you just added ${eventName} at ${eventTimeStr} to your calendar. Thought you'd want a heads up.`;
    pushBody = `${eventName} at ${eventTimeStr} added to your calendar.`;
  }

  broadcastToUser(userName, "reminder", {
    id: `new-event-${event.id}-${Date.now()}`,
    userName,
    reminderText: speakText,
    speakText,
    isCalendarAlert: true,
    askForAddress: !hasLocation && !departure,
    eventId: event.id,
    eventSummary: eventName,
  });

  await sendPushToAll({
    title: `📅 New Event — ${companionName}`,
    body: pushBody,
    tag: `new-event-${event.id}`,
    requireInteraction: false,
  }, userName).catch(() => {});

  logger.info(
    { event: eventName, time: eventTimeStr, hasLocation, userName },
    "Calendar sync: new event alert sent"
  );
}

// ── Main sync check ────────────────────────────────────────────────────────────

async function runCalendarSyncForUser(userName: string): Promise<void> {
  let events: CalendarEvent[] | null;
  try {
    events = await fetchTodayEvents(userName);
  } catch {
    return;
  }

  if (!events || events.length === 0) return;

  const today = localDateStr();
  const knownIds = await getKnownEventIds(today, userName);

  // If the DB query failed, skip this cycle entirely rather than
  // misinterpreting a query error as "first sync of the day".
  if (knownIds === null) return;

  const isFirstSyncToday = knownIds.size === 0;

  for (const event of events) {
    if (!event.id) continue;
    if (knownIds.has(event.id)) continue;

    if (isFirstSyncToday) {
      await markEventKnown(today, event.id, event.summary, true, userName);
      logger.info({ event: event.summary, userName }, "Calendar sync: initial population (no alert)");
    } else {
      await markEventKnown(today, event.id, event.summary, true, userName);
      await sendNewEventAlert(event, userName);
    }
  }

  if (!isFirstSyncToday) {
    logger.info(
      {
        eventCount: events.length,
        newEvents: events.filter((e) => !knownIds.has(e.id)).length,
        userName,
      },
      "Calendar sync: check complete"
    );
  }
}

async function runCalendarSync(): Promise<void> {
  try {
    const users = await getActiveUsers();
    if (users.length === 0) return;
    await Promise.allSettled(users.map((u) => runCalendarSyncForUser(u.userName)));
  } catch (err) {
    logger.warn({ err }, "Calendar sync: failed to load active users");
  }
}

// ── Public function for briefing to pre-populate ───────────────────────────────
// Called by briefingPregenerate so events in the morning briefing are never
// treated as "new" by the sync scheduler.

export async function populateCalendarSyncState(
  events: CalendarEvent[],
  userName: string
): Promise<void> {
  const today = localDateStr();
  for (const event of events) {
    if (event.id) {
      await markEventKnown(today, event.id, event.summary, true, userName);
    }
  }
  logger.info({ count: events.length, userName }, "Calendar sync state: pre-populated from morning briefing");
}

// ── Scheduler: every 5 minutes, 7am–10pm CT ───────────────────────────────────

export function startCalendarSyncScheduler(): void {
  cron.schedule(
    "*/5 7-22 * * *",
    async () => {
      try {
        await runCalendarSync();
      } catch (err) {
        logger.error({ err }, "Calendar sync scheduler error");
      }
    },
    { timezone: TZ }
  );

  logger.info("Calendar sync scheduler (every 5 min, 7am–10pm CT) started");
}
