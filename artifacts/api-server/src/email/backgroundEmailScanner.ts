/**
 * Background Email Scanner — Unified Claude Classification
 *
 * Runs a heartbeat every 60 minutes. Fetches recent inbox emails with a broad
 * subject-keyword query and sends each to Claude Haiku for classification +
 * extraction in a single call. Routes actionable emails to the appropriate
 * downstream handler.
 *
 * Categories handled:
 *   1. order             → upsert into Order Tracker; push if status changed to out_for_delivery/delivered
 *   2. meeting           → store as pending meeting request; push if tomorrow-or-sooner
 *   3. event             → push if not already on Google Calendar
 *   4. none              → silently ignored
 */

import cron from "node-cron";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { upsertOrder, getOrders } from "../orders/ordersManager.js";
import { setPendingMeetingRequests, getPendingMeetingRequests } from "../email/emailMeetingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { MODEL_HAIKU } from "../lib/models.js";
import type { DetectedMeetingRequest } from "../email/emailMeetingManager.js";

const TZ = "America/Chicago";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Per-user last-scan timestamp (in-memory; resets on restart) ───────────────

const _lastScanAt = new Map<string, Date>();
const SCAN_INTERVAL_MS = 60 * 60 * 1000;

// ── Gmail body helpers ────────────────────────────────────────────────────────

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
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Unified Gmail query ───────────────────────────────────────────────────────
// Broad union of keywords from the former order, meeting, and event scanners.

const UNIFIED_SUBJECT_KEYWORDS = [
  // orders / shipping
  "order confirmation", "your order", "has shipped", "out for delivery",
  "delivered", "shipment notification", "shipping confirmation", "order shipped",
  "package delivered", "your package", "order update", "tracking number",
  // meetings / scheduling
  "meeting", "meet", "call", "invite", "invitation", "calendar",
  "schedule", "zoom", "teams", "google meet", "webex", "are you free",
  "can we talk", "set up a time", "calendly",
  // events / social
  "you're invited", "you have been invited", "event invitation",
  "has invited you", "invited you to", "cordially invited",
  "join us for", "save the date",
];

function buildUnifiedQuery(since: Date): string {
  const clauses = UNIFIED_SUBJECT_KEYWORDS.map((k) => `subject:"${k}"`).join(" OR ");
  return `in:inbox -in:spam -in:trash -from:me (${clauses}) after:${Math.floor(since.getTime() / 1000)}`;
}

// ── Claude Haiku: classify + extract in one call ──────────────────────────────

interface ClassifiedEmail {
  type: "order" | "meeting" | "event" | "none";
  summary: string | null;
  // order fields
  retailer?: string | null;
  itemName?: string | null;
  orderNumber?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  expectedDate?: string | null;
  orderTotal?: string | null;
  orderUrl?: string | null;
  status?: "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null;
  // meeting fields
  eventTitle?: string | null;
  proposedDate?: string | null;
  proposedStartTime?: string | null;
  proposedEndTime?: string | null;
  location?: string | null;
  description?: string | null;
  // event fields
  eventDate?: string | null;
  organizer?: string | null;
  organizerEmail?: string | null;
}

async function classifyEmail(
  from: string,
  subject: string,
  date: string,
  body: string,
): Promise<ClassifiedEmail | null> {
  const today = new Date().toISOString().split("T")[0];
  const truncated = body.slice(0, 3000);

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}
Date: ${date}

Body:
${truncated}

Classify this email and extract relevant details. Return ONLY valid JSON:

{
  "type": "order" | "meeting" | "event" | "none",
  "summary": "one actionable sentence for the recipient, or null",

  // Include if type="order" — shipping/order/delivery emails:
  "retailer": exact retailer name or null,
  "itemName": specific product name (never just "your order") or null,
  "orderNumber": string or null,
  "trackingNumber": carrier tracking number or null,
  "carrier": "UPS" | "FedEx" | "USPS" | "DHL" | null,
  "expectedDate": "YYYY-MM-DD" or null,
  "orderTotal": "$XX.XX" or null,
  "orderUrl": tracking/order URL or null,
  "status": "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null,

  // Include if type="meeting" — someone personally requesting a meeting/call/appointment:
  "eventTitle": meeting name or null,
  "proposedDate": "YYYY-MM-DD" or null,
  "proposedStartTime": "HH:MM" (24h) or null,
  "proposedEndTime": "HH:MM" (24h) or null,
  "location": location or null,
  "description": brief description or null,
  "organizer": sender display name or null,
  "organizerEmail": sender email or null,

  // Include if type="event" — invitation to a group event/party/conference:
  "eventTitle": event name or null,
  "eventDate": "YYYY-MM-DD" or null,
  "organizer": organizer name or null
}

Rules:
- type="order": order/shipping/delivery emails from retailers or carriers
- type="meeting": someone personally requesting to schedule a 1:1 or small-group meeting, call, or appointment
- type="event": invitation to attend an event (party, conference, webinar, save-the-date) not yet on calendar
- type="none": newsletters, promotions, auto-notifications, marketing, unsubscribe offers, anything not actionable`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ClassifiedEmail;
    if (!parsed.type || parsed.type === "none") return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Claude classification failed");
    return null;
  }
}

// ── Order handler ─────────────────────────────────────────────────────────────

const NOTIFY_STATUSES = new Set(["out_for_delivery", "delivered"]);

async function handleOrder(userName: string, msgId: string, result: ClassifiedEmail): Promise<void> {
  if (!result.retailer || !result.itemName) return;

  const existing = await getOrders(userName);
  const existingByTracking = new Map(
    existing.filter((o) => o.tracking_number).map((o) => [o.tracking_number!, o.status])
  );
  const prevStatus = result.trackingNumber
    ? existingByTracking.get(result.trackingNumber) ?? null
    : null;

  await upsertOrder(userName, {
    retailer: result.retailer,
    item_name: result.itemName,
    order_number: result.orderNumber ?? null,
    tracking_number: result.trackingNumber ?? null,
    carrier: result.carrier ?? null,
    status: result.status ?? "ordered",
    expected_date: result.expectedDate ?? null,
    order_total: result.orderTotal ?? null,
    order_url: result.orderUrl ?? null,
  });

  const newStatus = result.status ?? "ordered";
  const statusChanged = prevStatus !== null && prevStatus !== newStatus;
  if (statusChanged && NOTIFY_STATUSES.has(newStatus)) {
    const label = newStatus === "delivered" ? "Delivered" : "Out for delivery";
    await sendPushToAll(
      { title: "Package Update", body: `${label}: ${result.itemName} from ${result.retailer}`, tag: "order-update" },
      userName,
    );
    logger.info({ tracking: result.trackingNumber, prevStatus, newStatus }, "[BgEmailScanner] Order push sent");
  }
  logger.info({ retailer: result.retailer, item: result.itemName, status: newStatus }, "[BgEmailScanner] Order upserted");
}

// ── Meeting handler ───────────────────────────────────────────────────────────

function isTomorrowOrSooner(proposedDate: string | null | undefined): boolean {
  if (!proposedDate) return false;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: TZ });
  return proposedDate <= tomorrowStr;
}

async function handleMeeting(userName: string, msgId: string, result: ClassifiedEmail): Promise<void> {
  const organizer = result.organizer ?? "Someone";
  const existing = getPendingMeetingRequests();
  const existingIds = new Set(existing.map((m) => m.gmailId));
  if (existingIds.has(msgId)) return;

  const newRequest: DetectedMeetingRequest = {
    gmailId: msgId,
    gmailThreadId: msgId,
    from: organizer,
    fromEmail: result.organizerEmail ?? "",
    subject: result.eventTitle ?? "Meeting request",
    proposedDateTimeStr: result.proposedDate
      ? `${result.proposedDate}${result.proposedStartTime ? " " + result.proposedStartTime : ""}`
      : null,
    isOpenEnded: !result.proposedDate,
    calendarStatus: "unknown",
    conflictEvent: null,
    suggestedAlternative: null,
  };

  setPendingMeetingRequests([...existing, newRequest]);

  if (isTomorrowOrSooner(result.proposedDate)) {
    const when = result.proposedDate
      ? `${result.proposedDate}${result.proposedStartTime ? " at " + result.proposedStartTime : ""}`
      : "soon";
    await sendPushToAll(
      { title: "Meeting Request Needs Response", body: `${organizer} wants to meet ${when}`, tag: "meeting-request" },
      userName,
    );
    logger.info({ organizer, date: result.proposedDate }, "[BgEmailScanner] Meeting push sent");
  }
  logger.info({ organizer, date: result.proposedDate }, "[BgEmailScanner] Meeting queued");
}

// ── Event handler ─────────────────────────────────────────────────────────────

async function isEventOnCalendar(userName: string, title: string, date: string | null): Promise<boolean> {
  try {
    const auth = await getAuthClientForUser(userName);
    if (!auth) return false;
    const calendar = google.calendar({ version: "v3", auth });
    const timeMin = date
      ? new Date(new Date(date + "T00:00:00").getTime() - 86400000).toISOString()
      : new Date().toISOString();
    const timeMax = date
      ? new Date(new Date(date + "T00:00:00").getTime() + 2 * 86400000).toISOString()
      : new Date(Date.now() + 90 * 86400000).toISOString();
    const resp = await calendar.events.list({
      calendarId: "primary", q: title, timeMin, timeMax, maxResults: 5, singleEvents: true,
    });
    return (resp.data.items?.length ?? 0) > 0;
  } catch { return false; }
}

async function handleEvent(userName: string, msgId: string, result: ClassifiedEmail): Promise<void> {
  const title = result.eventTitle;
  if (!title) return;

  const alreadyOnCalendar = await isEventOnCalendar(userName, title, result.eventDate ?? null);
  if (alreadyOnCalendar) {
    logger.info({ title }, "[BgEmailScanner] Event already on calendar, skipping");
    return;
  }

  const dateStr = result.eventDate ? ` on ${result.eventDate}` : "";
  const org = result.organizer ? ` — from ${result.organizer}` : "";
  await sendPushToAll(
    { title: "Event Invitation", body: `${title}${dateStr}${org}`, tag: "event-invite" },
    userName,
  );
  logger.info({ title, date: result.eventDate }, "[BgEmailScanner] Event invite push sent");
}

// ── Main unified scan ─────────────────────────────────────────────────────────

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

  logger.info({ userName, since: since.toISOString() }, "[BgEmailScanner] Starting unified scan");

  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[BgEmailScanner] No auth client");
    return;
  }
  try { await auth.getAccessToken(); } catch {
    logger.warn({ userName }, "[BgEmailScanner] Token refresh failed");
    return;
  }

  const gmail = google.gmail({ version: "v1", auth });
  const q = buildUnifiedQuery(since);

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 30, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Gmail list failed");
    return;
  }

  if (messageIds.length === 0) {
    logger.info({ userName }, "[BgEmailScanner] No candidate emails");
    _lastScanAt.set(userName, scanStart);
    return;
  }

  logger.info({ userName, count: messageIds.length }, "[BgEmailScanner] Candidate emails found");

  let orders = 0, meetings = 0, events = 0, skipped = 0;

  for (const msgId of messageIds.slice(0, 20)) {
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
      const headers = detail.data.payload?.headers ?? [];
      const getH = (n: string) =>
        headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const from = getH("From");
      const subject = getH("Subject");
      const date = getH("Date");

      let body = extractBody((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 30) { skipped++; continue; }

      const result = await classifyEmail(from, subject, date, body);
      if (!result) { skipped++; continue; }

      if (result.type === "order") {
        await handleOrder(userName, msgId, result);
        orders++;
      } else if (result.type === "meeting") {
        await handleMeeting(userName, msgId, result);
        meetings++;
      } else if (result.type === "event") {
        await handleEvent(userName, msgId, result);
        events++;
      }
    } catch (err) {
      logger.warn({ err, msgId }, "[BgEmailScanner] Failed to process email");
      skipped++;
    }
  }

  _lastScanAt.set(userName, scanStart);
  logger.info({ userName, orders, meetings, events, skipped }, "[BgEmailScanner] Unified scan complete");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startBackgroundEmailScanner(userName = NATIVE_USER): void {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runScan(userName);
    } catch (err) {
      logger.error({ err }, "[BgEmailScanner] Unhandled error in scan");
    }
  }, { timezone: TZ });

  logger.info("[BgEmailScanner] Scheduler started — unified Claude scan, 60-minute interval");
}
