import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../google/calendar.js";
import { GoogleInvalidGrantError, clearGoogleTokensForUser } from "../google/oauth.js";
import { estimateDriveTime, extractEventLocation, computeLeaveAt } from "./departureManager.js";
import { query } from "../db.js";

// Rate-limit the "Google disconnected" push to once per user per server lifecycle.
const _invalidGrantNotifiedUsers = new Set<string>();

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

  await query(`
    ALTER TABLE calendar_sync_state
    ADD COLUMN IF NOT EXISTS user_name TEXT NOT NULL DEFAULT 'davidblakelock'
  `).catch(() => {});

  // Track the stored start time so we can detect when an event is moved
  await query(`
    ALTER TABLE calendar_sync_state
    ADD COLUMN IF NOT EXISTS event_start_iso TEXT
  `).catch(() => {});

  logger.info("calendar_sync_state table ready");
}

interface KnownEvent {
  startIso: string | null;
}

/**
 * Returns a map of { event_id → { startIso } } for today's known events.
 * Returns null on DB error so callers skip the sync cycle rather than
 * treating a query failure as "first sync of the day".
 */
async function getKnownEvents(
  dateStr: string,
  userName: string
): Promise<Map<string, KnownEvent> | null> {
  try {
    const { rows } = await query<{ event_id: string; event_start_iso: string | null }>(
      `SELECT event_id, event_start_iso
       FROM calendar_sync_state
       WHERE event_date = $1 AND user_name = $2`,
      [dateStr, userName]
    );
    return new Map(rows.map((r) => [r.event_id, { startIso: r.event_start_iso ?? null }]));
  } catch (err) {
    logger.warn({ err, dateStr, userName }, "Calendar sync: getKnownEvents query failed — skipping sync");
    return null;
  }
}

/**
 * Upsert a row so the stored start_iso stays current.
 * Uses RETURNING so db.ts routes it through exec_dml_ret (supports DML).
 */
async function markEventKnown(
  dateStr: string,
  eventId: string,
  summary: string,
  alertSent: boolean,
  userName: string,
  startIso?: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO calendar_sync_state
         (event_date, event_id, event_summary, alert_sent, user_name, event_start_iso)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_date, event_id) DO UPDATE
         SET event_summary   = EXCLUDED.event_summary,
             event_start_iso = EXCLUDED.event_start_iso,
             seen_at         = NOW()
       RETURNING event_id`,
      [dateStr, eventId, summary, alertSent, userName, startIso ?? null]
    );
  } catch (err) {
    logger.warn({ err, dateStr, eventId, userName }, "Calendar sync: markEventKnown failed");
  }
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

// ── Moved-event alert ──────────────────────────────────────────────────────────

async function sendMovedEventAlert(
  event: CalendarEvent,
  oldStartIso: string,
  userName: string
): Promise<void> {
  const companionName = await getCompanionName(userName);
  const eventName = event.summary;
  const newTimeStr = event.start || "a new time";
  const oldTimeStr = new Date(oldStartIso).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  let speakText: string;
  let pushBody: string;

  const departure = await getLeaveByTime(event, userName).catch(() => null);

  if (departure) {
    speakText = `Hey, looks like ${eventName} was moved to ${newTimeStr}. Based on traffic, you'd want to leave home by ${departure.leaveTimeStr} — about ${Math.round(departure.driveMinutes)} minutes.`;
    pushBody = `${eventName} moved to ${newTimeStr} (was ${oldTimeStr}). Leave by ${departure.leaveTimeStr} (~${Math.round(departure.driveMinutes)} min).`;
  } else {
    speakText = `Hey, heads up — ${eventName} was moved from ${oldTimeStr} to ${newTimeStr}.`;
    pushBody = `${eventName} moved to ${newTimeStr} (was ${oldTimeStr}).`;
  }

  broadcastToUser(userName, "reminder", {
    id: `moved-event-${event.id}-${Date.now()}`,
    userName,
    reminderText: speakText,
    speakText,
    isCalendarAlert: true,
    eventId: event.id,
    eventSummary: eventName,
  });

  await sendPushToAll({
    title: `📅 Event Moved — ${companionName}`,
    body: pushBody,
    tag: `moved-event-${event.id}`,
    requireInteraction: false,
  }, userName).catch(() => {});

  logger.info(
    { event: eventName, oldTime: oldTimeStr, newTime: newTimeStr, userName },
    "Calendar sync: moved event alert sent"
  );
}

// ── Main sync check ────────────────────────────────────────────────────────────

async function runCalendarSyncForUser(userName: string): Promise<void> {
  let events: CalendarEvent[] | null;
  try {
    events = await fetchTodayEvents(userName);
  } catch (err) {
    if (err instanceof GoogleInvalidGrantError) {
      logger.warn({ userName }, "Calendar sync: Google token revoked (invalid_grant) — clearing credentials");
      // Clear stale tokens so UI immediately shows "Not connected" on next status check
      await clearGoogleTokensForUser(userName).catch(() => {});
      // Push-notify once per server restart so the user knows to reconnect
      if (!_invalidGrantNotifiedUsers.has(userName)) {
        _invalidGrantNotifiedUsers.add(userName);
        const companionName = await getCompanionName(userName);
        await sendPushToAll({
          tag: "google-reconnect",
          title: `${companionName} — Google Reconnect Needed`,
          body: "Your Google connection expired. Open the app and reconnect Gmail & Calendar.",
        }, userName).catch(() => {});
        logger.info({ userName }, "Calendar sync: sent 'reconnect Google' push notification");
      }
      return;
    }
    logger.warn({ err, userName }, "Calendar sync: fetchTodayEvents threw — skipping cycle");
    return;
  }

  if (!events || events.length === 0) {
    logger.info({ userName, eventsNull: events === null }, "Calendar sync: no future events — cycle complete");
    return;
  }

  const today = localDateStr();
  const knownEvents = await getKnownEvents(today, userName);

  if (knownEvents === null) return;

  const isFirstSyncToday = knownEvents.size === 0;
  let newCount = 0;
  let movedCount = 0;

  for (const event of events) {
    if (!event.id) continue;

    const known = knownEvents.get(event.id);

    if (!known) {
      // New event — silently populate on first sync, alert on subsequent
      await markEventKnown(today, event.id, event.summary, !isFirstSyncToday, userName, event.startIso);
      if (isFirstSyncToday) {
        logger.info({ event: event.summary, startIso: event.startIso, userName }, "Calendar sync: initial population (no alert)");
      } else {
        newCount++;
        await sendNewEventAlert(event, userName);
      }
    } else if (
      !isFirstSyncToday &&
      event.startIso &&
      known.startIso &&
      known.startIso !== event.startIso
    ) {
      // Same event ID but start time changed — event was moved
      movedCount++;
      await markEventKnown(today, event.id, event.summary, true, userName, event.startIso);
      await sendMovedEventAlert(event, known.startIso, userName);
    } else if (!known.startIso && event.startIso) {
      // We have an existing row but no start_iso stored yet — backfill it silently
      await markEventKnown(today, event.id, event.summary, true, userName, event.startIso);
    }
  }

  logger.info(
    {
      eventCount: events.length,
      knownCount: knownEvents.size,
      newEvents: newCount,
      movedEvents: movedCount,
      isFirstSyncToday,
      userName,
    },
    "Calendar sync: check complete"
  );
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
      await markEventKnown(today, event.id, event.summary, true, userName, event.startIso);
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
