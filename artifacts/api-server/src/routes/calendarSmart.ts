import { Router, type IRouter } from "express";
import express from "express";
import { authenticate } from "../auth/middleware.js";
import {
  scanEmailsForMeetings,
  acceptMeetingRequest,
  declineMeetingRequest,
  type MeetingRequest,
} from "../email/meetingScanner.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── GET /api/calendar/smart ───────────────────────────────────────────────────
// Scans recent emails for meeting requests and checks Google Calendar for conflicts.
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

// ── POST /api/calendar/smart/accept ──────────────────────────────────────────
// Adds event to Google Calendar and sends an acceptance reply.
// Body: { meeting: MeetingRequest }
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
    req.log.info(
      { userName, emailId: meeting.emailId, calendarEventId: result.calendarEventId, replySent: result.replySent },
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
// Sends a decline reply.
// Body: { meeting: MeetingRequest, customMessage?: string }
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
