/**
 * Background Email Scanner
 *
 * Runs every 30 minutes. Silently scans Gmail for:
 *   1. Order confirmations / shipping updates → upsert into orders table
 *   2. Billing emails → detect anomalies (>10% spike) → push alert
 *   3. Meeting requests → store as pending → push if response needed before tomorrow
 *
 * Push notifications are sent ONLY for:
 *   - Package status change to out_for_delivery or delivered
 *   - Bill anomaly detected (charge >10% above average)
 *   - Meeting request that needs a response before tomorrow's briefing
 */

import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { scanOrderEmails } from "../orders/gmailOrderScanner.js";
import { upsertOrder, getOrders } from "../orders/ordersManager.js";
import { scanForBillAnomalies } from "../bills/billAnomalyScanner.js";
import { scanEmailsForMeetings } from "../email/meetingScanner.js";
import { setPendingMeetingRequests, getPendingMeetingRequests } from "../email/emailMeetingManager.js";
import { sendPushToAll } from "../push/pushManager.js";
import type { MeetingRequest } from "../email/meetingScanner.js";

const TZ = "America/Chicago";

// ── Last-scan timestamp (in-memory; resets on restart) ────────────────────────

let _lastScanAt: Date | null = null;

// ── Order status push logic ───────────────────────────────────────────────────

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

// ── Bill anomaly push logic ───────────────────────────────────────────────────

async function processBillEmails(userName: string): Promise<void> {
  try {
    const anomalies = await scanForBillAnomalies(userName, 2);
    if (anomalies.length === 0) return;

    for (const anomaly of anomalies) {
      const body = `${anomaly.retailer} billed $${anomaly.currentAmount.toFixed(2)} — ${anomaly.percentChange > 0 ? "+" : ""}${anomaly.percentChange.toFixed(0)}% vs. your usual $${anomaly.previousAmount.toFixed(2)}`;
      await sendPushToAll(
        { title: "Unusual Charge Detected", body, type: "bill-anomaly" },
        userName
      );
      logger.info({ retailer: anomaly.retailer, pct: anomaly.percentChange }, "[BgEmailScanner] Bill anomaly push sent");
    }
  } catch (err) {
    logger.warn({ err }, "[BgEmailScanner] Bill scan failed");
  }
}

// ── Meeting request push logic ────────────────────────────────────────────────

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

// ── Main scan tick ────────────────────────────────────────────────────────────

async function runScan(userName: string): Promise<void> {
  const since = _lastScanAt ?? new Date(Date.now() - 31 * 60 * 1000);
  const scanStart = new Date();

  logger.info({ userName, since: since.toISOString() }, "[BgEmailScanner] Starting scan");

  await Promise.allSettled([
    processOrderEmails(userName, since),
    processBillEmails(userName),
    processMeetingEmails(userName, since),
  ]);

  _lastScanAt = scanStart;
  logger.info({ userName }, "[BgEmailScanner] Scan complete");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startBackgroundEmailScanner(userName = NATIVE_USER): void {
  cron.schedule("*/30 * * * *", async () => {
    try {
      await runScan(userName);
    } catch (err) {
      logger.error({ err }, "[BgEmailScanner] Unhandled error in scan");
    }
  }, { timezone: TZ });

  logger.info("[BgEmailScanner] Scheduler started — scanning every 30 minutes");
}
