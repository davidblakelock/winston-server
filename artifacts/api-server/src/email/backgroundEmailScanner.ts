/**
 * Background Email Scanner — Unified Claude Classification
 *
 * Two separate Gmail queries per scan:
 *   1. ORDER scan  — broad query, no inbox restriction (orders land in Promotions/Updates),
 *                    up to 50 candidates, processes up to 40. email_id passed for dedup.
 *   2. SOCIAL scan — all unread inbox emails, up to 30 candidates, processes up to 20.
 *                    Keyword-free — classifyEmail handles filtering.
 *
 * Claude Haiku classifies + extracts each email in a single call.
 * Last-scan timestamp is persisted to DB (order_sync_state) so restarts don't re-process.
 */

import cron from "node-cron";
import { google } from "googleapis";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import {
  upsertOrder,
  getOrders,
  getLastOrderScanAt,
  updateLastOrderScanAt,
} from "../orders/ordersManager.js";
import { setPendingMeetingRequests, getPendingMeetingRequests } from "../email/emailMeetingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import { classifyEmail } from "../email/emailClassifier.js";
import type { ClassifiedEmail } from "../email/emailClassifier.js";
import type { DetectedMeetingRequest } from "../email/emailMeetingManager.js";
import { insertUserRecord } from "../records/recordsManager.js";
import { getEmailScanSettings } from "../email/emailScanSettings.js";

const TZ = "America/Chicago";

// ── Social scan in-memory last-scan ──────────────────────────────────────────
// Orders use DB-backed getLastOrderScanAt / updateLastOrderScanAt.

const _socialLastScanAt = new Map<string, Date>();

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

function buildSocialQuery(since: Date): string {
  // No subject keyword filter — meeting/records/reply emails often have plain subjects
  // like "Lunch?" or "Hey". classifyEmail handles the filtering.
  return `in:inbox is:unread -in:spam -in:trash -from:me after:${Math.floor(since.getTime() / 1000)}`;
}

// ── Sender display name helper ────────────────────────────────────────────────

function senderDisplayName(from: string): string {
  const m = from.match(/^(.*?)\s*<[^>]+>$/);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "") || from;
  return from.split("@")[0] ?? from;
}

// ── Order handler ─────────────────────────────────────────────────────────────

const NOTIFY_STATUSES = new Set(["out_for_delivery", "delivered"]);

async function handleOrder(userName: string, msgId: string, result: ClassifiedEmail): Promise<void> {
  const order = result.order;
  if (!order?.retailer) {
    logger.info({ msgId, subject: result._subject }, "[BgEmailScanner] Order dropped — no retailer extracted");
    return;
  }
  const itemName = order.itemName || result._subject || "Order";

  // Fetch current orders to detect status changes for push notifications
  const existing = await getOrders(userName);
  const existingByTracking = new Map(
    existing.filter((o) => o.tracking_number).map((o) => [o.tracking_number!, o.status])
  );
  const prevStatus = order.trackingNumber
    ? existingByTracking.get(order.trackingNumber) ?? null
    : null;

  // email_id is critical — it drives ON CONFLICT deduplication in the DB
  await upsertOrder(userName, {
    retailer: order.retailer,
    item_name: itemName,
    order_number: order.orderNumber ?? null,
    tracking_number: order.trackingNumber ?? null,
    carrier: order.carrier ?? null,
    status: order.status ?? "ordered",
    expected_date: order.expectedDate ?? null,
    order_total: order.orderTotal ?? null,
    email_id: msgId,
    order_url: order.orderUrl ?? null,
  });

  logger.info(
    { retailer: order.retailer, item: itemName, status: order.status ?? "ordered", msgId },
    "[BgEmailScanner] Order upserted"
  );

  const newStatus = order.status ?? "ordered";
  const statusChanged = prevStatus !== null && prevStatus !== newStatus;
  if (statusChanged && NOTIFY_STATUSES.has(newStatus)) {
    const label = newStatus === "delivered" ? "Delivered" : "Out for delivery";
    await sendPushToAll(
      { title: "Package Update", body: `${label}: ${order.itemName} from ${order.retailer}`, tag: "order-update" },
      userName,
    );
    logger.info({ tracking: order.trackingNumber, prevStatus, newStatus }, "[BgEmailScanner] Order push sent");
  }
}

// ── Record handler ────────────────────────────────────────────────────────────

async function handleRecord(userName: string, msgId: string, body: string, result: ClassifiedEmail): Promise<void> {
  const rec = result.record;
  if (!rec) {
    logger.info({ msgId, subject: result._subject }, "[BgEmailScanner] Record dropped — no record fields extracted");
    return;
  }
  await insertUserRecord(userName, {
    category: rec.category,
    vendorName: rec.vendorName,
    confirmationNumber: rec.confirmationNumber,
    dateStart: rec.dateStart,
    dateEnd: rec.dateEnd,
    time: rec.time,
    address: rec.address,
    phone: rec.phone,
    website: rec.website,
    amount: rec.amount,
    notes: result.summary ?? null,
    rawSnippet: body.slice(0, 500),
  });
  logger.info({ vendor: rec.vendorName, category: rec.category, msgId }, "[BgEmailScanner] Record saved");
}

// ── Meeting handler ───────────────────────────────────────────────────────────

async function isAlreadyOnCalendar(userName: string, title: string, date: string | null): Promise<boolean> {
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

function isTomorrowOrSooner(proposedDate: string | null | undefined): boolean {
  if (!proposedDate) return false;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: TZ });
  return proposedDate <= tomorrowStr;
}

async function handleMeeting(
  userName: string,
  msgId: string,
  from: string,
  subject: string,
  result: ClassifiedEmail,
): Promise<void> {
  const existing = getPendingMeetingRequests();
  const existingIds = new Set(existing.map((m) => m.gmailId));
  if (existingIds.has(msgId)) return;

  // Parse organizer name and email from the raw From header
  const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/);
  const organizerName = fromMatch
    ? fromMatch[1].trim().replace(/^["']|["']$/g, "") || senderDisplayName(from)
    : senderDisplayName(from);
  const organizerEmail = fromMatch ? fromMatch[2].trim() : from.trim();

  const meeting = result.meeting;
  // proposedDateTimeStr is "YYYY-MM-DD HH:MM" — extract date portion for the soon-check
  const proposedDateOnly = meeting?.proposedDateTimeStr?.split(" ")[0] ?? null;

  const newRequest: DetectedMeetingRequest = {
    gmailId: msgId,
    gmailThreadId: msgId,
    from: organizerName,
    fromEmail: organizerEmail,
    subject,
    proposedDateTimeStr: meeting?.proposedDateTimeStr ?? null,
    isOpenEnded: meeting?.isOpenEnded ?? true,
    calendarStatus: "unknown",
    conflictEvent: null,
    suggestedAlternative: null,
  };

  setPendingMeetingRequests([...existing, newRequest]);

  if (isTomorrowOrSooner(proposedDateOnly)) {
    const alreadyScheduled = await isAlreadyOnCalendar(userName, subject, proposedDateOnly);
    if (alreadyScheduled) {
      logger.info({ organizer: organizerName, proposedDateTimeStr: meeting?.proposedDateTimeStr }, "[BgEmailScanner] Meeting already on calendar, skipping push");
    } else {
      const when = meeting?.proposedDateTimeStr ?? "soon";
      await sendPushToAll(
        { title: "Meeting Request Needs Response", body: `${organizerName} wants to meet ${when}`, tag: "meeting-request" },
        userName,
      );
      logger.info({ organizer: organizerName, proposedDateTimeStr: meeting?.proposedDateTimeStr }, "[BgEmailScanner] Meeting push sent");
    }
  }
  logger.info({ organizer: organizerName, proposedDateTimeStr: meeting?.proposedDateTimeStr }, "[BgEmailScanner] Meeting queued");
}

// ── Social handler ────────────────────────────────────────────────────────────

async function handleSocial(userName: string, msgId: string, from: string, result: ClassifiedEmail): Promise<void> {
  const displayName = senderDisplayName(from);
  const body = result.summary ?? result._subject ?? "Personal email";
  await sendPushToAll(
    { title: `Email from ${displayName}`, body, tag: "email-social", notificationType: "email-actionable" },
    userName,
  );
  logger.info({ from: displayName, msgId }, "[BgEmailScanner] Social email push sent");
}

// ── Shared email fetch helper ─────────────────────────────────────────────────

async function fetchAndClassify(
  gmail: ReturnType<typeof google.gmail>,
  q: string,
  maxFetch: number,
  maxProcess: number,
  userName: string,
  handler: (userName: string, msgId: string, from: string, subject: string, body: string, result: ClassifiedEmail) => Promise<void>,
  label: string,
  vacationMode = false,
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

      let body = extractBody((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 30) { skipped++; continue; }

      const result = await classifyEmail(from, subject, body, vacationMode);
      if (!result) { skipped++; continue; }

      await handler(userName, msgId, from, subject, body, result);
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
  // ── Read per-user settings ────────────────────────────────────────────────
  const { intervalMinutes, vacationMode } = await getEmailScanSettings(userName).catch(() => ({
    intervalMinutes: 120,
    vacationMode: false,
  }));
  const intervalMs = intervalMinutes * 60 * 1000;

  // ── Orders: use DB-backed last-scan time ──────────────────────────────────
  const lastOrderScan = await getLastOrderScanAt(userName);
  const orderSinceMs = lastOrderScan ? Date.now() - lastOrderScan.getTime() : Infinity;
  const shouldScanOrders = orderSinceMs >= intervalMs;

  // ── Social (meetings/records/replies): in-memory ──────────────────────────
  const lastSocialScan = _socialLastScanAt.get(userName);
  const socialSinceMs = lastSocialScan ? Date.now() - lastSocialScan.getTime() : Infinity;
  const shouldScanSocial = socialSinceMs >= intervalMs;

  if (!shouldScanOrders && !shouldScanSocial) {
    const nextInMin = Math.ceil((intervalMs - Math.min(orderSinceMs, socialSinceMs)) / 60_000);
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
      async (u, id, _from, _subject, body, res) => {
        if (res.action === "save_to_orders") await handleOrder(u, id, res);
        else if (res.action === "save_to_records") await handleRecord(u, id, body, res);
      },
      "orders",
      vacationMode,
    );

    await updateLastOrderScanAt(userName);
    logger.info({ userName, orders, skipped: orderSkipped }, "[BgEmailScanner] Order scan complete");
  }

  // ── Social scan ───────────────────────────────────────────────────────────
  if (shouldScanSocial) {
    const since = lastSocialScan ?? new Date(Date.now() - intervalMs);
    logger.info({ userName, since: since.toISOString() }, "[BgEmailScanner] Starting social scan");

    const socialQ = buildSocialQuery(since);
    let meetings = 0, records = 0, socials = 0;

    const { skipped: socialSkipped } = await fetchAndClassify(
      gmail, socialQ, 30, 20, userName,
      async (u, id, from, subject, body, res) => {
        if (res.action === "meeting_request") { await handleMeeting(u, id, from, subject, res); meetings++; }
        else if (res.action === "save_to_records") { await handleRecord(u, id, body, res); records++; }
        else if (res.action === "needs_reply") { await handleSocial(u, id, from, res); socials++; }
      },
      "social",
      vacationMode,
    );

    _socialLastScanAt.set(userName, scanStart);
    logger.info({ userName, meetings, records, socials, skipped: socialSkipped }, "[BgEmailScanner] Social scan complete");
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
