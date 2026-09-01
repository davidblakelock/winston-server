import { Router, type IRouter } from "express";
import { authenticate } from "../auth/middleware.js";
import { scanEmailsForDrafts, sendGmailReply } from "../email/draftScanner.js";
import { getTriageSession } from "../email/emailTriageSession.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── GET /api/email/triage/current ─────────────────────────────────────────────
// The check_email flow pushes its digest and each card exclusively over SSE
// (broadcastToUser, fire-and-forget, no replay) — confirmed live as a real
// gap: react-native-sse's XHR-based transport reconnects roughly every 5
// seconds on Android even for a nominally persistent stream (server-side
// logs show the connection completing and re-registering on that cadence
// continuously, not just around app launch), and any broadcast landing in
// one of those reconnect windows has nowhere to go and is silently,
// permanently lost. Confirmed live: a 7-email triage stalled after 2 cards
// with no error on either side — the server had already advanced and sent
// card 3, the client just never received it.
//
// This endpoint gives the client a way to ask "what should I be showing
// right now" independent of whether any individual SSE push actually
// arrived — the same "SSE is a fast path, REST is the source of truth"
// pattern chat already uses (chat_sync + loadHistory). The client re-syncs
// against this on every SSE reconnect, which — since reconnects happen
// constantly regardless of this fix — turns the reconnect churn from a loss
// point into a self-healing catch-up point instead.
router.get("/email/triage/current", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const session = getTriageSession(userName);
  if (!session) {
    res.json({ active: false });
    return;
  }

  const email = session.emails[session.currentIndex];
  if (!email) {
    res.json({ active: false });
    return;
  }

  res.json({
    active: true,
    gmailId: email.gmailId,
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    index: session.currentIndex + 1,
    total: session.emails.length,
  });
});

// ── GET /api/email/drafts ─────────────────────────────────────────────────────
// Scans inbox for emails older than 24 hours that need a reply.
// Returns each with Claude's suggested draft.
router.get("/email/drafts", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  try {
    const drafts = await scanEmailsForDrafts(userName);
    req.log.info({ userName, count: drafts.length }, "[EmailDrafts] Scan complete");
    res.json({ drafts });
  } catch (err) {
    req.log.error({ err }, "[EmailDrafts] GET /email/drafts error");
    res.status(500).json({ error: "Failed to scan emails for drafts" });
  }
});

// ── POST /api/email/drafts/send ───────────────────────────────────────────────
// Sends a reply to an email. Body: { emailId, toEmail, subject, body }
// Requires gmail.send OAuth scope — will fail gracefully if not granted.
router.post("/email/drafts/send", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;

  const { emailId, toEmail, subject, body } = req.body as {
    emailId?: string;
    toEmail?: string;
    subject?: string;
    body?: string;
  };

  if (!emailId || !toEmail || !subject || !body) {
    res.status(400).json({ error: "emailId, toEmail, subject, and body are required" });
    return;
  }

  try {
    const sent = await sendGmailReply(userName, emailId, toEmail, subject, body);
    if (!sent) {
      res.status(403).json({
        error: "Failed to send — gmail.send scope may not be granted. Reconnect Google in settings.",
        needsReconnect: true,
      });
      return;
    }
    req.log.info({ userName, toEmail, subject }, "[EmailDrafts] Reply sent");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "[EmailDrafts] POST /email/drafts/send error");
    res.status(500).json({ error: "Failed to send reply" });
  }
});

export default router;
