import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { fetchEventsForDate } from "../google/calendar.js";
import { sendGmailReply } from "./draftScanner.js";
import { createCalendarEvent } from "../google/calendar.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MeetingRequest {
  emailId: string;
  organizer: string;
  organizerEmail: string;
  subject: string;
  emailDate: string;
  eventTitle: string;
  proposedDate: string | null;      // YYYY-MM-DD
  proposedStartTime: string | null; // HH:MM 24h
  proposedEndTime: string | null;   // HH:MM 24h
  location: string | null;
  description: string | null;
  hasConflict: boolean;
  conflictingEvent: string | null;
  suggestedResponse: string;
}

// ── Gmail helpers (reuse pattern from gmailOrderScanner) ──────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBodyFromPayload(payload: GmailPart): string {
  function walk(parts: GmailPart[]): string {
    for (const mime of ["text/plain", "text/html"]) {
      for (const p of parts) {
        if (p.mimeType === mime && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.parts) { const r = walk(p.parts); if (r) return r; }
      }
    }
    return "";
  }
  if (payload.parts?.length) return walk(payload.parts);
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s{2,}/g, " ").trim();
}

function extractEmailAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1].toLowerCase() : raw.toLowerCase();
}

// ── Claude: extract meeting details from email ────────────────────────────────

interface ParsedMeeting {
  isMeetingRequest: boolean;
  eventTitle: string | null;
  proposedDate: string | null;    // YYYY-MM-DD
  proposedStartTime: string | null; // HH:MM 24h
  proposedEndTime: string | null;
  location: string | null;
  description: string | null;
}

async function parseMeetingFromEmail(
  from: string,
  subject: string,
  body: string,
  emailDate: string,
): Promise<ParsedMeeting | null> {
  const today = new Date().toISOString().split("T")[0];
  const truncated = body.slice(0, 4000);

  const prompt = `Extract meeting request details from this email. Return ONLY valid JSON or null if this is not a meeting/scheduling request.

Today: ${today} (America/Chicago)
From: ${from}
Subject: ${subject}
Date: ${emailDate}

Body:
${truncated}

Return JSON:
{
  "isMeetingRequest": true | false,
  "eventTitle": "meeting name or null",
  "proposedDate": "YYYY-MM-DD or null",
  "proposedStartTime": "HH:MM (24h) or null",
  "proposedEndTime": "HH:MM (24h) or null",
  "location": "location or null",
  "description": "brief description or null"
}

Count as meeting requests: Zoom/Teams/Google Meet invites, "let's schedule a call", "can we meet", calendar invite attachments, "are you free on", scheduling links (Calendly etc.), "I'd like to set up a time".
Do NOT count: order confirmations, newsletters, event announcements you're not being personally invited to.`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text === "null") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ParsedMeeting;
    if (!parsed.isMeetingRequest) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[MeetingScanner] Claude parse failed");
    return null;
  }
}

// ── Conflict check ────────────────────────────────────────────────────────────

export async function checkForConflict(
  userName: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<{ hasConflict: boolean; conflictingEvent: string | null }> {
  try {
    const events = await fetchEventsForDate(new Date(date + "T12:00:00"), userName);
    if (!events || events.length === 0) return { hasConflict: false, conflictingEvent: null };

    const [startH, startM] = startTime.split(":").map(Number);
    const [endH, endM] = endTime.split(":").map(Number);
    const newStart = startH * 60 + startM;
    const newEnd = endH * 60 + endM;

    for (const event of events) {
      if (event.allDay) continue;
      if (!event.startIso) continue;

      const evStart = new Date(event.startIso);
      const evStartH = evStart.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
      const [evSH, evSM] = evStartH.split(":").map(Number);
      const evStartMin = evSH * 60 + evSM;

      let evEndMin = evStartMin + 60; // default 1 hour
      if (event.endIso) {
        const evEnd = new Date(event.endIso);
        const evEndStr = evEnd.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
        const [evEH, evEM] = evEndStr.split(":").map(Number);
        evEndMin = evEH * 60 + evEM;
      }

      // Overlap check
      if (newStart < evEndMin && newEnd > evStartMin) {
        return { hasConflict: true, conflictingEvent: event.summary };
      }
    }
  } catch (err) {
    logger.warn({ err }, "[MeetingScanner] Conflict check failed");
  }
  return { hasConflict: false, conflictingEvent: null };
}

// ── Main scanner ──────────────────────────────────────────────────────────────

const MEETING_SUBJECT_KEYWORDS = [
  "meeting", "meet", "call", "invite", "invitation", "calendar",
  "schedule", "zoom", "teams", "google meet", "webex", "are you free",
  "can we talk", "let's connect", "set up a time", "calendly",
];

function buildMeetingQuery(since?: Date): string {
  const subjectClauses = MEETING_SUBJECT_KEYWORDS
    .map((k) => `subject:"${k}"`).join(" OR ");
  let q = `in:inbox (${subjectClauses}) -from:me -in:spam -in:trash`;
  if (since) {
    q += ` after:${Math.floor(since.getTime() / 1000)}`;
  } else {
    // Default: last 7 days
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    q += ` after:${sevenDaysAgo}`;
  }
  return q;
}

export async function scanEmailsForMeetings(
  userName: string,
  since?: Date,
): Promise<MeetingRequest[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[MeetingScanner] No auth client");
    return [];
  }
  try { await auth.getAccessToken(); } catch { return []; }

  const gmail = google.gmail({ version: "v1", auth });
  const q = buildMeetingQuery(since);

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 30, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[MeetingScanner] Gmail list failed");
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[MeetingScanner] Candidate emails");

  const results: MeetingRequest[] = [];

  for (const msgId of messageIds.slice(0, 15)) {
    try {
      const detail = await gmail.users.messages.get({
        userId: "me", id: msgId, format: "full",
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (n: string) =>
        headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const date = getHeader("Date");
      const fromEmail = extractEmailAddress(from);

      let body = extractBodyFromPayload((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 20) continue;

      const parsed = await parseMeetingFromEmail(from, subject, body, date);
      if (!parsed) continue;

      // Conflict check if we have date + time
      let hasConflict = false;
      let conflictingEvent: string | null = null;
      if (parsed.proposedDate && parsed.proposedStartTime) {
        const endTime = parsed.proposedEndTime ??
          addOneHour(parsed.proposedStartTime);
        const conflict = await checkForConflict(userName, parsed.proposedDate, parsed.proposedStartTime, endTime);
        hasConflict = conflict.hasConflict;
        conflictingEvent = conflict.conflictingEvent;
      }

      const displayName = from.match(/^(.*?)\s*</) ?
        from.match(/^(.*?)\s*</)![1].trim().replace(/^"|"$/g, "") : from;

      const suggestedResponse = hasConflict
        ? `Thanks for reaching out! I have a conflict at that time (${conflictingEvent}). Could we find another slot?`
        : parsed.proposedDate
          ? `Sounds great — I'll get that on the calendar. See you then!`
          : `Thanks! Happy to find a time that works — what does your availability look like?`;

      results.push({
        emailId: msgId,
        organizer: displayName,
        organizerEmail: fromEmail,
        subject,
        emailDate: date,
        eventTitle: parsed.eventTitle ?? subject,
        proposedDate: parsed.proposedDate,
        proposedStartTime: parsed.proposedStartTime,
        proposedEndTime: parsed.proposedEndTime,
        location: parsed.location,
        description: parsed.description,
        hasConflict,
        conflictingEvent,
        suggestedResponse,
      });

      logger.info({ emailId: msgId, organizer: displayName, hasConflict }, "[MeetingScanner] Meeting request found");
    } catch (err) {
      logger.warn({ err, msgId }, "[MeetingScanner] Failed to process email");
    }
  }

  return results;
}

export function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Accept / Decline actions ──────────────────────────────────────────────────

export async function acceptMeetingRequest(
  userName: string,
  meeting: MeetingRequest,
): Promise<{ ok: boolean; calendarEventId: string | null; replySent: boolean }> {
  let calendarEventId: string | null = null;
  let replySent = false;

  // 1. Add to calendar
  if (meeting.proposedDate && meeting.proposedStartTime) {
    const result = await createCalendarEvent({
      title: meeting.eventTitle,
      date: meeting.proposedDate,
      startTime: meeting.proposedStartTime,
      endTime: meeting.proposedEndTime ?? addOneHour(meeting.proposedStartTime),
      location: meeting.location ?? undefined,
      description: meeting.description ?? undefined,
    }, userName);
    calendarEventId = result?.id ?? null;
  }

  // 2. Send reply
  replySent = await sendGmailReply(
    userName,
    meeting.emailId,
    meeting.organizerEmail,
    meeting.subject,
    meeting.suggestedResponse,
  );

  return { ok: true, calendarEventId, replySent };
}

export async function declineMeetingRequest(
  userName: string,
  meeting: MeetingRequest,
  customMessage?: string,
): Promise<{ ok: boolean; replySent: boolean }> {
  const message = customMessage ??
    `Thanks for the invite! Unfortunately I'm not able to make that time work. Hope we can connect another time!`;

  const replySent = await sendGmailReply(
    userName,
    meeting.emailId,
    meeting.organizerEmail,
    meeting.subject,
    message,
  );

  return { ok: true, replySent };
}
