import { Router, type IRouter } from "express";
import { authenticate } from "../auth/middleware.js";
import { scanEmailsForDrafts, sendGmailReply } from "../email/draftScanner.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

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
