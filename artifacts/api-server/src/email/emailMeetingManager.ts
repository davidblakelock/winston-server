// ── Email Meeting Request Detection & Reply Composer ─────────────────────────
// Feature: scan morning briefing emails for meeting requests, surface them
// conversationally, and open the email app pre-filled with a drafted reply.
//
// Flow:
//   1. Morning briefing → detectMeetingRequests() → store pending requests
//   2. Winston surfaces them naturally: "You got a meeting request from X…
//      want me to draft a reply?"
//   3. User says "yes" → E007-MEET → composeEmailReply() → PendingEmailReply
//   4. Winston reads draft aloud, asks for confirmation
//   5. User confirms → E007-CONF → mailto: URI → frontend opens email app
//
// Beta rule: always require user approval before sending any email.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";
import type { CalendarEvent } from "../google/calendar.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DetectedMeetingRequest {
  gmailId: string;
  gmailThreadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  proposedDateTimeStr: string | null;
  isOpenEnded: boolean;
  calendarStatus: "free" | "conflict" | "unknown";
  conflictEvent: string | null;
  suggestedAlternative: string | null;
}

export interface PendingEmailReply {
  gmailId: string;
  gmailThreadId: string;
  to: string;
  recipientName: string;
  subject: string;
  draftBody: string;
  userName: string;
  createdAt: number;
}

// ── In-memory state ───────────────────────────────────────────────────────────

let _pendingMeetingRequests: DetectedMeetingRequest[] = [];
let _pendingMeetingRequestsAt = 0;
const MEETING_REQUEST_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let _pendingEmailReply: PendingEmailReply | null = null;
const EMAIL_REPLY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── State accessors ───────────────────────────────────────────────────────────

export function getPendingMeetingRequests(): DetectedMeetingRequest[] {
  if (_pendingMeetingRequests.length === 0) return [];
  if (Date.now() - _pendingMeetingRequestsAt > MEETING_REQUEST_TTL_MS) {
    _pendingMeetingRequests = [];
    return [];
  }
  return _pendingMeetingRequests;
}

export function setPendingMeetingRequests(requests: DetectedMeetingRequest[]): void {
  _pendingMeetingRequests = requests;
  _pendingMeetingRequestsAt = Date.now();
  if (requests.length > 0) {
    logger.info({ count: requests.length }, "[E007] Pending meeting requests stored");
  }
}

export function clearPendingMeetingRequests(): void {
  _pendingMeetingRequests = [];
}

export function getPendingEmailReply(): PendingEmailReply | null {
  if (!_pendingEmailReply) return null;
  if (Date.now() - _pendingEmailReply.createdAt > EMAIL_REPLY_TTL_MS) {
    _pendingEmailReply = null;
    return null;
  }
  return _pendingEmailReply;
}

export function setPendingEmailReply(reply: PendingEmailReply | null): void {
  _pendingEmailReply = reply;
  if (reply) {
    logger.info({ to: reply.to, subject: reply.subject }, "[E007] Email reply draft stored");
  } else {
    logger.info("[E007] Email reply draft cleared");
  }
}

export function clearPendingEmailReply(): void {
  _pendingEmailReply = null;
}

// ── Pending reply emails (needs_reply action from background scanner) ─────────
// Unlike meeting requests, these do not expire on a timer — they persist until
// explicitly cleared when the user replies, dismisses, or the email is no longer unread.

export interface PendingReplyEmail {
  gmailId: string;
  from: string;
  fromEmail: string;
  subject: string;
  summary: string | null;
  scannedAt: number;
}

let _pendingReplyEmails: PendingReplyEmail[] = [];

export function getPendingReplyEmails(): PendingReplyEmail[] {
  return _pendingReplyEmails;
}

// Merges new items by gmailId (no duplicates), keeps existing pending items indefinitely.
export function addPendingReplyEmails(newEmails: PendingReplyEmail[]): void {
  const existingIds = new Set(_pendingReplyEmails.map(e => e.gmailId));
  const toAdd = newEmails.filter(e => !existingIds.has(e.gmailId));
  _pendingReplyEmails = [..._pendingReplyEmails, ...toAdd];
}

// Called when a specific email is handled (replied to, dismissed, or detected as no longer unread).
export function clearPendingReplyEmail(gmailId: string): void {
  _pendingReplyEmails = _pendingReplyEmails.filter(e => e.gmailId !== gmailId);
}

export function clearAllPendingReplyEmails(): void {
  _pendingReplyEmails = [];
}

// ── Scan batch summary ────────────────────────────────────────────────────────

interface ScanBatchSummaryInput {
  pendingReplies: PendingReplyEmail[];
  pendingMeetings: DetectedMeetingRequest[];
  filedRecordsCount: number;
  filedOrdersCount: number;
}

export async function buildScanSummary(input: ScanBatchSummaryInput): Promise<string | null> {
  const { pendingReplies, pendingMeetings, filedRecordsCount, filedOrdersCount } = input;

  if (pendingReplies.length === 0 && pendingMeetings.length === 0 && filedRecordsCount === 0 && filedOrdersCount === 0) {
    return null;
  }

  const repliesBlock = pendingReplies.length > 0
    ? pendingReplies.map(e => `- From ${e.from}: "${e.subject}"${e.summary ? ` — ${e.summary}` : ''}`).join('\n')
    : 'None';

  const meetingsBlock = pendingMeetings.length > 0
    ? pendingMeetings.map(m => `- ${m.from} wants to meet${m.proposedDateTimeStr ? ` at ${m.proposedDateTimeStr}` : ' (no specific time proposed)'}`).join('\n')
    : 'None';

  const prompt = `You're writing a short, natural summary of what came in during an email scan, to tell the user conversationally — the way a thoughtful assistant would catch someone up, not a mechanical report.

Emails needing a reply:
${repliesBlock}

Meeting requests:
${meetingsBlock}

Other activity: ${filedRecordsCount} confirmation(s) filed to records, ${filedOrdersCount} order update(s) filed — these were already handled silently, just mention them briefly if relevant, don't dwell on them.

Write 2-4 sentences, warm and direct, that tells the user what's worth their attention and offers to help (e.g. "want me to draft a reply?"). Don't list every email mechanically — synthesize. If there's truly nothing needing the user's input, keep it very brief.`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content[0]?.type === "text" ? resp.content[0].text.trim() : null;
  } catch {
    return null;
  }
}

// ── Keyword pre-screen (fast — no API cost) ───────────────────────────────────

const MEETING_KEYWORDS =
  /\b(meet(?:ing)?|lunch|coffee|call|sync|catch[\s-]up|schedule|available|availability|hop\s+on|zoom|teams|calendar|invite|join|discuss|connect|get\s+together|grab|coordinate|find\s+a\s+time|set\s+up\s+a\s+time|circle\s+back|follow[\s-]up)\b/i;

// ── Interface matching EmailSummary extended fields ───────────────────────────
// We accept the subset of EmailSummary fields we need so this module
// doesn't create a circular import with gmail.ts.
export interface EmailInput {
  gmailId: string;
  gmailThreadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
}

// ── Meeting request detection via Claude Haiku ───────────────────────────────

export async function detectMeetingRequests(
  emails: EmailInput[],
  calendarEvents: CalendarEvent[],
): Promise<DetectedMeetingRequest[]> {
  const candidates = emails
    .filter((e) => MEETING_KEYWORDS.test(e.subject) || MEETING_KEYWORDS.test(e.snippet))
    .slice(0, 3);

  if (candidates.length === 0) return [];

  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const calCtx =
    calendarEvents
      .filter((e) => !e.allDay && e.startIso)
      .slice(0, 15)
      .map((e) => `- "${e.summary}" on ${e.dateLabel} at ${e.start}`)
      .join("\n") || "No upcoming calendar events";

  const emailList = candidates
    .map(
      (e, i) =>
        `${i + 1}. From: ${e.from} <${e.fromEmail}>\n` +
        `   Subject: ${e.subject}\n` +
        `   Preview: ${e.snippet.slice(0, 150)}`,
    )
    .join("\n\n");

  const prompt =
    `Today is ${todayStr}. Analyze these emails for meeting requests.\n\n` +
    `UPCOMING CALENDAR:\n${calCtx}\n\n` +
    `EMAILS:\n${emailList}\n\n` +
    `Respond ONLY with valid JSON:\n` +
    `{"requests":[{"emailIndex":1,"isMeetingRequest":true,"proposedDateTime":"Thursday at 2pm",` +
    `"isOpenEnded":false,"calendarConflict":null,"suggestedAlternative":null}]}\n\n` +
    `Rules: Only include isMeetingRequest=true. proposedDateTime=null if open-ended. ` +
    `calendarConflict=conflicting event name if clash detected. ` +
    `suggestedAlternative=free slot to suggest instead (or null). ` +
    `If no meeting requests: {"requests":[]}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as {
      requests: Array<{
        emailIndex: number;
        isMeetingRequest: boolean;
        proposedDateTime: string | null;
        isOpenEnded: boolean;
        calendarConflict: string | null;
        suggestedAlternative: string | null;
      }>;
    };

    return parsed.requests
      .filter((r) => r.isMeetingRequest && r.emailIndex >= 1 && r.emailIndex <= candidates.length)
      .map((r) => {
        const email = candidates[r.emailIndex - 1];
        return {
          gmailId: email.gmailId,
          gmailThreadId: email.gmailThreadId,
          from: email.from,
          fromEmail: email.fromEmail,
          subject: email.subject,
          proposedDateTimeStr: r.proposedDateTime ?? null,
          isOpenEnded: r.isOpenEnded,
          calendarStatus: r.calendarConflict
            ? "conflict"
            : r.proposedDateTime
              ? "free"
              : "unknown",
          conflictEvent: r.calendarConflict ?? null,
          suggestedAlternative: r.suggestedAlternative ?? null,
        };
      });
  } catch (err) {
    logger.warn({ err }, "[E007] Meeting detection Claude call failed");
    return [];
  }
}

// ── Briefing block builder ─────────────────────────────────────────────────────

export function buildMeetingRequestsBlock(requests: DetectedMeetingRequest[], userName: string): string {
  if (requests.length === 0) return "";

  const lines: string[] = [
    "\n\n[Pending Meeting Requests — Detected in Email]",
    "Surface these NATURALLY while covering the email section. Do NOT create a separate section.",
    "Weave them conversationally into the email summary.\n",
  ];

  for (const r of requests) {
    lines.push(`• From: ${r.from} (${r.fromEmail})`);
    lines.push(`  Subject: "${r.subject}"`);

    if (r.proposedDateTimeStr && !r.isOpenEnded) {
      lines.push(`  Proposed time: ${r.proposedDateTimeStr}`);
      if (r.calendarStatus === "conflict" && r.conflictEvent) {
        lines.push(`  Calendar: CONFLICT — "${r.conflictEvent}" is already scheduled`);
        const alt = r.suggestedAlternative ?? "a different time";
        lines.push(
          `  → Tell ${userName} about the conflict. Suggest ${alt} as an alternative. ` +
            `Ask: "Want me to draft a reply suggesting ${alt}?"`,
        );
      } else {
        lines.push(`  Calendar: Free at that time`);
        lines.push(
          `  → Mention the request. Say you're free then. Ask: "Want me to draft a reply?"`,
        );
      }
    } else {
      lines.push(`  Request: Open-ended (no specific time proposed)`);
      lines.push(
        `  → Mention that ${r.from} wants to meet up. Ask: "Want me to draft a reply suggesting a few times?"`,
      );
    }
    lines.push("");
  }

  lines.push(
    `BETA RULE: When ${userName} says yes, compose the reply and read it back for approval.`,
    `${userName} sends it via his email app — you cannot send it directly.`,
  );

  return lines.join("\n");
}

export function buildPendingRepliesBlock(replies: PendingReplyEmail[], userName: string): string {
  if (replies.length === 0) return "";
  const lines: string[] = [
    "\n\n[Pending Email Replies — Detected in Inbox]",
    "Surface these NATURALLY while covering the email section. Do NOT create a separate section.",
    "Weave them conversationally into the email summary.\n",
  ];
  for (const r of replies) {
    lines.push(`• From: ${r.from} (${r.fromEmail})`);
    lines.push(`  Subject: "${r.subject}"`);
    if (r.summary) {
      lines.push(`  Context: ${r.summary}`);
    }
    lines.push(
      `  → Mention this needs a reply. Ask: "Want me to draft a reply to ${r.from}?"`,
    );
    lines.push("");
  }
  lines.push(
    `BETA RULE: When ${userName} says yes to drafting one (or says 'yes' generally with multiple pending), compose ONE reply at a time and read it back for approval before moving to the next.`,
    `If ${userName} asks for a specific person by name (e.g. 'just reply to Susan'), only act on that one — leave the others pending.`,
    `${userName} sends each reply via his email app — you cannot send it directly.`,
  );
  return lines.join("\n");
}

// ── Email reply composition via Claude Sonnet ─────────────────────────────────

export async function composeEmailReply(
  request: Pick<DetectedMeetingRequest, "from" | "fromEmail" | "subject" | "proposedDateTimeStr" | "isOpenEnded">,
  userIntent: string,
  senderName: string,
): Promise<string> {
  const context = request.proposedDateTimeStr
    ? `They proposed: ${request.proposedDateTimeStr}`
    : "They made an open-ended request to meet";

  const prompt =
    `Write a professional but warm email reply FROM ${senderName} TO ${request.from}.\n\n` +
    `Original email subject: "${request.subject}"\n` +
    `${context}\n\n` +
    `${senderName}'s intent:\n${userIntent}\n\n` +
    `Write ONLY the email body. Start with "Hi ${request.from.split(" ")[0]}" or "Hey ${request.from.split(" ")[0]}". ` +
    `Keep it brief (2-4 sentences), warm, and direct. ` +
    `No placeholder text like [Date] — use the specific details from the intent. ` +
    `Sign off with just:\n${senderName}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected Claude response type");
  return block.text.trim();
}
