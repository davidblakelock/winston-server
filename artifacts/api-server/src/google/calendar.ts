import { google } from "googleapis";
import { getAuthClient } from "./oauth.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  allDay: boolean;
}

function formatTime(dateTime: string | null | undefined, date: string | null | undefined, tz: string): string {
  if (date && !dateTime) return "all day";
  if (!dateTime) return "";
  return new Date(dateTime).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export async function fetchTodayEvents(): Promise<CalendarEvent[] | null> {
  const auth = await getAuthClient();
  if (!auth) return null;

  const calendar = google.calendar({ version: "v3", auth });
  const tz = "America/Chicago";

  const now = new Date();
  const startOfDay = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime();

  const timeMin = new Date(startOfDay.getTime() + offsetMs).toISOString();
  const timeMax = new Date(endOfDay.getTime() + offsetMs).toISOString();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 15,
  });

  const items = response.data.items ?? [];

  return items.map((event) => ({
    summary: event.summary ?? "(no title)",
    start: formatTime(event.start?.dateTime, event.start?.date, tz),
    end: formatTime(event.end?.dateTime, event.end?.date, tz),
    location: event.location ?? undefined,
    description: event.description ?? undefined,
    allDay: !event.start?.dateTime,
  }));
}

export function formatCalendarForPrompt(events: CalendarEvent[]): string {
  if (events.length === 0) return "Calendar is clear today — nothing scheduled.";
  return events
    .map((e) => {
      const time = e.allDay ? "All day" : `${e.start} – ${e.end}`;
      const loc = e.location ? ` @ ${e.location}` : "";
      return `• ${time}: ${e.summary}${loc}`;
    })
    .join("\n");
}
