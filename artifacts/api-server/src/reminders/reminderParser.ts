import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ExtractedReminder {
  reminderText: string;
  time: string | null; // null when the user gave no explicit time
  dayOfWeek: string | null; // 'monday'–'sunday' when a specific day is named; null for relative phrases or recurring patterns
  nextWeek: boolean; // true only when the literal word 'next' immediately precedes the day name
  isTomorrow: boolean; // true when the literal word 'tomorrow' is used — forces the fire date to the next calendar day regardless of whether the given time has already passed today
  isRecurring: boolean;
  recurring: string | null;
  forContact: string | null;
}

export async function extractReminder(message: string, tz: string): Promise<ExtractedReminder | null> {
  // Build current time in unambiguous 24-hour ISO-style format using the caller's timezone.
  // toLocaleString() produces "4/9/2026, 2:30:00 PM" (12-hour) which the AI can
  // misinterpret when computing relative times like "in 5 minutes".
  // Intl.DateTimeFormat.formatToParts gives us 24-hour parts directly.
  const nowRaw = new Date();
  const ctFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year:   "numeric",
    month:  "2-digit",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const ctParts = Object.fromEntries(
    ctFmt.formatToParts(nowRaw).map((x) => [x.type, x.value])
  );
  // e.g. "2026-04-09 14:30 CDT"
  const nowCT = `${ctParts.year}-${ctParts.month}-${ctParts.day} ${ctParts.hour}:${ctParts.minute} ${ctParts.timeZoneName ?? "CT"}`;

  const extraction = await anthropic.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 256,
    system: `You extract reminder details from natural language. Current time in Dallas, TX: ${nowCT} (24-hour clock).

For relative times ("in 5 minutes", "in 1 hour", "in 30 minutes") add the offset to the EXACT current time shown above and output the result in 24-hour HH:MM format. Do not round to a convenient hour or half-hour.

Return ONLY valid JSON with these fields:
- reminderText: string — what to remind about (concise, e.g. "call dentist")
- time: string or null — 24-hour HH:MM format if an explicit or relative time is given (e.g. "15:00" for 3pm, "07:00" for 7am). Return null if NO time is mentioned at all — do NOT guess or use the current time.
- dayOfWeek: string or null — lowercase day name ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday") if a specific day of the week is named (e.g. "next Monday", "this Friday", "on Tuesday"). Return null for relative phrases ("in 5 minutes", "tomorrow", "tonight") and for recurring patterns.
- nextWeek: boolean — true ONLY when the literal word "next" immediately precedes the day name (e.g. "next Monday" → true). False for bare day names ("Monday"), "this Monday", "upcoming Monday", or any recurring pattern.
- isTomorrow: boolean — true ONLY when the literal word "tomorrow" is used (e.g. "remind me tomorrow at 10:30"). This must force the reminder to fire the next calendar day no matter what time it is right now — even if the given time hasn't happened yet today. False for "today", "tonight", bare times with no day mentioned, or any recurring pattern.
- isRecurring: boolean
- recurring: string or null — one of:
    null                   (one-time reminder)
    "daily"                (every day)
    "weekdays"             (Monday through Friday)
    "weekends"             (Saturday and Sunday)
    "weekly"               (same day each week — use ONLY when a specific day is not mentioned)
    "weekly:<days>"        (specific days — comma-separated 3-letter codes: mon,tue,wed,thu,fri,sat,sun)
                           e.g. every Tuesday and Thursday → "weekly:tue,thu"
                           e.g. every Monday → "weekly:mon"
                           e.g. every Mon, Wed, Fri → "weekly:mon,wed,fri"
    "monthly:<day>"        (every month on that day number)
                           e.g. every month on the 15th → "monthly:15"
                           e.g. the first of every month → "monthly:1"
- forContact: string or null — if the reminder is FOR another person (not the user themselves), their first name only (e.g. "Sarah"). Null if the reminder is for the user.

Examples:
"remind me to call Olivia at 3pm" → {"reminderText":"call Olivia","time":"15:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind Sarah to call the dentist at 3pm" → {"reminderText":"call the dentist","time":"15:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"set a reminder for Sarah to take her medication at 8am" → {"reminderText":"take her medication","time":"08:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind me to take my medication every morning at 7am" → {"reminderText":"take my medication","time":"07:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":true,"recurring":"daily","forContact":null}
"remind me to walk Winston every weekday at 8am" → {"reminderText":"walk Winston","time":"08:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":true,"recurring":"weekdays","forContact":null}
"remind me every Tuesday and Thursday at 6am to stretch" → {"reminderText":"stretch","time":"06:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":true,"recurring":"weekly:tue,thu","forContact":null}
"remind me every Monday at 9am" → {"reminderText":"remind me","time":"09:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":true,"recurring":"weekly:mon","forContact":null}
"remind me on the 15th of every month at noon to pay rent" → {"reminderText":"pay rent","time":"12:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":true,"recurring":"monthly:15","forContact":null}
"remind me in 5 minutes" (current time 14:30) → {"reminderText":"remind me","time":"14:35","dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind me to take my medicine" (no time given) → {"reminderText":"take my medicine","time":null,"dayOfWeek":null,"nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind me next Monday at 8am" → {"reminderText":"remind me","time":"08:00","dayOfWeek":"monday","nextWeek":true,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind me this Friday at noon" → {"reminderText":"remind me","time":"12:00","dayOfWeek":"friday","nextWeek":false,"isTomorrow":false,"isRecurring":false,"recurring":null,"forContact":null}
"remind me tomorrow at 9am" → {"reminderText":"remind me","time":"09:00","dayOfWeek":null,"nextWeek":false,"isTomorrow":true,"isRecurring":false,"recurring":null,"forContact":null}
"remind me tomorrow at 10:30 to do the laundry" (regardless of current time) → {"reminderText":"do the laundry","time":"10:30","dayOfWeek":null,"nextWeek":false,"isTomorrow":true,"isRecurring":false,"recurring":null,"forContact":null}`,
    messages: [{ role: "user", content: message }],
  });

  try {
    const text = extraction.content[0].type === "text" ? extraction.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ExtractedReminder;
  } catch {
    return null;
  }
}

export function computeFireAt(timeStr: string, tz: string, forceNextDay = false): Date {
  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const now = new Date();

  // Use Intl.DateTimeFormat.formatToParts — reliable across all Node.js environments.
  // toLocaleString() + new Date(string) is fragile: the string format varies by platform
  // and new Date() parses it in the SERVER's local timezone, causing off-by-offset errors.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const tzYear  = parseInt(p.year,   10);
  const tzMonth = parseInt(p.month,  10) - 1; // 0-indexed
  const tzDay   = parseInt(p.day,    10);
  const tzHour  = parseInt(p.hour,   10);
  const tzMin   = parseInt(p.minute, 10);

  // Represent "now" as a fake-UTC ms value using the tz wall-clock values.
  // This lets us do arithmetic purely with UTC math.
  const localNowMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, 0);

  // Truncate real "now" to the minute boundary before computing the offset.
  // now.getTime() carries raw seconds+ms; localNowMs has seconds=0.
  // Without truncation, offsetMs would be "5h 0m 42s" instead of exactly "5h",
  // and that 42-second noise would bleed into the final fire_at timestamp.
  const nowTruncatedMs = now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds());
  const offsetMs = nowTruncatedMs - localNowMs; // CDT → exactly +5h; CST → exactly +6h

  // Build the desired fire time on today's tz date (using fake-UTC)
  let candidateMs = Date.UTC(tzYear, tzMonth, tzDay, desiredH, desiredM, 0);

  // If the desired time is at or before current tz time, push to tomorrow —
  // or if the caller already knows "tomorrow" was said explicitly, push
  // forward unconditionally. Without forceNextDay, "remind me tomorrow at
  // 10:30" said at 9am would compute today's 10:30 (since that time hasn't
  // passed yet) and silently drop the word "tomorrow" the user actually said.
  if (candidateMs <= localNowMs || forceNextDay) {
    candidateMs += 24 * 60 * 60 * 1000;
  }

  // Shift fake-UTC back to real UTC by adding the offset
  return new Date(candidateMs + offsetMs);
}

export function resolveNextDayOfWeek(dayOfWeek: string, timeStr: string, tz: string, nextWeek: boolean): Date {
  const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = DAY_NAMES.indexOf(dayOfWeek.toLowerCase());
  if (target === -1) return computeFireAt(timeStr, tz); // unknown day → fall back

  const [desiredH, desiredM] = timeStr.split(":").map(Number);
  const now = new Date();

  // Get wall-clock date components in tz (same pattern as computeFireAt)
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const tzYear  = parseInt(p.year,   10);
  const tzMonth = parseInt(p.month,  10) - 1; // 0-indexed
  const tzDay   = parseInt(p.day,    10);
  const tzHour  = parseInt(p.hour,   10);
  const tzMin   = parseInt(p.minute, 10);

  // Today's day-of-week in tz (noon UTC anchor avoids DST midnight ambiguity)
  const today = new Date(Date.UTC(tzYear, tzMonth, tzDay, 12, 0, 0)).getUTCDay();

  let daysUntil = (target - today + 7) % 7;
  if (daysUntil === 0) daysUntil = 7; // same weekday as today → skip to next week

  // "next Monday" said on a Sunday (daysUntil=1) should resolve to 8 days, not tomorrow
  if (nextWeek && daysUntil <= 1) daysUntil += 7;

  // Compute UTC↔wall offset at current moment (same as computeFireAt)
  const localNowMs = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, 0);
  const nowTruncMs = now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds());
  const offsetMs = nowTruncMs - localNowMs;

  // Build target wall-clock date (today + daysUntil days) at desired time, then shift to real UTC
  const targetWallMs = Date.UTC(tzYear, tzMonth, tzDay + daysUntil, desiredH, desiredM, 0);
  return new Date(targetWallMs + offsetMs);
}
