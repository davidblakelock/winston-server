import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
import { fetchTodayEvents, type CalendarEvent } from "../google/calendar.js";
import { GoogleInvalidGrantError, clearGoogleTokensForUser } from "../google/oauth.js";
import { estimateDriveTime, extractEventLocation, computeLeaveAt } from "./departureManager.js";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import { searchContacts } from "../google/contacts.js";
import { setPendingDepartureTextOffer } from "../text/textMessageComposer.js";

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
  // Include all known columns so new installations start fully-migrated.
  await query(`
    CREATE TABLE IF NOT EXISTS calendar_sync_state (
      event_date         DATE        NOT NULL,
      event_id           TEXT        NOT NULL,
      event_summary      TEXT,
      alert_sent         BOOLEAN     NOT NULL DEFAULT FALSE,
      seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_name          TEXT        NOT NULL DEFAULT '${NATIVE_STORED_NAME}',
      event_start_iso    TEXT,
      departure_notified BOOLEAN     NOT NULL DEFAULT FALSE,
      leave_time_iso     TEXT,
      event_location     TEXT,
      PRIMARY KEY (event_date, event_id)
    )
  `);

  // Backwards-compat ALTER TABLEs for existing installations — each is idempotent.
  // Errors are logged (not swallowed) so migration failures surface in the logs.
  const alters = [
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS user_name TEXT NOT NULL DEFAULT '${NATIVE_STORED_NAME}'`,
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS event_start_iso TEXT`,
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS departure_notified BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS leave_time_iso TEXT`,
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS event_location TEXT`,
    `ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS event_attendees TEXT`,
  ];
  for (const sql of alters) {
    await query(sql).catch((err: unknown) => {
      logger.warn({ err }, `[CalendarSync] Migration ALTER TABLE failed: ${sql.slice(0, 80)}`);
    });
  }

  logger.info("calendar_sync_state table ready");
}

interface KnownEvent {
  startIso: string | null;
  departureNotified: boolean;
  leaveTimeIso: string | null;
  eventLocation: string | null;
}

/**
 * Returns a map of { event_id → KnownEvent } for today's known events.
 * Returns null on DB error so callers skip the sync cycle rather than
 * treating a query failure as "first sync of the day".
 */
async function getKnownEvents(
  dateStr: string,
  userName: string
): Promise<Map<string, KnownEvent> | null> {
  try {
    const { rows } = await query<{
      event_id: string;
      event_start_iso: string | null;
      departure_notified: boolean;
      leave_time_iso: string | null;
      event_location: string | null;
    }>(
      `SELECT event_id, event_start_iso, departure_notified, leave_time_iso, event_location
       FROM calendar_sync_state
       WHERE event_date = $1 AND user_name = $2`,
      [dateStr, userName]
    );
    return new Map(rows.map((r) => [r.event_id, {
      startIso: r.event_start_iso ?? null,
      departureNotified: r.departure_notified ?? false,
      leaveTimeIso: r.leave_time_iso ?? null,
      eventLocation: r.event_location ?? null,
    }]));
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
  startIso?: string | null,
  eventLocation?: string | null,
  leaveTimeIso?: string | null,
  attendeesJson?: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO calendar_sync_state
         (event_date, event_id, event_summary, alert_sent, user_name, event_start_iso, event_location, leave_time_iso, event_attendees)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_date, event_id) DO UPDATE
         SET event_summary   = EXCLUDED.event_summary,
             event_start_iso = EXCLUDED.event_start_iso,
             event_location  = COALESCE(EXCLUDED.event_location, calendar_sync_state.event_location),
             leave_time_iso  = COALESCE(EXCLUDED.leave_time_iso, calendar_sync_state.leave_time_iso),
             event_attendees = COALESCE(EXCLUDED.event_attendees, calendar_sync_state.event_attendees),
             seen_at         = NOW()
       RETURNING event_id`,
      [dateStr, eventId, summary, alertSent, userName,
       startIso ?? null, eventLocation ?? null, leaveTimeIso ?? null, attendeesJson ?? null]
    );
  } catch (err) {
    logger.warn({ err, dateStr, eventId, userName }, "Calendar sync: markEventKnown failed");
  }
}

async function markDepartureNotified(
  dateStr: string,
  eventId: string,
  userName: string
): Promise<void> {
  try {
    await query(
      `UPDATE calendar_sync_state
          SET departure_notified = TRUE
        WHERE event_date = $1 AND event_id = $2 AND user_name = $3
        RETURNING event_id`,
      [dateStr, eventId, userName]
    );
  } catch (err) {
    logger.warn({ err, dateStr, eventId, userName }, "Calendar sync: markDepartureNotified failed");
  }
}

// ── Departure time helper ──────────────────────────────────────────────────────

async function getLeaveByTime(
  event: CalendarEvent,
  userName: string
): Promise<{ leaveTimeStr: string; leaveAtIso: string; driveMinutes: number; source: string; location: string } | null> {
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
    leaveAtIso: leaveAt.toISOString(),
    driveMinutes: drive.durationMinutes,
    source: drive.source,
    location,
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

  // Store departure info so the leave-time scheduler can fire a reminder
  if (event.id) {
    const today = localDateStr();
    const attendeesJson = (event.attendees && event.attendees.length > 0)
      ? JSON.stringify(event.attendees)
      : null;
    await markEventKnown(
      today, event.id, eventName, true, userName, event.startIso,
      departure?.location ?? null,
      departure?.leaveAtIso ?? null,
      attendeesJson
    );
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
    { event: eventName, time: eventTimeStr, hasLocation, departure: !!departure, userName },
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
// Also stores location and leave_time so the departure reminder scheduler can fire.

export async function populateCalendarSyncState(
  events: CalendarEvent[],
  userName: string
): Promise<void> {
  const today = localDateStr();
  for (const event of events) {
    if (!event.id) continue;

    const location = event.startIso && !event.allDay
      ? extractEventLocation({ summary: event.summary, location: event.location, description: event.description })
      : null;

    let leaveTimeIso: string | null = null;
    if (location && event.startIso) {
      const dep = await getLeaveByTime(event, userName).catch(() => null);
      leaveTimeIso = dep?.leaveAtIso ?? null;
    }

    const attendeesJson = (event.attendees && event.attendees.length > 0)
      ? JSON.stringify(event.attendees)
      : null;

    await markEventKnown(today, event.id, event.summary, true, userName, event.startIso, location, leaveTimeIso, attendeesJson);
  }
  logger.info({ count: events.length, userName }, "Calendar sync state: pre-populated from morning briefing");
}

// ── Departure-time alert (fires when it's time to leave) ──────────────────────

async function runDepartureAlertsForUser(userName: string): Promise<void> {
  const today = localDateStr();
  const now = new Date();
  const nowMs = now.getTime();

  let rows: { event_id: string; event_summary: string; event_location: string; leave_time_iso: string; event_attendees: string | null }[];
  try {
    const res = await query<{
      event_id: string;
      event_summary: string;
      event_location: string;
      leave_time_iso: string;
      event_attendees: string | null;
    }>(
      `SELECT event_id, event_summary, event_location, leave_time_iso, event_attendees
         FROM calendar_sync_state
        WHERE event_date = $1
          AND user_name = $2
          AND departure_notified = FALSE
          AND leave_time_iso IS NOT NULL
          AND event_location IS NOT NULL`,
      [today, userName]
    );
    rows = res.rows;
  } catch (err) {
    logger.warn({ err, userName }, "Departure alert: DB query failed");
    return;
  }

  for (const row of rows) {
    const leaveAtMs = new Date(row.leave_time_iso).getTime();
    const diffMs = nowMs - leaveAtMs;

    // Fire if we're within a 5-minute window starting at leave time
    if (diffMs < 0 || diffMs > 5 * 60 * 1000) continue;

    const companionName = await getCompanionName(userName);
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(row.event_location)}`;
    const leaveTimeStr = new Date(row.leave_time_iso).toLocaleTimeString("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
    });

    // ── Text offer: look up attendees and find one with a phone ───────────────
    let textOfferRecipient: { name: string; phone: string | null } | null = null;
    if (row.event_attendees) {
      try {
        const attendees = JSON.parse(row.event_attendees) as Array<{ name?: string; email?: string }>;
        for (const attendee of attendees) {
          if (!attendee.name) continue;
          const result = await searchContacts(attendee.name, userName).catch(() => null);
          const match = result?.contacts.find((c) => c.phone);
          if (match) {
            textOfferRecipient = { name: attendee.name, phone: match.phone ?? null };
            break;
          }
        }
      } catch {
        // attendees JSON parse failure — skip text offer
      }
    }

    // Build messages — with or without text offer
    const firstName = textOfferRecipient?.name.split(" ")[0] ?? null;
    const offerSuffix = firstName
      ? ` Want me to text ${firstName} you're on your way?`
      : "";

    const speakText = `Time to leave for ${row.event_summary} — leave by ${leaveTimeStr}.${offerSuffix}`;
    const pushBody = textOfferRecipient
      ? `Time to leave — ${leaveTimeStr}. Open Winston to text ${firstName} you're on your way.`
      : `Time to leave for ${row.event_summary} — ${leaveTimeStr}. Tap to open Maps.`;

    // Store offer state so the next chat message can pick it up
    if (textOfferRecipient) {
      setPendingDepartureTextOffer({
        recipientName: textOfferRecipient.name,
        recipientPhone: textOfferRecipient.phone,
        eventSummary: row.event_summary,
        userName,
        createdAt: Date.now(),
      });
    }

    await markDepartureNotified(today, row.event_id, userName);

    await sendPushToAll({
      title: `🗺️ Time to Leave — ${companionName}`,
      body: pushBody,
      tag: `departure-${row.event_id}`,
      requireInteraction: true,
      notificationType: "departure",
      companionMessage: JSON.stringify({ mapsUrl, eventSummary: row.event_summary }),
    }, userName).catch(() => {});

    broadcastToUser(userName, "reminder", {
      id: `departure-${row.event_id}-${Date.now()}`,
      userName,
      reminderText: speakText,
      speakText,
      isCalendarAlert: true,
      mapsUrl,
      ...(textOfferRecipient ? {
        offerText: true,
        textRecipientName: textOfferRecipient.name,
        textRecipientPhone: textOfferRecipient.phone,
      } : {}),
    });

    logger.info(
      { event: row.event_summary, leaveTime: leaveTimeStr, textOffer: !!textOfferRecipient, userName },
      "Departure alert: sent"
    );
  }
}

async function runDepartureAlerts(): Promise<void> {
  try {
    const users = await getActiveUsers();
    if (users.length === 0) return;
    await Promise.allSettled(users.map((u) => runDepartureAlertsForUser(u.userName)));
  } catch (err) {
    logger.warn({ err }, "Departure alert: failed to load active users");
  }
}

// ── Scheduler: every 5 minutes, 7am–10pm CT ───────────────────────────────────

export function startCalendarSyncScheduler(): void {
  // New-event / moved-event detection — every 5 minutes
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

  // Departure-time alerts — every 2 minutes (finer resolution so we don't miss the window)
  cron.schedule(
    "*/2 6-23 * * *",
    async () => {
      try {
        await runDepartureAlerts();
      } catch (err) {
        logger.error({ err }, "Departure alert scheduler error");
      }
    },
    { timezone: TZ }
  );

  logger.info("Calendar sync scheduler (every 5 min, 7am–10pm CT) + departure alert scheduler (every 2 min) started");
}
