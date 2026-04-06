import { google } from "googleapis";
import { getAuthClient } from "./oauth.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;        // formatted time e.g. "10:30 AM"
  end: string;          // formatted time
  startIso?: string;    // raw ISO datetime string for timed events (undefined for all-day)
  endIso?: string;
  dateLabel: string;
  isoDate: string;
  location?: string;
  description?: string;
  allDay: boolean;
}

const TZ = "America/Chicago";

function formatTime(dateTime: string | null | undefined, date: string | null | undefined): string {
  if (date && !dateTime) return "all day";
  if (!dateTime) return "";
  return new Date(dateTime).toLocaleTimeString("en-US", {
    timeZone: TZ,
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

function getLocalYMD(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function fetchTodayEvents(): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000));

  const localMidnight = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  localMidnight.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime();
  const timeMin = new Date(localMidnight.getTime() + offsetMs).toISOString();
  const timeMax = new Date(localMidnight.getTime() + offsetMs + 86399999).toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  return (response.data.items ?? [])
    .map((event) => {
      const isoDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? todayStr;
      return {
        id: event.id ?? "",
        summary: event.summary ?? "(no title)",
        start: formatTime(event.start?.dateTime, event.start?.date),
        end: formatTime(event.end?.dateTime, event.end?.date),
        startIso: event.start?.dateTime ?? undefined,
        endIso: event.end?.dateTime ?? undefined,
        dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
        isoDate,
        location: event.location ?? undefined,
        description: event.description ?? undefined,
        allDay: !event.start?.dateTime,
      };
    })
    .filter((event) => {
      // Skip timed events whose start time is already in the past
      if (event.startIso) return new Date(event.startIso) >= now;
      return true; // Keep all-day events regardless of time
    });
}

export async function fetchWeekEvents(): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000));

  const localMidnight = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  localMidnight.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime();

  const timeMin = new Date(localMidnight.getTime() + offsetMs).toISOString();
  const timeMax = new Date(localMidnight.getTime() + offsetMs + 7 * 86400000).toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  return (response.data.items ?? [])
    .map((event) => {
      const isoDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? todayStr;
      return {
        id: event.id ?? "",
        summary: event.summary ?? "(no title)",
        start: formatTime(event.start?.dateTime, event.start?.date),
        end: formatTime(event.end?.dateTime, event.end?.date),
        startIso: event.start?.dateTime ?? undefined,
        endIso: event.end?.dateTime ?? undefined,
        dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
        isoDate,
        location: event.location ?? undefined,
        description: event.description ?? undefined,
        allDay: !event.start?.dateTime,
      };
    })
    .filter((event) => {
      if (event.startIso) return new Date(event.startIso) >= now;
      return true;
    });
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
}): Promise<{ id: string; htmlLink: string } | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

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

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody,
  });

  if (!response.data.id) return null;
  return { id: response.data.id, htmlLink: response.data.htmlLink ?? "" };
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
  }
): Promise<boolean> {
  const auth = await getAuthClient();
  if (!auth) return false;

  const calendar = google.calendar({ version: "v3", auth });

  // Fetch current event first
  const current = await calendar.events.get({ calendarId: "primary", eventId });
  if (!current.data) return false;

  const patch: any = {};

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
  }

  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: patch,
  });

  return true;
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const auth = await getAuthClient();
  if (!auth) return false;

  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: "primary", eventId });
  return true;
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

function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const newH = (h + 1) % 24;
  return `${String(newH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
