import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EventType = "birthday" | "anniversary" | "other";

export interface ImportantDate {
  id: number;
  personName: string;
  relationship: string | null;
  eventType: EventType;
  month: number;
  day: number;
  year: number | null;
  notes: string | null;
}

export interface UpcomingDate extends ImportantDate {
  nextOccurrence: Date;
  daysUntil: number;
  yearsCount: number | null;
  label: string;
}

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function localDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function daysBetween(a: Date, b: Date): number {
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bDay.getTime() - aDay.getTime()) / 86400000);
}

export function nextOccurrence(month: number, day: number, from: Date = new Date()): Date {
  const tz = "America/Chicago";
  const todayStr = localDateStr(from);
  const [todayY] = todayStr.split("-").map(Number);

  function candidate(year: number): Date {
    const maxDay = new Date(year, month, 0).getDate();
    return new Date(year, month - 1, Math.min(day, maxDay));
  }

  const thisYear = candidate(todayY);
  const thisYearStr = localDateStr(thisYear);
  return thisYearStr >= todayStr ? thisYear : candidate(todayY + 1);
}

export async function getDates(): Promise<ImportantDate[]> {
  const { rows } = await query<{
    id: number; person_name: string; relationship: string | null;
    event_type: string; month: number; day: number; year: number | null; notes: string | null;
  }>(
    `SELECT id, person_name, relationship, event_type, month, day, year, notes
     FROM important_dates
     WHERE user_name = 'David' AND active = true
     ORDER BY month ASC, day ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    personName: r.person_name,
    relationship: r.relationship,
    eventType: r.event_type as EventType,
    month: r.month,
    day: r.day,
    year: r.year,
    notes: r.notes,
  }));
}

export async function getUpcomingDates(daysAhead = 21): Promise<UpcomingDate[]> {
  const dates = await getDates();
  const now = new Date();

  const result: UpcomingDate[] = dates.map((d) => {
    const occ = nextOccurrence(d.month, d.day, now);
    const daysUntil = daysBetween(now, occ);
    const currentYear = new Date().getFullYear();
    const yearsCount = d.year ? currentYear - d.year + (occ.getFullYear() > currentYear ? 1 : 0) : null;
    const label = `${MONTH_NAMES[d.month]} ${d.day}`;
    return { ...d, nextOccurrence: occ, daysUntil, yearsCount, label };
  });

  return result
    .filter((d) => d.daysUntil >= 0 && d.daysUntil <= daysAhead)
    .sort((a, b) => a.nextOccurrence.getTime() - b.nextOccurrence.getTime());
}

export async function addDate(
  personName: string,
  eventType: EventType,
  month: number,
  day: number,
  relationship?: string,
  year?: number,
  notes?: string
): Promise<{ success: boolean; alreadyExists: boolean; date?: ImportantDate }> {
  const existing = await query(
    `SELECT id FROM important_dates
     WHERE user_name = 'David' AND lower(person_name) = lower($1)
       AND event_type = $2 AND active = true`,
    [personName, eventType]
  );
  if (existing.rows.length > 0) return { success: false, alreadyExists: true };

  const { rows } = await query<{
    id: number; person_name: string; relationship: string | null;
    event_type: string; month: number; day: number; year: number | null; notes: string | null;
  }>(
    `INSERT INTO important_dates (user_name, person_name, relationship, event_type, month, day, year, notes)
     VALUES ('David', $1, $2, $3, $4, $5, $6, $7)
     RETURNING id, person_name, relationship, event_type, month, day, year, notes`,
    [personName, relationship ?? null, eventType, month, day, year ?? null, notes ?? null]
  );
  return {
    success: true,
    alreadyExists: false,
    date: {
      id: rows[0].id,
      personName: rows[0].person_name,
      relationship: rows[0].relationship,
      eventType: rows[0].event_type as EventType,
      month: rows[0].month,
      day: rows[0].day,
      year: rows[0].year,
      notes: rows[0].notes,
    },
  };
}

export async function removeDate(nameQuery: string, eventType?: string): Promise<boolean> {
  const typeClause = eventType ? `AND event_type = '${eventType}'` : "";
  const { rows } = await query(
    `UPDATE important_dates SET active = false
     WHERE user_name = 'David' AND lower(person_name) LIKE lower($1) ${typeClause} AND active = true
     RETURNING id`,
    [`%${nameQuery}%`]
  );
  return rows.length > 0;
}

// ── Claude extraction ─────────────────────────────────────────────────────────
export interface ExtractedDate {
  personName: string;
  eventType: EventType;
  month: number;
  day: number;
  year?: number;
  relationship?: string;
}

export async function extractDateFromMessage(message: string): Promise<ExtractedDate | null> {
  const result = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    system: `Extract birthday/anniversary info from natural language.

Return ONLY valid JSON:
- personName: string (first name or full name)
- eventType: "birthday" | "anniversary"
- month: integer 1-12
- day: integer 1-31
- year: integer or null (only for anniversaries if year mentioned)
- relationship: string or null ("daughter", "wife", "son", "friend", etc.)

Examples:
"Olivia's birthday is October 15th" → {"personName":"Olivia","eventType":"birthday","month":10,"day":15,"year":null,"relationship":"daughter"}
"my anniversary with Susan is June 3rd" → {"personName":"Susan","eventType":"anniversary","month":6,"day":3,"year":null,"relationship":"wife"}
"my anniversary with Susan is June 3rd, we got married in 2008" → {"personName":"Susan","eventType":"anniversary","month":6,"day":3,"year":2008,"relationship":"wife"}`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text = result.content[0].type === "text" ? result.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as ExtractedDate;
  } catch {
    return null;
  }
}

// ── Reminder messages ─────────────────────────────────────────────────────────
export function buildDateReminderMessage(d: UpcomingDate): string {
  const { personName, eventType, daysUntil, label, yearsCount } = d;

  const yearsStr = yearsCount && eventType === "anniversary"
    ? ` — that'll be ${yearsCount} year${yearsCount === 1 ? "" : "s"}`
    : "";

  if (daysUntil === 0) {
    if (eventType === "birthday") {
      return `David, just a reminder — today is ${personName}'s birthday! Hope you have something special planned.`;
    }
    return `David, today is your anniversary with ${personName}${yearsStr}. Make it a special one.`;
  }

  const timeStr =
    daysUntil === 1 ? "tomorrow" :
    daysUntil <= 7 ? `in ${daysUntil} days on ${label}` :
    `in ${daysUntil} days on ${label}`;

  if (eventType === "birthday") {
    return `David, heads up — ${personName}'s birthday is ${timeStr}. Have you thought about what you'd like to do for them?`;
  }
  return `David, your anniversary with ${personName} is ${timeStr}${yearsStr}. Something to keep in mind.`;
}

// ── Format for prompts ─────────────────────────────────────────────────────────
export function formatDatesForPrompt(dates: UpcomingDate[]): string {
  if (!dates.length) return "";
  return dates.map((d) => {
    const type = d.eventType === "birthday" ? "Birthday" : d.eventType === "anniversary" ? "Anniversary" : "Special date";
    const years = d.yearsCount ? ` (${d.yearsCount} years)` : "";
    const urgency = d.daysUntil === 0 ? " — TODAY" : d.daysUntil === 1 ? " — TOMORROW" : ` — in ${d.daysUntil} days`;
    return `• ${personLabel(d)}: ${type}${years} on ${d.label}${urgency}`;
  }).join("\n");
}

function personLabel(d: UpcomingDate): string {
  if (d.relationship) return `${d.personName} (${d.relationship})`;
  return d.personName;
}

export function confirmDateAdded(d: ImportantDate): string {
  const occ = nextOccurrence(d.month, d.day);
  const label = `${MONTH_NAMES[d.month]} ${d.day}`;
  const daysUntil = daysBetween(new Date(), occ);
  const type = d.eventType === "birthday" ? "birthday" : "anniversary";
  const timeStr = daysUntil === 0 ? "today" :
    daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
  return `Got it — I have ${d.personName}'s ${type} on ${label}. That's ${timeStr}. I'll remind you two weeks out, one week out, three days before, and the day of.`;
}
