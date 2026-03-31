import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedCreateEvent {
  action: "create";
  title: string;
  date: string;        // YYYY-MM-DD
  startTime: string;   // HH:MM (24-hour)
  endTime?: string;    // HH:MM (24-hour)
  location?: string;
  description?: string;
  allDay?: boolean;
  ambiguous?: boolean;
  clarificationNeeded?: string;
}

export interface ParsedModifyEvent {
  action: "modify";
  searchKeywords: string;
  searchDate?: string;   // YYYY-MM-DD of the CURRENT event
  newDate?: string;      // YYYY-MM-DD
  newStartTime?: string; // HH:MM
  newEndTime?: string;   // HH:MM
  newTitle?: string;
  newLocation?: string;
}

export interface ParsedDeleteEvent {
  action: "delete";
  searchKeywords: string;
  searchDate?: string;   // YYYY-MM-DD
}

export type ParsedCalendarOp = ParsedCreateEvent | ParsedModifyEvent | ParsedDeleteEvent;

function getTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getDayOfWeek(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
  });
}

export async function parseCalendarOperation(
  message: string,
  action: "create" | "modify" | "delete"
): Promise<ParsedCalendarOp | null> {
  const today = getTodayStr();
  const dayOfWeek = getDayOfWeek();

  const schemaByAction: Record<string, string> = {
    create: `{
  "action": "create",
  "title": "string — event name",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM (24-hour) or null for all-day",
  "endTime": "HH:MM (24-hour) — omit if not mentioned, default +1 hour",
  "location": "string or null",
  "description": "string or null",
  "allDay": "boolean (true only if no time is given)",
  "ambiguous": "boolean — true if date/time is unclear",
  "clarificationNeeded": "string — what to ask if ambiguous, else null"
}`,
    modify: `{
  "action": "modify",
  "searchKeywords": "string — title/description keywords to find the current event",
  "searchDate": "YYYY-MM-DD — date of the CURRENT event if determinable",
  "newDate": "YYYY-MM-DD — new date if changing, else omit",
  "newStartTime": "HH:MM (24-hour) — new start time if changing, else omit",
  "newEndTime": "HH:MM (24-hour) — new end time if changing, else omit",
  "newTitle": "string — new title if changing, else omit",
  "newLocation": "string — new location if changing, else omit"
}`,
    delete: `{
  "action": "delete",
  "searchKeywords": "string — title/description keywords to identify the event",
  "searchDate": "YYYY-MM-DD — date of the event if determinable"
}`,
  };

  const prompt = `Today is ${dayOfWeek}, ${today} (America/Chicago timezone).

The user wants to ${action} a calendar event. Extract the details from their message and return ONLY a valid JSON object matching this schema:

${schemaByAction[action]}

User message: "${message}"

Important:
- Resolve relative dates: "today" = ${today}, "tomorrow" = next day, "Thursday" = the next upcoming Thursday from today, etc.
- Times like "noon" = "12:00", "midnight" = "00:00", "2pm" = "14:00", "2:30pm" = "14:30"
- Return ONLY the JSON object, no markdown, no explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;

    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return parsed as ParsedCalendarOp;
  } catch {
    return null;
  }
}

// ── Pending delete confirmation store (single-user in-memory) ────────────────

export interface PendingDelete {
  eventId: string;
  summary: string;
  dateLabel: string;
  startTime: string;
  location?: string;
  expiresAt: number;
}

let _pendingDelete: PendingDelete | null = null;

export function setPendingDelete(op: PendingDelete): void {
  _pendingDelete = op;
}

export function getPendingDelete(): PendingDelete | null {
  if (!_pendingDelete) return null;
  if (Date.now() > _pendingDelete.expiresAt) {
    _pendingDelete = null;
    return null;
  }
  return _pendingDelete;
}

export function clearPendingDelete(): void {
  _pendingDelete = null;
}

// ── Format created/updated event for confirmation ────────────────────────────

export function formatEventConfirmation(details: {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  allDay?: boolean;
}): string {
  const d = new Date(details.date + "T12:00:00");
  const dateStr = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const timeStr = details.allDay
    ? "all day"
    : details.startTime
    ? formatDisplayTime(details.startTime) +
      (details.endTime ? ` to ${formatDisplayTime(details.endTime)}` : "")
    : "";

  const loc = details.location ? ` at ${details.location}` : "";

  return `${details.title} on ${dateStr}${timeStr ? ` at ${timeStr}` : ""}${loc}`;
}

function formatDisplayTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  const min = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour}${min}${ampm}`;
}
