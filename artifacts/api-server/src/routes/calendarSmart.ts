import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  scanEmailsForMeetings,
  acceptMeetingRequest,
  declineMeetingRequest,
  type MeetingRequest,
} from "../email/meetingScanner.js";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── DB tables (idempotent) ─────────────────────────────────────────────────────

export async function ensureCalendarSmartTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS calendar_smart_settings (
      id                   integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      user_name            text NOT NULL UNIQUE,
      trusted_senders      jsonb NOT NULL DEFAULT '[]',
      blocked_times        jsonb NOT NULL DEFAULT '[]',
      default_response     text NOT NULL DEFAULT 'ask',
      updated_at           timestamptz DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS calendar_smart_log (
      id          integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      user_name   text NOT NULL,
      email_id    text NOT NULL,
      action      text NOT NULL,
      event_id    text,
      organizer   text,
      subject     text,
      created_at  timestamptz DEFAULT now()
    )
  `);

  logger.info("[CalendarSmart] Settings tables ready");
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface BlockedTime {
  day?: string;   // "monday", "tuesday", ... or omit for every day
  start: string;  // "HH:MM" 24h
  end: string;    // "HH:MM" 24h
}

interface CalendarSmartSettings {
  trusted_senders: string[];      // email addresses
  blocked_times: BlockedTime[];
  default_response: "ask" | "auto_if_free" | "fully_automatic";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSettings(userName: string): Promise<CalendarSmartSettings> {
  const { rows } = await query<{
    trusted_senders: string[];
    blocked_times: BlockedTime[];
    default_response: string;
  }>(
    `SELECT trusted_senders, blocked_times, default_response
     FROM calendar_smart_settings WHERE user_name = $1`,
    [userName]
  );
  if (!rows[0]) {
    return { trusted_senders: [], blocked_times: [], default_response: "ask" };
  }
  return {
    trusted_senders: rows[0].trusted_senders ?? [],
    blocked_times: rows[0].blocked_times ?? [],
    default_response: (rows[0].default_response as CalendarSmartSettings["default_response"]) ?? "ask",
  };
}

function isInBlockedTime(blocked_times: BlockedTime[], date: Date): boolean {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = days[date.getDay()];
  const hhMM = date.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  for (const bt of blocked_times) {
    if (bt.day && bt.day.toLowerCase() !== dayName) continue;
    if (hhMM >= bt.start && hhMM < bt.end) return true;
  }
  return false;
}

async function logAction(
  userName: string,
  emailId: string,
  action: string,
  eventId: string | null,
  organizer: string,
  subject: string
): Promise<void> {
  await query(
    `INSERT INTO calendar_smart_log (user_name, email_id, action, event_id, organizer, subject)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userName, emailId, action, eventId ?? null, organizer, subject]
  );
}

// ── GET /api/calendar/smart ───────────────────────────────────────────────────

router.get("/calendar/smart", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const sinceParam = req.query.since as string | undefined;
  const since = sinceParam ? new Date(sinceParam) : undefined;

  try {
    const meetings = await scanEmailsForMeetings(userName, since);
    req.log.info({ userName, count: meetings.length }, "[CalendarSmart] Scan complete");
    res.json({ meetings });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] GET /calendar/smart error");
    res.status(500).json({ error: "Failed to scan emails for meetings" });
  }
});

// ── GET /api/calendar/smart/settings ─────────────────────────────────────────

router.get("/calendar/smart/settings", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const settings = await getSettings(userName);
    res.json({ settings });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] GET /calendar/smart/settings error");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

// ── POST /api/calendar/smart/settings ────────────────────────────────────────
// Body: { trusted_senders?: string[], blocked_times?: BlockedTime[], default_response?: string }

router.post("/calendar/smart/settings", express.json({ limit: "256kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const {
    trusted_senders,
    blocked_times,
    default_response,
  } = req.body as Partial<CalendarSmartSettings>;

  const validDefaults = ["ask", "auto_if_free", "fully_automatic"];
  if (default_response && !validDefaults.includes(default_response)) {
    res.status(400).json({
      error: `default_response must be one of: ${validDefaults.join(", ")}`,
    });
    return;
  }

  try {
    const current = await getSettings(userName);
    const merged: CalendarSmartSettings = {
      trusted_senders: trusted_senders ?? current.trusted_senders,
      blocked_times: blocked_times ?? current.blocked_times,
      default_response: default_response ?? current.default_response,
    };

    await query(
      `INSERT INTO calendar_smart_settings (user_name, trusted_senders, blocked_times, default_response, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, now())
       ON CONFLICT (user_name)
       DO UPDATE SET
         trusted_senders  = EXCLUDED.trusted_senders,
         blocked_times    = EXCLUDED.blocked_times,
         default_response = EXCLUDED.default_response,
         updated_at       = now()`,
      [userName, JSON.stringify(merged.trusted_senders), JSON.stringify(merged.blocked_times), merged.default_response]
    );

    req.log.info({ userName, merged }, "[CalendarSmart] Settings updated");
    res.json({ ok: true, settings: merged });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] POST /calendar/smart/settings error");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ── POST /api/calendar/smart/auto-process ─────────────────────────────────────
// Scans recent emails and auto-accepts meetings based on settings.
// Returns summary of actions taken (for use in morning briefing).

router.post("/calendar/smart/auto-process", express.json({ limit: "256kb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const sinceParam = (req.body as { since?: string }).since;
  const since = sinceParam ? new Date(sinceParam) : undefined;

  try {
    const [meetings, settings] = await Promise.all([
      scanEmailsForMeetings(userName, since),
      getSettings(userName),
    ]);

    if (settings.default_response === "ask") {
      res.json({ processed: 0, message: "Auto-processing is disabled — default_response is 'ask'", actions: [] });
      return;
    }

    const actions: Array<{
      emailId: string;
      organizer: string;
      subject: string;
      action: "auto_accepted" | "skipped_conflict" | "skipped_blocked" | "skipped_untrusted";
      calendarEventId?: string;
    }> = [];

    for (const m of meetings) {
      const isTrusted =
        settings.trusted_senders.length === 0 ||
        settings.trusted_senders.some(
          (s) => s.toLowerCase() === m.organizerEmail.toLowerCase()
        );

      if (!isTrusted && settings.default_response !== "fully_automatic") {
        actions.push({ emailId: m.emailId, organizer: m.organizer, subject: m.subject, action: "skipped_untrusted" });
        continue;
      }

      if (m.hasConflict) {
        actions.push({ emailId: m.emailId, organizer: m.organizer, subject: m.subject, action: "skipped_conflict" });
        continue;
      }

      // Check blocked times
      if (m.proposedDate && m.proposedStartTime) {
        const proposedDt = new Date(`${m.proposedDate}T${m.proposedStartTime}:00-06:00`);
        if (isInBlockedTime(settings.blocked_times, proposedDt)) {
          actions.push({ emailId: m.emailId, organizer: m.organizer, subject: m.subject, action: "skipped_blocked" });
          continue;
        }
      }

      // Auto-accept
      try {
        const meetingRequest: MeetingRequest = {
          emailId: m.emailId,
          organizer: m.organizer,
          organizerEmail: m.organizerEmail,
          subject: m.subject,
          emailDate: m.emailDate,
          eventTitle: m.eventTitle,
          proposedDate: m.proposedDate,
          proposedStartTime: m.proposedStartTime,
          proposedEndTime: m.proposedEndTime,
          location: m.location,
          description: m.description,
          hasConflict: m.hasConflict,
          conflictingEvent: m.conflictingEvent,
          suggestedResponse: m.suggestedResponse,
        };
        const result = await acceptMeetingRequest(userName, meetingRequest);
        await logAction(userName, m.emailId, "auto_accepted", result.calendarEventId ?? null, m.organizer, m.subject);
        actions.push({
          emailId: m.emailId,
          organizer: m.organizer,
          subject: m.subject,
          action: "auto_accepted",
          calendarEventId: result.calendarEventId ?? undefined,
        });
        req.log.info({ emailId: m.emailId, organizer: m.organizer }, "[CalendarSmart] Auto-accepted meeting");
      } catch (acceptErr) {
        req.log.warn({ acceptErr, emailId: m.emailId }, "[CalendarSmart] Auto-accept failed for meeting");
      }
    }

    const accepted = actions.filter((a) => a.action === "auto_accepted");
    res.json({
      processed: meetings.length,
      autoAccepted: accepted.length,
      actions,
      briefingSummary:
        accepted.length > 0
          ? accepted.map((a) => `I accepted a meeting request from ${a.organizer} — "${a.subject}" — on your behalf.`).join(" ")
          : null,
    });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] POST /calendar/smart/auto-process error");
    res.status(500).json({ error: "Failed to auto-process meetings" });
  }
});

// ── GET /api/calendar/smart/log ───────────────────────────────────────────────

router.get("/calendar/smart/log", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const limitParam = parseInt(req.query.limit as string ?? "20", 10);
  const limit = Math.min(Math.max(1, limitParam), 100);

  try {
    const { rows } = await query(
      `SELECT * FROM calendar_smart_log WHERE user_name = $1 ORDER BY created_at DESC LIMIT $2`,
      [userName, limit]
    );
    res.json({ log: rows, count: rows.length });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] GET /calendar/smart/log error");
    res.status(500).json({ error: "Failed to get log" });
  }
});

// ── POST /api/calendar/smart/accept ──────────────────────────────────────────

router.post("/calendar/smart/accept", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { meeting } = req.body as { meeting?: MeetingRequest };
  if (!meeting || !meeting.emailId) {
    res.status(400).json({ error: "meeting object with emailId is required" });
    return;
  }

  try {
    const result = await acceptMeetingRequest(userName, meeting);
    await logAction(userName, meeting.emailId, "accepted", result.calendarEventId ?? null, meeting.organizer, meeting.subject);
    req.log.info(
      { userName, emailId: meeting.emailId, calendarEventId: result.calendarEventId },
      "[CalendarSmart] Meeting accepted",
    );
    res.json({
      ok: true,
      calendarEventId: result.calendarEventId,
      replySent: result.replySent,
      note: result.replySent
        ? "Event added to calendar and reply sent."
        : result.calendarEventId
          ? "Event added to calendar. Reply not sent — reconnect Google with gmail.send scope to enable replies."
          : "Calendar not updated (no date/time found in email). Reply not sent.",
    });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] POST /calendar/smart/accept error");
    res.status(500).json({ error: "Failed to accept meeting" });
  }
});

// ── POST /api/calendar/smart/decline ─────────────────────────────────────────

router.post("/calendar/smart/decline", express.json({ limit: "1mb" }), async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { meeting, customMessage } = req.body as {
    meeting?: MeetingRequest;
    customMessage?: string;
  };

  if (!meeting || !meeting.emailId) {
    res.status(400).json({ error: "meeting object with emailId is required" });
    return;
  }

  try {
    const result = await declineMeetingRequest(userName, meeting, customMessage);
    await logAction(userName, meeting.emailId, "declined", null, meeting.organizer, meeting.subject);
    req.log.info(
      { userName, emailId: meeting.emailId, replySent: result.replySent },
      "[CalendarSmart] Meeting declined",
    );
    res.json({
      ok: true,
      replySent: result.replySent,
      note: result.replySent
        ? "Decline reply sent."
        : "Reply not sent — reconnect Google with gmail.send scope to enable replies.",
    });
  } catch (err) {
    req.log.error({ err }, "[CalendarSmart] POST /calendar/smart/decline error");
    res.status(500).json({ error: "Failed to decline meeting" });
  }
});

export default router;
