/**
 * Background Email Scanner — Unified Claude Classification
 *
 * Cron ticks every 15 min; each user's own configured interval_minutes
 * (user_email_scan_settings) gates how often the actual scan work runs:
 *   1. SOCIAL scan — all unread inbox emails, up to 30 candidates, processes up to 20.
 *                    Keyword-free — classifyEmail handles filtering. Covers meetings,
 *                    records (My Records), orders/shipping (My Orders), replies, and
 *                    alerts from a SINGLE Gmail read + classification per email — orders
 *                    used to have their own separate scanner reading this exact same
 *                    is:unread query independently, which meant an order email's
 *                    read-status was a race between whichever scanner processed it
 *                    first. Folded into one pass so there's only one read.
 *   2. Reservation/confirmation scan (scanReservationEmails) — trip and vehicle
 *                    registration confirmations saved to user_records. Kept separate:
 *                    it deliberately does NOT scope to is:unread (dedups by gmail_id
 *                    instead), a different query shape that isn't part of the same race.
 *
 * Claude Haiku classifies + extracts each email in a single call.
 * Social scan's last-scan timestamp is persisted to DB (social_scan_state) so
 * restarts don't re-process.
 *
 * The manual "sync my orders" button (POST /api/orders/sync) does its own
 * separate on-demand pass (orders/gmailOrderScanner.ts's scanOrdersOnly) —
 * that one's intentional, a user-triggered immediate check rather than
 * waiting for the next scheduled tick, and reuses the same classifier and
 * the same order-writing logic (handleOrderResult) as this scan does.
 */

import cron from "node-cron";
import { google } from "googleapis";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { setPendingMeetingRequests, getPendingMeetingRequests, addPendingReplyEmails, getPendingReplyEmails, clearPendingReplyEmail } from "../email/emailMeetingManager.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { classifyEmail } from "../email/emailClassifier.js";
import type { ClassifiedEmail } from "../email/emailClassifier.js";
import type { DetectedMeetingRequest } from "../email/emailMeetingManager.js";
import { insertUserRecord, getLastSocialScanAt, updateLastSocialScanAt } from "../records/recordsManager.js";
import { getEmailScanSettings } from "../email/emailScanSettings.js";
import { scanReservationEmails } from "./reservationScanner.js";
import { checkForConflict, addOneHour } from "../email/meetingScanner.js";
import { query } from "../db.js";
import { handleOrderResult } from "../orders/gmailOrderScanner.js";

const TZ = "UTC";

// Social scan last-scan is DB-backed via social_scan_state.
// Previously in-memory, which caused re-insertion of the same emails after every restart.

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

// Strips only <style> and <script> block noise. Every other tag — including
// <a href="...">tracking link</a> — is left intact; Claude reads the raw
// markup itself. Mirrors stripNoiseTags() in orders/gmailOrderScanner.ts.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Gmail query builders ──────────────────────────────────────────────────────

function buildSocialQuery(): string {
  // No subject keyword filter — meeting/records/reply emails often have plain subjects
  // like "Lunch?" or "Hey". classifyEmail handles the filtering.
  return `in:inbox is:unread -in:spam -in:trash -from:me`;
}

// ── Sender display name helper ────────────────────────────────────────────────

function senderDisplayName(from: string): string {
  const m = from.match(/^(.*?)\s*<[^>]+>$/);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "") || from;
  return from.split("@")[0] ?? from;
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
    gmailId: msgId,
  });
  logger.info({ vendor: rec.vendorName, category: rec.category, msgId }, "[BgEmailScanner] Record saved");
}

// ── Order handler ─────────────────────────────────────────────────────────────
// Folded in from the old standalone gmailOrderScanner.ts scan — that scanner
// ran its own separate is:unread Gmail read + Claude classification on the
// exact same candidate mail this social scan already reads, meaning an order
// email could get marked read by whichever scanner processed it first, race
// depending on order. One pass, one classification per email, no race.

async function handleOrder(userName: string, msgId: string, from: string, subject: string, result: ClassifiedEmail): Promise<void> {
  const order = result.order;
  if (!order) {
    logger.info({ msgId, subject: result._subject }, "[BgEmailScanner] Order dropped — no order fields extracted");
    return;
  }
  const created = await handleOrderResult(userName, msgId, from, subject, order);
  logger.info(
    { msgId, subject: result._subject, retailer: order.retailer, created },
    created ? "[BgEmailScanner] Order saved" : "[BgEmailScanner] Order classified but not written — see handleOrderResult log above for why"
  );
}

// ── Meeting handler ───────────────────────────────────────────────────────────

async function handleMeeting(
  userName: string,
  msgId: string,
  from: string,
  subject: string,
  result: ClassifiedEmail,
  confirmedMeetings: { from: string; subject: string; proposedDateTimeStr: string | null }[],
): Promise<void> {
  // Parse organizer name and email from the raw From header — used by both paths
  const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/);
  const organizerName = fromMatch
    ? fromMatch[1].trim().replace(/^["']|["']$/g, "") || senderDisplayName(from)
    : senderDisplayName(from);
  const organizerEmail = fromMatch ? fromMatch[2].trim() : from.trim();

  if (result.meeting?.isConfirmation) {
    confirmedMeetings.push({ from: organizerName, subject, proposedDateTimeStr: result.meeting.proposedDateTimeStr ?? null });
    logger.info({ from: organizerName, proposedDateTimeStr: result.meeting.proposedDateTimeStr }, "[BgEmailScanner] Meeting confirmation noted");
    return;
  }

  const existing = getPendingMeetingRequests(userName);
  const existingIds = new Set(existing.map((m) => m.gmailId));
  if (existingIds.has(msgId)) return;

  const meeting = result.meeting;
  const proposedDateOnly  = meeting?.proposedDateTimeStr?.split(" ")[0] ?? null;
  const proposedStartTime = meeting?.proposedDateTimeStr?.split(" ")[1] ?? null;

  let alreadyScheduled = false;
  let conflictingEventName: string | null = null;
  if (proposedDateOnly && proposedStartTime) {
    const conflict = await checkForConflict(userName, proposedDateOnly, proposedStartTime, addOneHour(proposedStartTime));
    alreadyScheduled = conflict.hasConflict;
    conflictingEventName = conflict.conflictingEvent;
  }
  if (alreadyScheduled) {
    logger.info({ organizer: organizerName, proposedDateTimeStr: meeting?.proposedDateTimeStr, conflictingEvent: conflictingEventName }, "[BgEmailScanner] Meeting already on calendar — skipping pending");
    return;
  }

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

  setPendingMeetingRequests(userName, [...existing, newRequest]);
  logger.info({ organizer: organizerName, proposedDateTimeStr: meeting?.proposedDateTimeStr }, "[BgEmailScanner] Meeting queued");
}

// ── Social handler ────────────────────────────────────────────────────────────

async function handleSocial(userName: string, msgId: string, from: string, result: ClassifiedEmail): Promise<void> {
  const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/);
  const displayName = fromMatch
    ? fromMatch[1].trim().replace(/^["']|["']$/g, "") || senderDisplayName(from)
    : senderDisplayName(from);
  const fromEmail = fromMatch ? fromMatch[2].trim() : from.trim();

  addPendingReplyEmails(userName, [{
    gmailId: msgId,
    from: displayName,
    fromEmail,
    subject: result._subject ?? "Email",
    summary: result.summary ?? null,
    scannedAt: Date.now(),
  }]);

  logger.info({ from: displayName, msgId }, "[BgEmailScanner] Added to pending reply emails");
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
  const { intervalMinutes, vacationMode, pauseHour } = await getEmailScanSettings(userName).catch(() => ({
    intervalMinutes: 120,
    vacationMode: false,
    pauseHour: 22,
  }));
  const intervalMs = intervalMinutes * 60 * 1000;

  // ── Read user timezone + wake time for pause-window check ─────────────────
  let userTz = TZ;
  let wakeHour = 7;
  try {
    const { rows: profileRows } = await query<{ timezone: string | null; wake_time: string | null }>(
      `SELECT timezone, wake_time FROM user_profiles WHERE user_name = $1 LIMIT 1`,
      [userName]
    );
    if (profileRows[0]?.timezone) userTz = profileRows[0].timezone;
    if (profileRows[0]?.wake_time) {
      const parsed = parseInt(profileRows[0].wake_time.split(":")[0] ?? "7", 10);
      if (!isNaN(parsed)) wakeHour = parsed;
    }
  } catch { /* use defaults */ }

  // FUTURE: replace this static pause-hour check with Android DND/Bedtime mode detection once that native permission flow is built
  const nowHour = parseInt(
    new Date().toLocaleString("en-US", { timeZone: userTz, hour: "numeric", hour12: false }),
    10
  );
  if (nowHour >= pauseHour || nowHour < wakeHour) {
    logger.info({ userName, nowHour, pauseHour, wakeHour }, "[BgEmailScanner] Skipping tick — outside scan window");
    return;
  }

  // ── Social (meetings/records/replies): DB-backed ─────────────────────────
  // Gated purely on elapsed time since the last scan — a prior version also
  // required currentMinute to land exactly on a multiple of intervalMinutes
  // (e.g. :00/:30 for a 30-min interval), which sounds harmless but isn't:
  // the outer cron tick doesn't fire at the literal top of the minute (it's
  // often a few seconds in), so "exactly 30 minutes elapsed" frequently
  // lands at 29:59 — just under the threshold. That single missed tick then
  // had to wait for the NEXT aligned minute, silently doubling the real
  // interval to a full hour. Confirmed live in production logs: scans that
  // should have run every 30 min were actually landing 60 min apart,
  // consistently. Elapsed-time alone is correct on its own and can't drift
  // this way — worst case it's late by less than one tick period (15 min).
  const lastSocialScan = await getLastSocialScanAt(userName);
  const lastScan = lastSocialScan?.getTime() ?? 0;
  const shouldScanSocial = Date.now() - lastScan >= intervalMs;

  if (!shouldScanSocial) {
    logger.info({ userName, intervalMinutes }, "[BgEmailScanner] Skipping tick — already ran in this window");
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

  // ── Auto-clear pending replies/meetings that are no longer unread or were deleted ──
  const pendingReplies = getPendingReplyEmails(userName);
  for (const item of pendingReplies) {
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: item.gmailId, format: "minimal" });
      const isUnread = detail.data.labelIds?.includes("UNREAD") ?? false;
      if (!isUnread) {
        clearPendingReplyEmail(userName, item.gmailId);
        logger.info({ gmailId: item.gmailId }, "[BgEmailScanner] Auto-cleared pending reply — no longer unread");
      }
    } catch (err) {
      // Message lookup failed — likely deleted entirely. Clear it; nothing to act on anymore.
      clearPendingReplyEmail(userName, item.gmailId);
      logger.info({ gmailId: item.gmailId }, "[BgEmailScanner] Auto-cleared pending reply — message no longer exists");
    }
  }

  const pendingMeetings = getPendingMeetingRequests(userName);
  const stillValidMeetings: DetectedMeetingRequest[] = [];
  for (const meeting of pendingMeetings) {
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: meeting.gmailId, format: "minimal" });
      const isUnread = detail.data.labelIds?.includes("UNREAD") ?? false;
      if (isUnread) stillValidMeetings.push(meeting);
      else logger.info({ gmailId: meeting.gmailId }, "[BgEmailScanner] Auto-cleared pending meeting — no longer unread");
    } catch {
      logger.info({ gmailId: meeting.gmailId }, "[BgEmailScanner] Auto-cleared pending meeting — message no longer exists");
    }
  }
  if (stillValidMeetings.length !== pendingMeetings.length) {
    setPendingMeetingRequests(userName, stillValidMeetings);
  }

  let filedRecordsCount = 0;
  const urgentAlerts: { subject: string; summary: string; gmailId: string }[] = [];
  const fyiItems: { subject: string; summary: string; gmailId: string }[] = [];
  const confirmedMeetings: { from: string; subject: string; proposedDateTimeStr: string | null }[] = [];
  let meetings = 0, records = 0, socials = 0, orders = 0;

  // ── Social scan ───────────────────────────────────────────────────────────
  // One Gmail read + one classification per email, covering meetings,
  // records, orders, replies, and alerts together — previously orders had
  // their own separate scanner reading this exact same is:unread query
  // independently, meaning an order email's read-status was a race between
  // whichever scanner got to it first. Folding order detection into this
  // same pass (handleOrder, via the classifier's existing save_to_orders
  // action) removes that race entirely: there's only one read now.
  if (shouldScanSocial) {
    logger.info({ userName }, "[BgEmailScanner] Starting social scan");

    const socialQ = buildSocialQuery();

    const { skipped: socialSkipped } = await fetchAndClassify(
      gmail, socialQ, 30, 20, userName,
      async (u, id, from, subject, body, res) => {
        if (res.action === "meeting_request") { await handleMeeting(u, id, from, subject, res, confirmedMeetings); meetings++; }
        else if (res.action === "save_to_records") { await handleRecord(u, id, body, res); records++; filedRecordsCount++; }
        else if (res.action === "save_to_orders") { await handleOrder(u, id, from, subject, res); orders++; }
        else if (res.action === "needs_reply") { await handleSocial(u, id, from, res); socials++; }
        else if (res.action === "urgent_alert") { urgentAlerts.push({ subject, summary: res.summary ?? subject, gmailId: id }); }
        else if (res.action === "fyi") { fyiItems.push({ subject, summary: res.summary ?? subject, gmailId: id }); }
      },
      "social",
      vacationMode,
    );

    await updateLastSocialScanAt(userName, scanStart);
    logger.info({ userName, meetings, records, orders, socials, skipped: socialSkipped }, "[BgEmailScanner] Social scan complete");
  }

  // ── Reservation / confirmation scan ──────────────────────────────────────
  // Runs on the same schedule as the social scan — scans for flight, hotel,
  // restaurant, car rental, warranty, subscription, and home service
  // confirmations and saves them to user_records (My Records screen). Kept
  // separate: this one deliberately does NOT scope to is:unread (dedups by
  // gmail_id instead), a different query shape from the social/order scan
  // above, so it isn't part of the same race and doesn't fold in cleanly.
  if (shouldScanSocial) {
    try {
      const reservations = await scanReservationEmails(userName);
      if (reservations.length > 0) {
        filedRecordsCount += reservations.length;
        logger.info(
          { userName, count: reservations.length },
          "[ReservationScanner] Confirmation records saved"
        );
      }
    } catch (err) {
      logger.warn({ err, userName }, "[ReservationScanner] Scan failed — skipping");
    }
  }

  // ── Batch summary push ────────────────────────────────────────────────────
  const scanReplies = getPendingReplyEmails(userName);
  const scanMeetings = getPendingMeetingRequests(userName);
  logger.info(
    { userName, pendingRepliesCount: scanReplies.length, pendingMeetingsCount: scanMeetings.length, filedRecordsCount, urgentAlertCount: urgentAlerts.length, fyiCount: fyiItems.length, confirmedMeetingsCount: confirmedMeetings.length },
    "[BgEmailScanner] Pending state before summary"
  );

  // Exclude already-notified emails from count and notification
  const { rows: alreadyNotified } = await query<{ email_id: string }>(
    `SELECT email_id FROM email_scan_log WHERE user_name = $1`,
    [userName]
  ).catch(() => ({ rows: [] as { email_id: string }[] }));
  const notifiedIds = new Set(alreadyNotified.map(r => r.email_id));

  const newUrgentAlerts = urgentAlerts.filter(e => !notifiedIds.has(e.gmailId));
  const newFyiItems = fyiItems.filter(e => !notifiedIds.has(e.gmailId));
  const totalEmails = meetings + records + orders + socials + newUrgentAlerts.length + newFyiItems.length + confirmedMeetings.length;
  const actionableCount = scanReplies.length + scanMeetings.length + urgentAlerts.length;

  // Vacation mode's whole premise is "only notify me if it's genuinely
  // urgent" — but until now this only nudged the classifier's judgment on
  // what to flag; it had zero effect on whether a notification actually
  // fired. Records/orders/meetings/socials still got processed and saved
  // as normal (that's correct — vacation mode shouldn't stop capturing a
  // flight confirmation), they just never used to gate the push itself.
  // Gate it here on the classifier's own "urgent" category specifically,
  // matching what the setting is described as doing.
  const shouldNotify = vacationMode ? newUrgentAlerts.length > 0 : totalEmails > 0;

  if (totalEmails > 0) {
    if (shouldNotify) {
      const title = `📬 ${totalEmails} new email${totalEmails === 1 ? "" : "s"}`;
      const body = actionableCount > 0 ? `${actionableCount} might need your attention` : "Nothing urgent";
      const hasActionable = actionableCount > 0;
      await sendFcmNotification({
        userName,
        notificationType: "email-scan",
        title,
        body,
        data: {
          action: "send_message",
          message: "Check my email",
          hasActionable: String(hasActionable),
          ...(hasActionable ? { pushCategoryId: "email-action" } : {}),
        },
      });
      logger.info({ userName, totalEmails, actionableCount }, "[BgEmailScanner] Email scan push sent");
    } else {
      logger.info({ userName, totalEmails, vacationMode }, "[BgEmailScanner] Push suppressed — vacation mode, nothing urgent");
    }

    // Log processed email IDs regardless of whether a notification fired —
    // this is dedup bookkeeping, not a notification record. Without this,
    // vacation-mode-suppressed non-urgent emails would never get logged and
    // would be re-fetched and re-classified on every scan (every 30 min)
    // indefinitely, until an urgent email finally triggers a notification.
    const newIds = [...newUrgentAlerts, ...newFyiItems]
      .map(e => e.gmailId)
      .filter(Boolean);

    if (newIds.length > 0) {
      await Promise.all(newIds.map(id =>
        query(
          `INSERT INTO email_scan_log (user_name, email_id, tier, surfaced_at)
           VALUES ($1, $2, 1, NOW())
           ON CONFLICT DO NOTHING`,
          [userName, id]
        ).catch(() => {})
      ));
      logger.info({ count: newIds.length }, "[BgEmailScanner] Logged processed email IDs");
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startBackgroundEmailScanner(userName = NATIVE_USER): void {
  let _running = false;
  cron.schedule("*/15 * * * *", async () => {
    if (_running) {
      logger.info("[BgEmailScanner] Skipping tick — previous scan still running");
      return;
    }
    _running = true;
    try {
      await runScan(userName);
    } catch (err) {
      logger.error({ err }, "[BgEmailScanner] Unhandled error in scan");
    } finally {
      _running = false;
    }
  }, { timezone: TZ });

  logger.info("[BgEmailScanner] Scheduler started — unified social/records/orders scan (DB-backed, single is:unread pass) + separate reservation scan, per-user configured interval");
}
