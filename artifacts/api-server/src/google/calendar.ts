import { google } from "googleapis";
import { getAuthClient } from "./oauth.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  dateLabel: string;
  isoDate: string;
  location?: string;
  description?: string;
  allDay: boolean;
}

const TZ = "America/Chicago";

function toLocalDate(isoOrDate: string | null | undefined): Date | null {
  if (!isoOrDate) return null;
  return new Date(isoOrDate);
}

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

function getLocalDateString(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .split("/").reverse().join("-")
    .replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1-$2-$3");
}

function getLocalYMD(date: Date): string {
  const y = date.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric" });
  const m = date.toLocaleDateString("en-US", { timeZone: TZ, month: "2-digit" });
  const d = date.toLocaleDateString("en-US", { timeZone: TZ, day: "2-digit" });
  return `${y}-${m}-${d}`;
}

export async function fetchTodayEvents(): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now);
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowStr = getLocalYMD(tomorrowDate);

  // Build UTC boundaries for the local calendar day
  const localMidnightStr = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  localMidnightStr.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime();
  const timeMin = new Date(localMidnightStr.getTime() + offsetMs).toISOString();
  const endOfDay = new Date(localMidnightStr.getTime() + offsetMs + 86399999);
  const timeMax = endOfDay.toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  return (response.data.items ?? []).map((event) => {
    const isoDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? todayStr;
    return {
      summary: event.summary ?? "(no title)",
      start: formatTime(event.start?.dateTime, event.start?.date),
      end: formatTime(event.end?.dateTime, event.end?.date),
      dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
      isoDate,
      location: event.location ?? undefined,
      description: event.description ?? undefined,
      allDay: !event.start?.dateTime,
    };
  });
}

export async function fetchWeekEvents(): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();

  const todayStr = getLocalYMD(now);
  const tomorrowStr = getLocalYMD(new Date(now.getTime() + 86400000));

  const localNow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  localNow.setHours(0, 0, 0, 0);
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: TZ })).getTime();

  const timeMin = new Date(localNow.getTime() + offsetMs).toISOString();
  const timeMax = new Date(localNow.getTime() + offsetMs + 7 * 86400000).toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  return (response.data.items ?? []).map((event) => {
    const isoDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? todayStr;
    return {
      summary: event.summary ?? "(no title)",
      start: formatTime(event.start?.dateTime, event.start?.date),
      end: formatTime(event.end?.dateTime, event.end?.date),
      dateLabel: getDayLabel(isoDate, todayStr, tomorrowStr),
      isoDate,
      location: event.location ?? undefined,
      description: event.description ?? undefined,
      allDay: !event.start?.dateTime,
    };
  });
}

export function formatCalendarForPrompt(events: CalendarEvent[], label = "today"): string {
  if (events.length === 0) {
    return `Calendar is clear ${label} — nothing scheduled.`;
  }

  // Group by day
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
