/**
 * Calendar-Email Intelligence Scheduler
 *
 * Every 30 minutes during waking hours (6 AM – 10 PM user-local time):
 *   1. Fetch calendar events for the next 48 hours that have attendees.
 *   2. Search Gmail for emails from those attendees received in the last ~35 min.
 *   3. Filter out automated/newsletter senders.
 *   4. For each real match not yet notified, send a push:
 *        "New email from Sarah — you have a call with her tomorrow at 10am.
 *         Might be worth a read before then."
 *   5. Record the email ID so the same email is never notified twice.
 */

import cron from "node-cron";
import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import { fetchWeekEvents, type CalendarEvent } from "../google/calendar.js";
import { sendFcmNotification } from "./fcmSender.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { getActiveUsers, type ActiveUser } from "../onboarding/onboardingManager.js";

// ── In-memory dedup (fast path, reset on restart) ────────────────────────────
// Key format: `${userName}:${gmailMsgId}`
const notifiedThisSession = new Set<string>();

// ── Automated-sender filters ──────────────────────────────────────────────────

const AUTOMATED_EMAIL_RE = [
  /no.?reply/i, /noreply/i, /do.not.reply/i, /notifications?@/i,
  /updates?@/i, /alerts?@/i, /mailer[-+]?@/i, /bounce@/i,
  /auto(mated)?@/i, /system@/i, /robot@/i, /daemon@/i,
  /postmaster@/i, /newsletter@/i,
];

const AUTOMATED_SUBJECT_RE = [
  /unsubscribe/i, /newsletter/i, /\[automated\]/i, /\[no.?reply\]/i,
  /order\s+confirm/i, /your\s+(order|purchase|subscription|account)/i,
  /payment\s+(received|confirm)/i, /invoice\s+#/i, /\breceipt\b/i,
  /automatic(ally)?\s+generated/i, /do\s+not\s+reply/i, /\bdigest\b/i,
  /weekly\s+summary/i, /daily\s+report/i,
];

function isAutomated(fromEmail: string, subject: string): boolean {
  if (AUTOMATED_EMAIL_RE.some((p) => p.test(fromEmail))) return true;
  if (AUTOMATED_SUBJECT_RE.some((p) => p.test(subject))) return true;
  return false;
}

function extractEmail(raw: string): string {
  return (raw.match(/<([^>]+)>/) ?? [])[1]?.toLowerCase() ?? raw.toLowerCase().trim();
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}

// ── Waking-hours gate ─────────────────────────────────────────────────────────

function isWakingHours(user: ActiveUser): boolean {
  const tz = user.timezone ?? "America/Chicago";
  const local = new Date().toLocaleTimeString("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const h = parseInt(local.split(":")[0], 10);
  return h >= 6 && h < 22;
}

// ── Event-time description ────────────────────────────────────────────────────

function describeEventTime(event: CalendarEvent, tz: string): string {
  if (!event.startIso) return "soon";
  const now = new Date();
  const eventStart = new Date(event.startIso);
  const diffMs = eventStart.getTime() - now.getTime();
  if (diffMs <= 0) return "soon";

  const timeStr = eventStart.toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
  const eventDay = eventStart.toLocaleDateString("en-CA", { timeZone: tz });
  const today    = now.toLocaleDateString("en-CA", { timeZone: tz });
  const tomorrow = new Date(now.getTime() + 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });

  if (eventDay === today) {
    const diffH = diffMs / 3_600_000;
    if (diffH < 1) return `in about ${Math.max(1, Math.round(diffH * 60))} minutes`;
    if (diffH < 2) return `in about an hour`;
    return `later today at ${timeStr}`;
  }
  if (eventDay === tomorrow) return `tomorrow at ${timeStr}`;
  const dayName = eventStart.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  return `on ${dayName} at ${timeStr}`;
}

// ── Dedup helpers ─────────────────────────────────────────────────────────────

function sessionKey(userName: string, msgId: string): string {
  return `${userName}:${msgId}`;
}

/** Returns true if we should skip this email (already notified). */
async function alreadyNotified(userName: string, msgId: string): Promise<boolean> {
  if (notifiedThisSession.has(sessionKey(userName, msgId))) return true;
  const { rows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM proactive_message_log
     WHERE user_name = $1 AND message_type = $2`,
    [userName, `cal-email-intel:${msgId}`],
  );
  return parseInt(rows[0]?.cnt ?? "0", 10) > 0;
}

async function recordNotified(userName: string, msgId: string): Promise<void> {
  notifiedThisSession.add(sessionKey(userName, msgId));
  await query(
    `INSERT INTO proactive_message_log (user_name, message_type, sent_date)
     VALUES ($1, $2, CURRENT_DATE)
     ON CONFLICT (user_name, message_type, sent_date) DO NOTHING`,
    [userName, `cal-email-intel:${msgId}`],
  ).catch((err) =>
    logger.warn({ err, userName, msgId }, "[CalEmailSched] Failed to persist dedup record"),
  );
}

// ── Core per-user check ───────────────────────────────────────────────────────

async function checkUserCalendarEmail(user: ActiveUser): Promise<void> {
  const { userName } = user;
  const tz = user.timezone ?? "America/Chicago";

  // ── 1. Calendar events for the next 48 hours with attendees ─────────────────
  const allEvents = await fetchWeekEvents(false, userName).catch(() => null);
  if (!allEvents || allEvents.length === 0) return;

  const now = new Date();
  const fortyEightHoursLater = new Date(now.getTime() + 48 * 3_600_000);

  const upcomingWithAttendees = allEvents.filter((e) => {
    if (e.allDay || !e.startIso) return false;
    const start = new Date(e.startIso);
    if (start <= now || start > fortyEightHoursLater) return false;
    return (e.attendees?.length ?? 0) > 0;
  });

  if (upcomingWithAttendees.length === 0) return;

  // ── 2. Build attendee email → event map ──────────────────────────────────────
  // attendeeEmail (lowercase) → earliest upcoming event with that attendee
  const attendeeMap = new Map<string, { event: CalendarEvent; attendeeName: string }>();
  for (const event of upcomingWithAttendees) {
    for (const att of event.attendees ?? []) {
      if (!att.email) continue;
      const key = att.email.toLowerCase();
      if (!attendeeMap.has(key)) {
        attendeeMap.set(key, { event, attendeeName: att.name ?? att.email.split("@")[0] });
      }
    }
  }
  if (attendeeMap.size === 0) return;

  // ── 3. Gmail search: emails from attendees in the last ~35 min ───────────────
  const auth = await getAuthClientForUser(userName).catch(() => null);
  if (!auth) return;

  const gmail = google.gmail({ version: "v1", auth });

  // Refresh token before searching
  const tokenOk = await auth.getAccessToken().catch(() => null);
  if (!tokenOk?.token) return;

  // Gmail `after:` takes epoch seconds — use 35-min window to safely overlap
  const windowSec = Math.floor((Date.now() - 35 * 60 * 1000) / 1000);

  // Cap at 10 email addresses to keep the query manageable
  const attendeeEmails = [...attendeeMap.keys()].slice(0, 10);
  const fromClause = attendeeEmails.map((e) => `from:${e}`).join(" OR ");
  const q = [
    `(${fromClause})`,
    `after:${windowSec}`,
    "-from:me",
    "-category:promotions",
    "-category:updates",
    "-category:social",
    "-category:forums",
  ].join(" ");

  const list = await gmail.users.messages.list({ userId: "me", maxResults: 10, q }).catch(() => null);
  const messages = list?.data.messages ?? [];
  if (messages.length === 0) return;

  // ── 4. Process each match ─────────────────────────────────────────────────────
  for (const msg of messages) {
    if (!msg.id) continue;

    // Fast dedup check (in-memory first)
    if (notifiedThisSession.has(sessionKey(userName, msg.id))) continue;

    // Fetch metadata
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject"],
    }).catch(() => null);
    if (!detail?.data) continue;

    const hdrs = detail.data.payload?.headers ?? [];
    const hdr = (name: string) =>
      stripQuotes(
        hdrs.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
      );

    const rawFrom = hdr("From");
    const fromEmail = extractEmail(rawFrom);
    const subject = hdr("Subject") || "(no subject)";

    // Skip automated
    if (isAutomated(fromEmail, subject)) continue;

    // Match to attendee
    const match = attendeeMap.get(fromEmail);
    if (!match) continue;

    // DB dedup check
    if (await alreadyNotified(userName, msg.id)) continue;

    // ── 5. Send the push ──────────────────────────────────────────────────────
    const { event, attendeeName } = match;
    const timeDesc = describeEventTime(event, tz);
    const title = `New email from ${attendeeName}`;
    const body = `You have ${event.summary} with ${attendeeName} ${timeDesc}. Might be worth a read before then.`;

    logger.info(
      { userName, attendeeName, subject, eventSummary: event.summary, timeDesc },
      "[CalEmailSched] Sending calendar-email-intel push",
    );

    await sendFcmNotification({
      userName,
      notificationType: "calendar-email-intel",
      title,
      body,
      data: { action: "send_message", message: "Check my email" },
    }).catch((err) =>
      logger.warn({ err, userName, msgId: msg.id }, "[CalEmailSched] Push send failed"),
    );

    await recordNotified(userName, msg.id);
  }
}

// ── Scheduler export ──────────────────────────────────────────────────────────

export function startCalendarEmailScheduler(): void {
  let _running = false;

  // Every 30 minutes — waking-hours gate applied inside per-user check
  cron.schedule("*/30 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      const users = await getActiveUsers();
      const wakingUsers = users.filter(isWakingHours);
      if (wakingUsers.length === 0) return;
      await Promise.allSettled(wakingUsers.map(checkUserCalendarEmail));
    } catch (err) {
      logger.warn({ err }, "[CalEmailSched] Scheduler tick failed");
    } finally {
      _running = false;
    }
  });

  logger.info("[CalEmailSched] Scheduler started — calendar-email intelligence, every 30 min, 6 AM–10 PM");
}
