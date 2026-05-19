/**
 * Background Email Scanner — Unified Claude Classification
 *
 * Two separate Gmail queries per scan:
 *   1. ORDER scan  — broad query, no inbox restriction (orders land in Promotions/Updates),
 *                    up to 50 candidates, processes up to 40. email_id passed for dedup.
 *                    Aftership tracking registered immediately on discovery.
 *   2. SOCIAL scan — meetings + events, inbox only, up to 30 candidates, processes up to 20.
 *
 * Claude Haiku classifies + extracts each email in a single call.
 * Last-scan timestamp is persisted to DB (order_sync_state) so restarts don't re-process.
 */

import cron from "node-cron";
import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import {
  upsertOrder,
  getOrders,
  getLastOrderScanAt,
  updateLastOrderScanAt,
} from "../orders/ordersManager.js";
import { trackOrder, isAfterShipEnabled } from "../orders/aftershipTracker.js";
import { setPendingMeetingRequests, getPendingMeetingRequests } from "../email/emailMeetingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { MODEL_HAIKU } from "../lib/models.js";
import type { DetectedMeetingRequest } from "../email/emailMeetingManager.js";

const TZ = "America/Chicago";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Social scan in-memory last-scan (meetings/events only) ────────────────────
// Orders use DB-backed getLastOrderScanAt / updateLastOrderScanAt.

const _socialLastScanAt = new Map<string, Date>();
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

// ── Gmail query builders ──────────────────────────────────────────────────────

// No `in:inbox` — order/shipping emails land in Promotions, Updates, or the
// dedicated Orders tab. Restricting to inbox silently drops nearly everything.
const ORDER_SUBJECT_KEYWORDS = [
  "order confirmation", "your order", "has shipped", "out for delivery",
  "delivered", "shipment notification", "shipping confirmation", "order shipped",
  "package delivered", "your package", "order update", "tracking number",
  "order receipt", "purchase confirmation", "payment confirmed",
];

function buildOrderQuery(since: Date): string {
  const clauses = ORDER_SUBJECT_KEYWORDS.map((k) => `subject:"${k}"`).join(" OR ");
  return `(${clauses}) -in:spam -in:trash -from:me after:${Math.floor(since.getTime() / 1000)}`;
}

const SOCIAL_SUBJECT_KEYWORDS = [
  "meeting", "meet", "call", "invite", "invitation", "calendar",
  "schedule", "zoom", "teams", "google meet", "webex", "are you free",
  "can we talk", "set up a time", "calendly",
  "you're invited", "you have been invited", "event invitation",
  "has invited you", "invited you to", "cordially invited",
  "join us for", "save the date",
];

function buildSocialQuery(since: Date): string {
  const clauses = SOCIAL_SUBJECT_KEYWORDS.map((k) => `subject:"${k}"`).join(" OR ");
  return `in:inbox -in:spam -in:trash -from:me (${clauses}) after:${Math.floor(since.getTime() / 1000)}`;
}

// ── Claude Haiku: classify + extract in one call ──────────────────────────────

interface ClassifiedEmail {
  type: "order" | "meeting" | "event" | "none";
  summary: string | null;
  // passed through so handlers can use it as a fallback label
  _subject?: string;
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
    // Stamp the original subject so handlers can use it as a fallback label
    parsed._subject = subject;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Claude classification failed");
    return null;
  }
}

// ── Order handler ─────────────────────────────────────────────────────────────

const NOTIFY_STATUSES = new Set(["out_for_delivery", "delivered"]);

async function handleOrder(userName: string, msgId: string, result: ClassifiedEmail): Promise<void> {
  // retailer is the minimum viable field — drop only if it's missing.
  // itemName falls back to the email subject so vague "Your order has shipped" emails
  // still get recorded rather than silently dropped.
  if (!result.retailer) {
    logger.info({ msgId, subject: result._subject }, "[BgEmailScanner] Order dropped — no retailer extracted");
    return;
  }
  const itemName = result.itemName || result._subject || "Order";

  // Fetch current orders to detect status changes for push notifications
  const existing = await getOrders(userName);
  const existingByTracking = new Map(
    existing.filter((o) => o.tracking_number).map((o) => [o.tracking_number!, o.status])
  );
  const prevStatus = result.trackingNumber
    ? existingByTracking.get(result.trackingNumber) ?? null
    : null;

  // email_id is critical — it drives ON CONFLICT deduplication in the DB
  const saved = await upsertOrder(userName, {
    retailer: result.retailer,
    item_name: itemName,
    order_number: result.orderNumber ?? null,
    tracking_number: result.trackingNumber ?? null,
    carrier: result.carrier ?? null,
    status: result.status ?? "ordered",
    expected_date: result.expectedDate ?? null,
    order_total: result.orderTotal ?? null,
    email_id: msgId,
    order_url: result.orderUrl ?? null,
  });

  logger.info(
    { retailer: result.retailer, item: itemName, status: result.status ?? "ordered", msgId },
    "[BgEmailScanner] Order upserted"
  );

  // Register with Aftership immediately so the tracking scheduler can start polling
  if (saved && result.trackingNumber && isAfterShipEnabled()) {
    trackOrder(result.trackingNumber, null, result.carrier)
      .then((trackResult) => {
        if (trackResult) {
          logger.info(
            { orderId: saved.id, trackingNumber: result.trackingNumber, status: trackResult.status },
            "[BgEmailScanner] Aftership registration + initial track successful"
          );
        }
      })
      .catch((err) => {
        logger.warn({ err, trackingNumber: result.trackingNumber }, "[BgEmailScanner] Aftership registration failed");
      });
  }

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

// ── Shared email fetch helper ─────────────────────────────────────────────────

async function fetchAndClassify(
  gmail: ReturnType<typeof google.gmail>,
  q: string,
  maxFetch: number,
  maxProcess: number,
  userName: string,
  handler: (userName: string, msgId: string, result: ClassifiedEmail) => Promise<void>,
  label: string,
): Promise<{ processed: number; skipped: number }> {
  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: maxFetch, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err, label }, "[BgEmailScanner] Gmail list failed");
    return { processed: 0, skipped: 0 };
  }

  if (messageIds.length === 0) {
    logger.info({ userName, label }, "[BgEmailScanner] No candidate emails");
    return { processed: 0, skipped: 0 };
  }

  logger.info({ userName, label, count: messageIds.length }, "[BgEmailScanner] Candidate emails found");

  let processed = 0;
  let skipped = 0;

  for (const msgId of messageIds.slice(0, maxProcess)) {
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

      await handler(userName, msgId, result);
      processed++;
    } catch (err) {
      logger.warn({ err, msgId, label }, "[BgEmailScanner] Failed to process email");
      skipped++;
    }
  }

  return { processed, skipped };
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function runScan(userName: string): Promise<void> {
  // ── Orders: use DB-backed last-scan time ──────────────────────────────────
  const lastOrderScan = await getLastOrderScanAt(userName);
  const orderSinceMs = lastOrderScan ? Date.now() - lastOrderScan.getTime() : Infinity;
  const shouldScanOrders = orderSinceMs >= SCAN_INTERVAL_MS;

  // ── Social (meetings/events): in-memory ───────────────────────────────────
  const lastSocialScan = _socialLastScanAt.get(userName);
  const socialSinceMs = lastSocialScan ? Date.now() - lastSocialScan.getTime() : Infinity;
  const shouldScanSocial = socialSinceMs >= SCAN_INTERVAL_MS;

  if (!shouldScanOrders && !shouldScanSocial) {
    const nextInMin = Math.ceil((SCAN_INTERVAL_MS - Math.min(orderSinceMs, socialSinceMs)) / 60_000);
    logger.info({ userName, nextInMin }, "[BgEmailScanner] Skipping tick — not yet time");
    return;
  }

  const scanStart = new Date();

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

  // ── Order scan ────────────────────────────────────────────────────────────
  if (shouldScanOrders) {
    // If no orders have ever been found for this user, always look back 30 days —
    // even if last_scan_at exists (it may have been set before auth was working).
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const existingOrders = await getOrders(userName);
    // Only treat as "has real orders" if at least one has a tracking number.
    const hasTrackedOrders = existingOrders.some((o) => !!o.tracking_number);
    const since = hasTrackedOrders ? (lastOrderScan ?? thirtyDaysAgo) : thirtyDaysAgo;
    logger.info({ userName, since: since.toISOString(), hasTrackedOrders }, "[BgEmailScanner] Starting order scan");

    const orderQ = buildOrderQuery(since);
    const { processed: orders, skipped: orderSkipped } = await fetchAndClassify(
      gmail, orderQ, 50, 40, userName,
      async (u, id, res) => {
        if (res.type === "order") await handleOrder(u, id, res);
      },
      "orders"
    );

    await updateLastOrderScanAt(userName);
    logger.info({ userName, orders, skipped: orderSkipped }, "[BgEmailScanner] Order scan complete");
  }

  // ── Social scan ───────────────────────────────────────────────────────────
  if (shouldScanSocial) {
    const since = lastSocialScan ?? new Date(Date.now() - SCAN_INTERVAL_MS);
    logger.info({ userName, since: since.toISOString() }, "[BgEmailScanner] Starting social scan");

    const socialQ = buildSocialQuery(since);
    let meetings = 0, events = 0, skipped = 0;

    const { processed, skipped: socialSkipped } = await fetchAndClassify(
      gmail, socialQ, 30, 20, userName,
      async (u, id, res) => {
        if (res.type === "meeting") { await handleMeeting(u, id, res); meetings++; }
        else if (res.type === "event") { await handleEvent(u, id, res); events++; }
      },
      "social"
    );
    skipped = socialSkipped;

    _socialLastScanAt.set(userName, scanStart);
    logger.info({ userName, meetings, events, skipped }, "[BgEmailScanner] Social scan complete");
  }
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

  logger.info("[BgEmailScanner] Scheduler started — order scan (DB-backed) + social scan (in-memory), 60-min interval");
}
