/**
 * Background Email Scanner
 *
 * Runs a heartbeat every 60 minutes and processes four categories of emails:
 *
 *   1. Meeting requests        → immediate push notification
 *   2. Event invitations       → immediate push if not already on Google Calendar
 *   3. Order confirmations     → saved to Order Tracker
 *   4. Travel confirmations    → saved to Travel screen (flights, hotels, rental cars)
 *
 * Everything else is ignored.
 */

import cron from "node-cron";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
import { upsertOrder, getOrders } from "../orders/ordersManager.js";
import { scanEmailsForMeetings } from "../email/meetingScanner.js";
import { setPendingMeetingRequests, getPendingMeetingRequests } from "../email/emailMeetingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { MODEL_HAIKU } from "../lib/models.js";
import type { MeetingRequest } from "../email/meetingScanner.js";

const TZ = "America/Chicago";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Per-user last-scan timestamp (in-memory; resets on restart) ───────────────

const _lastScanAt = new Map<string, Date>();

// Fixed scan interval: 60 minutes
const SCAN_INTERVAL_MS = 60 * 60 * 1000;

// ── Gmail body extraction helpers ─────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBody(payload: GmailPart): string {
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

// ── 1. Order confirmations → Order Tracker ────────────────────────────────────

const NOTIFY_STATUSES = new Set(["out_for_delivery", "delivered"]);

async function processOrderEmails(userName: string, since: Date): Promise<void> {
  try {
    const scanned = await scanOrderEmails(userName, since);
    if (scanned.length === 0) return;

    const existing = await getOrders(userName);
    const existingByTracking = new Map(
      existing
        .filter((o) => o.tracking_number)
        .map((o) => [o.tracking_number!, o.status])
    );

    for (const order of scanned) {
      const prevStatus = order.tracking_number
        ? existingByTracking.get(order.tracking_number) ?? null
        : null;

      await upsertOrder(userName, order);

      const newStatus = order.status ?? "ordered";
      const statusChanged = prevStatus !== null && prevStatus !== newStatus;

      if (statusChanged && NOTIFY_STATUSES.has(newStatus)) {
        const label = newStatus === "delivered" ? "Delivered" : "Out for delivery";
        const body = `${label}: ${order.item_name ?? "Your package"}${order.retailer ? ` from ${order.retailer}` : ""}`;
        await sendPushToAll(
          { title: "Package Update", body, type: "order-update" },
          userName
        );
        logger.info(
          { tracking: order.tracking_number, prevStatus, newStatus },
          "[BgEmailScanner] Order status push sent"
        );
      }
    }

    logger.info({ userName, count: scanned.length }, "[BgEmailScanner] Orders processed");
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Order scan failed");
  }
}

// ── 2. Meeting requests → immediate push ─────────────────────────────────────

function isTomorrowOrSooner(meeting: MeetingRequest): boolean {
  if (!meeting.proposedDate) return false;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: TZ });
  return meeting.proposedDate <= tomorrowStr;
}

async function processMeetingEmails(userName: string, since: Date): Promise<void> {
  try {
    const meetings = await scanEmailsForMeetings(userName, since);
    if (meetings.length === 0) return;

    const existing = getPendingMeetingRequests();
    const existingIds = new Set(existing.map((m) => m.gmailId));
    const newMeetings = meetings.filter((m) => !existingIds.has(m.emailId));

    if (newMeetings.length > 0) {
      const allMeetings = [
        ...existing,
        ...newMeetings.map((m) => ({
          gmailId: m.emailId,
          gmailThreadId: m.emailId,
          from: m.organizer,
          fromEmail: m.organizerEmail,
          subject: m.subject,
          proposedDateTimeStr: m.proposedDate
            ? `${m.proposedDate}${m.proposedStartTime ? " " + m.proposedStartTime : ""}`
            : null,
          isOpenEnded: !m.proposedDate,
          calendarStatus: (m.hasConflict ? "conflict" : "free") as "free" | "conflict" | "unknown",
          conflictEvent: m.conflictingEvent,
          suggestedAlternative: null,
        })),
      ];
      setPendingMeetingRequests(allMeetings);
    }

    const urgent = newMeetings.filter(isTomorrowOrSooner);
    for (const meeting of urgent) {
      const when = meeting.proposedDate
        ? `${meeting.proposedDate}${meeting.proposedStartTime ? " at " + meeting.proposedStartTime : ""}`
        : "soon";
      const body = `${meeting.organizer} wants to meet ${when}${meeting.hasConflict ? " — you have a conflict" : ""}`;
      await sendPushToAll(
        { title: "Meeting Request Needs Response", body, type: "calendar-update" },
        userName
      );
      logger.info({ organizer: meeting.organizer, date: meeting.proposedDate }, "[BgEmailScanner] Meeting push sent");
    }

    logger.info({ userName, total: meetings.length, urgent: urgent.length }, "[BgEmailScanner] Meetings processed");
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Meeting scan failed");
  }
}

// ── 3. Event invitations → push if not already on Google Calendar ─────────────

const EVENT_INVITE_KEYWORDS = [
  "invitation:", "you're invited", "you have been invited",
  "calendar invite", "event invitation", "has invited you",
  "invited you to", "cordially invited", "join us for",
  "save the date",
];

interface ExtractedEventInvite {
  isInvite: boolean;
  eventTitle: string | null;
  eventDate: string | null;   // YYYY-MM-DD or null
  organizer: string | null;
}

async function extractEventInviteInfo(
  subject: string,
  body: string,
  from: string,
): Promise<ExtractedEventInvite | null> {
  const truncated = body.slice(0, 2500);
  const prompt = `Determine if this email is a calendar event invitation (NOT a meeting request, NOT a newsletter). Return ONLY valid JSON.

From: ${from}
Subject: ${subject}

Body:
${truncated}

Return JSON:
{
  "isInvite": true | false,
  "eventTitle": "name of the event or null",
  "eventDate": "YYYY-MM-DD or null if unknown/no specific date",
  "organizer": "organizer name or null"
}

Count as invitations: event invites, party invitations, social gathering invites, conference invitations, webinar invitations, save-the-date emails.
Do NOT count: meeting requests between two people (those are handled separately), newsletters, promotional emails, marketing.`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ExtractedEventInvite;
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Event invite extraction failed");
    return null;
  }
}

async function isEventOnCalendar(userName: string, title: string, date: string | null): Promise<boolean> {
  try {
    const auth = await getAuthClientForUser(userName);
    if (!auth) return false;
    const calendar = google.calendar({ version: "v3", auth });

    let timeMin: string;
    let timeMax: string;

    if (date) {
      const d = new Date(date + "T00:00:00");
      timeMin = new Date(d.getTime() - 24 * 60 * 60 * 1000).toISOString();
      timeMax = new Date(d.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      timeMin = new Date().toISOString();
      timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    }

    const resp = await calendar.events.list({
      calendarId: "primary",
      q: title,
      timeMin,
      timeMax,
      maxResults: 5,
      singleEvents: true,
    });

    return (resp.data.items?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function processEventInvitations(userName: string, since: Date): Promise<void> {
  try {
    const auth = await getAuthClientForUser(userName);
    if (!auth) return;
    try { await auth.getAccessToken(); } catch { return; }

    const gmail = google.gmail({ version: "v1", auth });
    const subjectClauses = EVENT_INVITE_KEYWORDS.map((k) => `subject:"${k}"`).join(" OR ");
    const q = `in:inbox (${subjectClauses}) -from:me after:${Math.floor(since.getTime() / 1000)}`;

    const list = await gmail.users.messages.list({ userId: "me", maxResults: 20, q });
    const messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);

    if (messageIds.length === 0) return;
    logger.info({ userName, count: messageIds.length }, "[BgEmailScanner] Event invite candidates");

    for (const msgId of messageIds.slice(0, 10)) {
      try {
        const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
        const headers = detail.data.payload?.headers ?? [];
        const getH = (n: string) =>
          headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

        const subject = getH("Subject");
        const from = getH("From");

        let body = extractBody((detail.data.payload ?? {}) as GmailPart);
        if (body.includes("<")) body = stripHtml(body);
        if (body.length < 20) continue;

        const extracted = await extractEventInviteInfo(subject, body, from);
        if (!extracted?.isInvite || !extracted.eventTitle) continue;

        const alreadyOnCalendar = await isEventOnCalendar(userName, extracted.eventTitle, extracted.eventDate);
        if (alreadyOnCalendar) {
          logger.info({ title: extracted.eventTitle }, "[BgEmailScanner] Event already on calendar, skipping");
          continue;
        }

        const dateStr = extracted.eventDate ? ` on ${extracted.eventDate}` : "";
        const body2 = `${extracted.eventTitle}${dateStr}${extracted.organizer ? ` — from ${extracted.organizer}` : ""}`;
        await sendPushToAll(
          { title: "Event Invitation", body: body2, type: "calendar-update" },
          userName
        );
        logger.info({ title: extracted.eventTitle, date: extracted.eventDate }, "[BgEmailScanner] Event invite push sent");
      } catch (err) {
        logger.warn({ err, msgId }, "[BgEmailScanner] Failed to process event invite");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Event invitation scan failed");
  }
}

// ── Main scan tick ────────────────────────────────────────────────────────────

async function runScan(userName: string): Promise<void> {
  const lastScan = _lastScanAt.get(userName);
  const elapsedMs = lastScan ? Date.now() - lastScan.getTime() : Infinity;

  if (elapsedMs < SCAN_INTERVAL_MS) {
    const nextInMin = Math.ceil((SCAN_INTERVAL_MS - elapsedMs) / 60_000);
    logger.info({ userName, nextInMin }, "[BgEmailScanner] Skipping tick — not yet time");
    return;
  }

  const since = lastScan ?? new Date(Date.now() - SCAN_INTERVAL_MS);
  const scanStart = new Date();

  logger.info({ userName, since: since.toISOString() }, "[BgEmailScanner] Starting scan");

  await Promise.allSettled([
    processOrderEmails(userName, since),
    processMeetingEmails(userName, since),
    processEventInvitations(userName, since),
  ]);

  _lastScanAt.set(userName, scanStart);
  logger.info({ userName }, "[BgEmailScanner] Scan complete");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Heartbeat fires every 15 min to handle restarts gracefully.
// Actual scan only runs when 60+ minutes have elapsed since the last scan.

export function startBackgroundEmailScanner(userName = NATIVE_USER): void {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runScan(userName);
    } catch (err) {
      logger.error({ err }, "[BgEmailScanner] Unhandled error in scan");
    }
  }, { timezone: TZ });

  logger.info("[BgEmailScanner] Scheduler started — 60-minute scan interval");
}
