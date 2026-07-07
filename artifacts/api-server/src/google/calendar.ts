import { google } from "googleapis";
import { getAuthClient, getAuthClientForUser, isInvalidGrant, GoogleInvalidGrantError } from "./oauth.js";
import { logger } from "../lib/logger.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

async function resolveAuthClient(userName?: string) {
  if (userName) return getAuthClientForUser(userName);
  return getAuthClient();
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;        // formatted time e.g. "10:30 AM" in America/Chicago
  end: string;          // formatted time in America/Chicago
  startIso?: string;    // raw ISO datetime string for timed events (undefined for all-day)
  endIso?: string;
  dateLabel: string;
  isoDate: string;
  location?: string;
  description?: string;
  allDay: boolean;
  attendees?: Array<{ name?: string; email?: string }>;
}

const TZ = "America/Chicago";

/**
 * Convert any UTC timestamp (ISO string or Date) to a Date whose
 * local-time methods (getHours, getMinutes, getFullYear, etc.) reflect
 * America/Chicago time. Always use this when displaying times or when
 * comparing event times against the current CT date/hour.
 *
 * IMPORTANT: For arithmetic comparisons (is event A before event B?),
 * .getTime() is identical regardless of timezone conversion — use it
 * directly. toChicagoTime is useful when you need CT hour/day values,
 * e.g. "is this event in the past in CT?" across a DST boundary.
 */
export function toChicagoTime(timestamp: string | Date): Date {
  const utc = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  // Render the UTC time in CT locale, then re-parse as a local Date.
  // The resulting Date object's getHours() / getDate() / etc. reflect CT.
  const ctStr = utc.toLocaleString("en-US", { timeZone: TZ });
  return new Date(ctStr);
}

/**
 * Return the current date string in CT (YYYY-MM-DD).
 */
export function chicagoDateStr(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Return the UTC equivalent of midnight (00:00:00) in America/Chicago
 * for the CT calendar day that contains `date`.
 *
 * This is safe across DST transitions because it:
 *   1. Reads the CT date string via Intl (always correct).
 *   2. Reads the current CT UTC offset via Intl (e.g. "GMT-5" CDT / "GMT-6" CST).
 *   3. Constructs the exact UTC ISO string for CT midnight — no arithmetic tricks.
 */
function ctMidnightOf(date: Date): Date {
  const ctDateStr = chicagoDateStr(date); // "YYYY-MM-DD" in CT
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const offsetStr = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  // offsetStr = "GMT-5" (CDT) or "GMT-6" (CST)
  const offsetHours = parseInt(offsetStr.replace("GMT", "") || "-5", 10); // -5 or -6
  // CT midnight in UTC = ctDateStr at (-offsetHours):00:00Z
  // e.g. CDT: "2026-04-07T05:00:00.000Z" = midnight April 7 CDT
  const utcHour = String(-offsetHours).padStart(2, "0");
  return new Date(`${ctDateStr}T${utcHour}:00:00.000Z`);
}

/**
 * Return true if a timed event's start time is strictly in the past
 * when measured in America/Chicago. All-day events are never past.
 */
function isEventInPast(event: { startIso?: string; allDay: boolean }): boolean {
  if (event.allDay || !event.startIso) return false;
  // Both sides are UTC epoch ms — comparison is timezone-independent and correct.
  // We use toChicagoTime to make the intent explicit: we want CT "now" vs CT event time.
  const nowCT = toChicagoTime(new Date());
  const eventCT = toChicagoTime(event.startIso);
  return eventCT.getTime() < nowCT.getTime();
}

function formatTime(dateTime: string | null | undefined, date: string | null | undefined, tz = TZ): string {
  if (date && !dateTime) return "all day";
  if (!dateTime) return "";
  return new Date(dateTime).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getDayLabel(isoDate: string, todayStr: string, tomorrowStr: string): string {
  if (isoDate === todayStr) return "Today";
  if (isoDate === tomorrowStr) return "Tomorrow";
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function getLocalYMD(date: Date, tz = TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localMidnightOf(date: Date, tz: string): Date {
  const localDateStr = getLocalYMD(date, tz);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(date);
  const offsetStr = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const offsetHours = parseInt(offsetStr.replace("GMT", "") || "0", 10);
  const utcHour = String(-offsetHours).padStart(2, "0");
  return new Date(`${localDateStr}T${utcHour}:00:00.000Z`);
}

/**
 * Fetch the list of all calendar IDs the user has access to.
 * Returns ["primary"] as fallback if the calendarList call fails.
 * Throws a plain Error("invalid_grant") when the token is revoked — callers
 * should convert this to GoogleInvalidGrantError with the userName.
 */
async function getAllCalendarIds(
  calendar: ReturnType<typeof google.calendar>
): Promise<string[]> {
  try {
    const listResp = await calendar.calendarList.list({ maxResults: 50 });
    const ids = (listResp.data.items ?? [])
      .map((cal) => cal.id)
      .filter((id): id is string => Boolean(id));
    return ids.length > 0 ? ids : ["primary"];
  } catch (err) {
    const code = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
    const message = (err as Error)?.message ?? String(err);
    if (isInvalidGrant(err)) {
      logger.warn({ code, message }, "Google Calendar: calendarList.list — invalid_grant (token revoked)");
      throw new Error("invalid_grant");
    }
    logger.warn({ code, message }, "Google Calendar: calendarList.list failed — falling back to primary");
    return ["primary"];
  }
}

/**
 * Fetch events from ALL calendars the user has access to for a given time window.
 * Deduplicates by event ID and sorts by start time ascending.
 */
async function fetchEventsFromAllCalendars(
  calendar: ReturnType<typeof google.calendar>,
  timeMin: string,
  timeMax: string,
  todayStr: string,
  tomorrowStr: string,
  maxPerCalendar = 50,
  tz = TZ
): Promise<CalendarEvent[]> {
  // getAllCalendarIds throws Error("invalid_grant") when the token is revoked.
  const calendarIds = await getAllCalendarIds(calendar);

  const seen = new Set<string>();
  const allEvents: CalendarEvent[] = [];
  let invalidGrantDetected = false;

  await Promise.all(
    calendarIds.map(async (calendarId) => {
      try {
        const response = await calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: maxPerCalendar,
        });
        for (const event of response.data.items ?? []) {
          const id = event.id ?? "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          // Skip declined events (attendee status = declined for David's own entry)
          const selfAttendee = (event.attendees ?? []).find((a) => a.self);
          if (selfAttendee?.responseStatus === "declined") continue;
          const isoDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? todayStr;
          allEvents.push({
            id,
            summary: event.summary ?? "(no title)",
            start: formatTime(event.start?.dateTime, event.start?.date, tz),
            end: formatTime(event.end?.dateTime, event.end?.date, tz),
            startIso: event.start?.dateTime ?? undefined,
            endIso: event.end?.dateTime ?? undefined,
            dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
            isoDate,
            location: event.location ?? undefined,
            description: event.description ?? undefined,
            allDay: !event.start?.dateTime,
            attendees: (event.attendees ?? [])
              .filter((a) => !a.self && a.displayName)
              .map((a) => ({ name: a.displayName ?? undefined, email: a.email ?? undefined })),
          });
        }
      } catch (err) {
        const code = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
        const message = (err as Error)?.message ?? String(err);
        if (isInvalidGrant(err)) {
          invalidGrantDetected = true;
          logger.warn({ calendarId, code, message }, "Google Calendar: events.list — invalid_grant (token revoked)");
        } else {
          logger.warn({ calendarId, code, message }, "Google Calendar: events.list failed — skipping calendar");
        }
      }
    })
  );

  if (invalidGrantDetected) throw new Error("invalid_grant");

  // Sort merged events by start time
  allEvents.sort((a, b) => {
    const aT = a.startIso ? new Date(a.startIso).getTime() : new Date(a.isoDate).getTime();
    const bT = b.startIso ? new Date(b.startIso).getTime() : new Date(b.isoDate).getTime();
    return aT - bT;
  });

  return allEvents;
}

export async function fetchTodayEvents(userName?: string): Promise<CalendarEvent[] | null> {
  const { timezone: tz } = userName ? await getUserLocationContext(userName) : { timezone: TZ };
  const auth = await resolveAuthClient(userName);
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now, tz);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000), tz);

  const midnight = localMidnightOf(now, tz);
  const timeMin = midnight.toISOString();
  const timeMax = new Date(midnight.getTime() + 86399999).toISOString();

  try {
    const events = await fetchEventsFromAllCalendars(calendar, timeMin, timeMax, todayStr, tomorrowStr, 20, tz);
    return events.filter((event) => !isEventInPast(event));
  } catch (err) {
    if ((err as Error)?.message === "invalid_grant") {
      throw new GoogleInvalidGrantError(userName ?? "unknown");
    }
    throw err;
  }
}

export async function fetchTomorrowEvents(userName?: string): Promise<CalendarEvent[] | null> {
  const { timezone: tz } = userName ? await getUserLocationContext(userName) : { timezone: TZ };
  const auth = await resolveAuthClient(userName);
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now, tz);
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowStr = getLocalYMD(tomorrowDate, tz);

  const midnightTomorrow = localMidnightOf(tomorrowDate, tz);
  const timeMin = midnightTomorrow.toISOString();
  const timeMax = new Date(midnightTomorrow.getTime() + 86399999).toISOString();

  return fetchEventsFromAllCalendars(calendar, timeMin, timeMax, todayStr, tomorrowStr, 20, tz);
  // Note: do NOT filter with isEventInPast — all tomorrow events are future events
}

/**
 * Fetch events for a specific calendar date (YYYY-MM-DD in CT).
 * Used by restaurant intelligence to check for scheduling conflicts.
 */
export async function fetchEventsForDate(
  dateISO: string,
  userName?: string
): Promise<CalendarEvent[] | null> {
  const auth = await resolveAuthClient(userName);
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });

  // Build a Date that falls within the target CT day (noon avoids DST edge cases)
  const [y, mo, d] = dateISO.split("-").map(Number);
  const targetDate = new Date(Date.UTC(y, mo - 1, d, 18, 0, 0)); // ~noon CT

  const todayStr = chicagoDateStr();
  const tomorrowStr = getLocalYMD(new Date(targetDate.getTime() + 86400000));

  const midnight = ctMidnightOf(targetDate);
  const timeMin = midnight.toISOString();
  const timeMax = new Date(midnight.getTime() + 86399999).toISOString();

  try {
    return await fetchEventsFromAllCalendars(calendar, timeMin, timeMax, todayStr, tomorrowStr, 20);
  } catch {
    return null;
  }
}

export async function fetchWeekEvents(filterPast = true, userName?: string): Promise<CalendarEvent[] | null> {
  const { timezone: tz } = userName ? await getUserLocationContext(userName) : { timezone: TZ };
  const auth = await resolveAuthClient(userName);
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now, tz);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000), tz);

  const midnight = localMidnightOf(now, tz);
  const timeMin = midnight.toISOString();
  const timeMax = new Date(midnight.getTime() + 7 * 86400000).toISOString();

  const events = await fetchEventsFromAllCalendars(calendar, timeMin, timeMax, todayStr, tomorrowStr, 50, tz);
  return filterPast ? events.filter((event) => !isEventInPast(event)) : events;
}

/**
 * Fetch events across an arbitrary date range (YYYY-MM-DD).
 * Uses CT midnight as the time window boundaries.
 * Returns null if the user has no Google Calendar auth.
 */
export async function fetchEventsForDateRange(
  startDate: string,
  endDate: string,
  userName?: string
): Promise<CalendarEvent[] | null> {
  const auth = await resolveAuthClient(userName);
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const todayStr = getLocalYMD(now);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000));

  // Use noon UTC so chicagoDateStr maps to the correct CT calendar date
  const timeMin = ctMidnightOf(new Date(startDate + "T12:00:00Z")).toISOString();
  const timeMax = new Date(
    ctMidnightOf(new Date(endDate + "T12:00:00Z")).getTime() + 86400000
  ).toISOString();

  return fetchEventsFromAllCalendars(calendar, timeMin, timeMax, todayStr, tomorrowStr, 200);
}

export function formatCalendarForPrompt(events: CalendarEvent[], label = "today"): string {
  if (events.length === 0) {
    return `Calendar is clear ${label} — nothing scheduled.`;
  }

  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (!byDay.has(e.dateLabel)) byDay.set(e.dateLabel, []);
    byDay.get(e.dateLabel)!.push(e);
  }

  const parts: string[] = [];
  for (const [day, dayEvents] of byDay) {
    const entries = dayEvents.map((e) => {
      // start/end are already formatted in CT 12-hour time by formatTime()
      const time = e.allDay ? "all day" : `${e.start}${e.end && e.end !== e.start ? ` – ${e.end}` : ""}`;
      const loc = e.location ? ` at ${e.location}` : "";
      const desc = e.description ? ` (${e.description.slice(0, 80)})` : "";
      return `  • ${e.summary} — ${time}${loc}${desc}`;
    });
    parts.push(`${day}:\n${entries.join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Write Operations ────────────────────────────────────────────────────────

function buildEventDateTime(date: string, time: string): { dateTime: string; timeZone: string } {
  return {
    dateTime: `${date}T${time}:00`,
    timeZone: TZ,
  };
}

export async function createCalendarEvent(details: {
  title: string;
  date: string;
  startTime: string;
  endTime?: string;
  location?: string;
  description?: string;
  allDay?: boolean;
  attendees?: Array<{ name?: string; email?: string }>;
}, userName?: string): Promise<{ id: string; htmlLink: string } | null> {
  const auth = await resolveAuthClient(userName);
  if (!auth) {
    console.error("[CALENDAR CREATE] no auth client — Google not connected");
    return null;
  }

  // Log which credentials are being used
  const creds = auth.credentials;
  console.log(`[CALENDAR CREATE] auth resolved — has access_token: ${!!creds.access_token}, has refresh_token: ${!!creds.refresh_token}, expiry: ${creds.expiry_date ? new Date(creds.expiry_date).toISOString() : "none"}`);

  const calendar = google.calendar({ version: "v3", auth });
  const endTime = details.endTime ?? addOneHour(details.startTime);

  const requestBody: any = {
    summary: details.title,
    location: details.location,
    description: details.description,
  };

  if (details.allDay) {
    requestBody.start = { date: details.date };
    requestBody.end = { date: details.date };
  } else {
    requestBody.start = buildEventDateTime(details.date, details.startTime);
    requestBody.end = buildEventDateTime(details.date, endTime);
  }

  const filteredAttendees = (details.attendees ?? []).filter((a) => a.email);
  if (filteredAttendees.length > 0) {
    requestBody.attendees = filteredAttendees.map((a) => ({
      email: a.email,
      displayName: a.name,
    }));
  }

  console.log(`[CALENDAR CREATE] inserting event — title: "${details.title}", date: ${details.date}, startTime: ${details.startTime}, allDay: ${!!details.allDay}, attendees: ${filteredAttendees.length}`);

  try {
    const response = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: filteredAttendees.length > 0 ? "all" : "none",
      requestBody,
    });

    console.log(`[CALENDAR CREATE] Google API response status: ${response.status}, id: ${response.data.id ?? "none"}, htmlLink: ${response.data.htmlLink ?? "none"}`);

    if (!response.data.id) {
      console.error("[CALENDAR CREATE] insert returned no event ID — treating as failure");
      return null;
    }
    return { id: response.data.id, htmlLink: response.data.htmlLink ?? "" };
  } catch (err: unknown) {
    logger.error({ err, errData: (err as any)?.response?.data ?? null }, "[CALENDAR CREATE] *** TEMP DIAGNOSTIC *** Google Calendar API insert failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = (err as any)?.code ?? (err as any)?.status ?? "unknown";
    console.error(`[CALENDAR CREATE] Google Calendar API insert failed — code: ${errCode}, message: ${errMsg}`);
    if ((err as any)?.response?.data) {
      console.error("[CALENDAR CREATE] Google API error body:", JSON.stringify((err as any).response.data));
    }
    return null;
  }
}

/**
 * Check if there is an existing calendar event that overlaps with the
 * proposed start time on a given date. Returns the conflicting event
 * summary if found, or null if the slot is free.
 */
export async function checkCalendarConflict(
  userName: string,
  dateISO: string,   // YYYY-MM-DD
  startTime: string, // HH:MM 24-hour
  durationMinutes = 60
): Promise<string | null> {
  try {
    const auth = await resolveAuthClient(userName);
    if (!auth) return null;
    const calendar = google.calendar({ version: "v3", auth });

    const startMs = new Date(`${dateISO}T${startTime}:00`).getTime();
    const endMs   = startMs + durationMinutes * 60 * 1000;

    const timeMin = new Date(startMs).toISOString();
    const timeMax = new Date(endMs).toISOString();

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 5,
    });

    const events = res.data.items ?? [];
    if (events.length === 0) return null;

    return events[0]?.summary ?? "an existing event";
  } catch (err) {
    logger.warn({ err, dateISO, startTime }, "[Calendar] checkCalendarConflict failed");
    return null;
  }
}

export async function updateCalendarEvent(
  eventId: string,
  updates: {
    title?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    description?: string;
  },
  userName?: string
): Promise<boolean> {
  console.log(`[CALENDAR UPDATE] attempting to update event id: ${eventId}`, JSON.stringify(updates));

  const auth = await resolveAuthClient(userName);
  if (!auth) {
    console.error("[CALENDAR UPDATE] ERROR — no auth client (Google not connected)");
    return false;
  }

  const calendar = google.calendar({ version: "v3", auth });

  // Fetch current event first so we can preserve unchanged fields
  let current: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    current = await calendar.events.get({ calendarId: "primary", eventId });
    console.log(`[CALENDAR UPDATE] fetched current event: "${current.data.summary}" start=${current.data.start?.dateTime ?? current.data.start?.date}`);
  } catch (fetchErr: unknown) {
    console.error("[CALENDAR UPDATE] ERROR fetching current event:", fetchErr);
    return false;
  }

  if (!current.data) {
    console.error("[CALENDAR UPDATE] ERROR — event.get returned no data for eventId:", eventId);
    return false;
  }

  const patch: Record<string, unknown> = {};

  if (updates.title) patch.summary = updates.title;
  if (updates.location !== undefined) patch.location = updates.location;
  if (updates.description !== undefined) patch.description = updates.description;

  if (updates.date || updates.startTime) {
    const currentStart = current.data.start?.dateTime;
    const currentDate = currentStart
      ? currentStart.slice(0, 10)
      : current.data.start?.date ?? "";
    const currentTime = currentStart ? currentStart.slice(11, 16) : "09:00";
    const currentEndDT = current.data.end?.dateTime;
    const currentEndTime = currentEndDT ? currentEndDT.slice(11, 16) : addOneHour(currentTime);

    const newDate = updates.date ?? currentDate;
    const newStart = updates.startTime ?? currentTime;
    const newEnd = updates.endTime ?? (updates.startTime ? addOneHour(updates.startTime) : currentEndTime);

    patch.start = buildEventDateTime(newDate, newStart);
    patch.end = buildEventDateTime(newDate, newEnd);

    console.log(`[CALENDAR UPDATE] new date/time: ${newDate} ${newStart} → ${newEnd}`);
  }

  if (Object.keys(patch).length === 0) {
    console.warn("[CALENDAR UPDATE] patch object is empty — nothing to update. Updates:", JSON.stringify(updates));
    return false;
  }

  console.log(`[CALENDAR UPDATE] calling Google Calendar API patch endpoint for eventId: ${eventId}`, JSON.stringify(patch));

  try {
    const patchResponse = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: patch,
    });
    const status = patchResponse.status;
    console.log(`[CALENDAR UPDATE] API response status: ${status}`);
    if (status >= 200 && status < 300) {
      console.log(`[CALENDAR UPDATE] success — event "${patchResponse.data.summary}" updated. htmlLink: ${patchResponse.data.htmlLink ?? "n/a"}`);
      return true;
    } else {
      console.error(`[CALENDAR UPDATE] ERROR — unexpected status ${status} from Google Calendar API`);
      return false;
    }
  } catch (patchErr: unknown) {
    const errMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
    console.error(`[CALENDAR UPDATE] ERROR — Google Calendar API patch failed: ${errMsg}`);
    return false;
  }
}

export async function deleteCalendarEvent(eventId: string, userName?: string): Promise<boolean> {
  const auth = await resolveAuthClient(userName);
  if (!auth) {
    console.error("[CALENDAR DELETE] no auth client — Google not connected");
    return false;
  }

  const calendar = google.calendar({ version: "v3", auth });
  try {
    const response = await calendar.events.delete({ calendarId: "primary", eventId });
    console.log(`[CALENDAR DELETE] event ${eventId} deleted, status: ${response.status}`);
    return true;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[CALENDAR DELETE] failed to delete event ${eventId}: ${errMsg}`);
    return false;
  }
}

export async function findEventByKeywords(
  keywords: string,
  targetDate?: string
): Promise<CalendarEvent | null> {
  const events = await fetchWeekEvents();
  if (!events) return null;

  const kw = keywords.toLowerCase();
  const words = kw.split(/\s+/).filter((w) => w.length > 2);

  // Filter by date first if provided
  let pool = events;
  if (targetDate) {
    const dateFiltered = events.filter((e) => e.isoDate === targetDate);
    if (dateFiltered.length > 0) pool = dateFiltered;
  }

  // Score each event by keyword matches
  let best: CalendarEvent | null = null;
  let bestScore = 0;

  for (const ev of pool) {
    const haystack = `${ev.summary} ${ev.location ?? ""} ${ev.description ?? ""}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }

  // Require at least one keyword hit
  return bestScore > 0 ? best : pool.length === 1 ? pool[0] : null;
}

/**
 * Find an event to update using Google's server-side text search (`q` parameter).
 * Searches from 7 days ago through 60 days ahead — much broader than fetchWeekEvents().
 * This is the right function to use for move/reschedule operations.
 */
export async function findEventForUpdate(keywords: string): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) {
    console.log("[CALENDAR] findEventForUpdate — no auth client");
    return null;
  }

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const todayStr = getLocalYMD(now);

  // Search from 7 days ago to 60 days ahead so we catch both recent and upcoming events
  const timeMin = new Date(now.getTime() - 7 * 86400000).toISOString();
  const timeMax = new Date(now.getTime() + 60 * 86400000).toISOString();

  console.log(`[CALENDAR] findEventForUpdate — searching for existing event matching: "${keywords}"`);

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      q: keywords,          // server-side text search by Google
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });

    const items = response.data.items ?? [];
    console.log(`[CALENDAR] findEventForUpdate — Google text search returned ${items.length} result(s)`);

    if (items.length === 0) {
      // Fallback: fetch a broad window and do client-side scoring
      console.log("[CALENDAR] findEventForUpdate — no results from q-search, falling back to keyword scoring");
      const fallbackResponse = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      const allItems = fallbackResponse.data.items ?? [];
      const kw = keywords.toLowerCase();
      const words = kw.split(/\s+/).filter((w) => w.length > 2);
      const scored: Array<{ item: (typeof allItems)[0]; score: number }> = [];
      for (const item of allItems) {
        const haystack = `${item.summary ?? ""} ${item.location ?? ""} ${item.description ?? ""}`.toLowerCase();
        const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
        if (score > 0) scored.push({ item, score });
      }
      if (scored.length === 0) {
        console.log("[CALENDAR] findEventForUpdate — fallback scoring also found nothing");
        return null;
      }
      scored.sort((a, b) => b.score - a.score);
      const results = scored.slice(0, 5).map(({ item }) => mapGoogleEvent(item, todayStr));
      console.log(`[CALENDAR] findEventForUpdate — fallback found ${results.length} candidate(s): ${results.map((e) => `"${e.summary}"`).join(", ")}`);
      return results;
    }

    // Return all results from the Google text search (cap at 5 for disambiguation)
    const results = items.slice(0, 5).map((item) => mapGoogleEvent(item, todayStr));
    console.log(`[CALENDAR] findEventForUpdate — returning ${results.length} candidate(s): ${results.map((e) => `"${e.summary}"`).join(", ")}`);
    return results;
  } catch (err) {
    console.error("[CALENDAR] findEventForUpdate — error:", err);
    return null;
  }
}

function mapGoogleEvent(item: {
  id?: string | null;
  summary?: string | null;
  start?: { date?: string | null; dateTime?: string | null };
  end?: { date?: string | null; dateTime?: string | null };
  location?: string | null;
  description?: string | null;
}, todayStr: string): CalendarEvent {
  const tomorrowStr = getLocalYMD(new Date(new Date().getTime() + 86400000));
  const isoDate = item.start?.date ?? item.start?.dateTime?.slice(0, 10) ?? todayStr;
  return {
    id: item.id ?? "",
    summary: item.summary ?? "(no title)",
    start: formatTime(item.start?.dateTime, item.start?.date),
    end: formatTime(item.end?.dateTime, item.end?.date),
    startIso: item.start?.dateTime ?? undefined,
    endIso: item.end?.dateTime ?? undefined,
    dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
    isoDate,
    location: item.location ?? undefined,
    description: item.description ?? undefined,
    allDay: !item.start?.dateTime,
  };
}

function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const newH = (h + 1) % 24;
  return `${String(newH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
