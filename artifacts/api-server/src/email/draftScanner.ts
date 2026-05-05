import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Gmail helpers ─────────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBodyFromPayload(payload: GmailPart): string {
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s{2,}/g, " ").trim();
}

function extractEmailAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1].toLowerCase() : raw.toLowerCase();
}

// ── Heuristic pre-filter — skip newsletters, notifications, noreply ───────────

const SKIP_FROM_PATTERNS = [
  /no.?reply/i, /noreply/i, /donotreply/i, /do-not-reply/i,
  /newsletter/i, /notifications?@/i, /alerts?@/i, /updates?@/i,
  /support@/i, /help@/i, /info@/i, /hello@/i, /marketing@/i,
  /unsubscribe/i, /mailchimp/i, /sendgrid/i, /constantcontact/i,
];

const SKIP_SUBJECT_PATTERNS = [
  /\b(unsubscribe|newsletter|weekly digest|daily digest|your receipt|order confirmation|shipping|delivery|invoice #|statement|automated|do not reply)\b/i,
];

function isSkippable(fromEmail: string, subject: string): boolean {
  return SKIP_FROM_PATTERNS.some((p) => p.test(fromEmail)) ||
    SKIP_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

// ── Claude Haiku: needs-reply + draft ─────────────────────────────────────────

export interface EmailDraft {
  emailId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  emailDate: string;
  originalSummary: string;
  suggestedReply: string;
}

interface HaikuDraftResult {
  needsReply: boolean;
  reason: string | null;
  originalSummary: string;
  suggestedReply: string | null;
}

async function analyzeAndDraft(
  from: string,
  subject: string,
  body: string,
  emailDate: string,
): Promise<HaikuDraftResult | null> {
  const truncated = body.slice(0, 4000);
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const prompt = `You are David Blake Lock's AI assistant reviewing his inbox. Today is ${today}.

Analyze this email and determine if David needs to reply. Return ONLY valid JSON.

From: ${from}
Subject: ${subject}
Date: ${emailDate}

Body:
${truncated}

Return JSON:
{
  "needsReply": true | false,
  "reason": "one-sentence reason why reply is needed, or null if not",
  "originalSummary": "1-2 sentence summary of what the email says",
  "suggestedReply": "a warm, brief, professional reply draft from David's perspective — or null if needsReply is false"
}

Emails that need a reply:
- Direct questions addressed to David
- Meeting/call requests
- Follow-ups awaiting David's response
- Action items requested from David
- Personal emails from real people (not services)

Emails that do NOT need a reply:
- Marketing emails, newsletters, promotions
- Automated notifications, receipts, shipping updates
- CC'd emails where David is not the primary recipient
- Emails that are clearly FYI only
- Anything from a no-reply address`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as HaikuDraftResult;
  } catch (err) {
    logger.warn({ err }, "[DraftScanner] Claude analysis failed");
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export async function scanEmailsForDrafts(
  userName: string,
  maxResults = 30,
): Promise<EmailDraft[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[DraftScanner] No auth client — Google not connected");
    return [];
  }
  try { await auth.getAccessToken(); } catch {
    logger.warn({ userName }, "[DraftScanner] Token refresh failed");
    return [];
  }

  const gmail = google.gmail({ version: "v1", auth });

  // Emails older than 24 hours that are unread, in inbox, from real people
  const twentyFourHoursAgoEpoch = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const q = `in:inbox is:unread before:${Math.floor(Date.now() / 1000)} after:${twentyFourHoursAgoEpoch - 30 * 24 * 60 * 60} -from:me -category:promotions -category:updates`;

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[DraftScanner] Gmail list failed");
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[DraftScanner] Candidate emails found");

  const drafts: EmailDraft[] = [];

  for (const msgId of messageIds.slice(0, 20)) {
    try {
      const detail = await gmail.users.messages.get({
        userId: "me", id: msgId, format: "full",
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (n: string) =>
        headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const date = getHeader("Date");
      const fromEmail = extractEmailAddress(from);

      if (isSkippable(fromEmail, subject)) continue;

      let body = extractBodyFromPayload((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 30) continue;

      const result = await analyzeAndDraft(from, subject, body, date);
      if (!result || !result.needsReply || !result.suggestedReply) continue;

      const displayName = from.match(/^(.*?)\s*</) ?
        from.match(/^(.*?)\s*</)![1].trim().replace(/^"|"$/g, "") : from;

      drafts.push({
        emailId: msgId,
        sender: displayName,
        senderEmail: fromEmail,
        subject,
        emailDate: date,
        originalSummary: result.originalSummary,
        suggestedReply: result.suggestedReply,
      });

      logger.info({ emailId: msgId, sender: displayName, subject }, "[DraftScanner] Draft generated");
    } catch (err) {
      logger.warn({ err, msgId }, "[DraftScanner] Failed to process email");
    }
  }

  return drafts;
}

// ── Gmail send helper (requires gmail.send scope) ─────────────────────────────

export async function sendGmailReply(
  userName: string,
  originalEmailId: string,
  toEmail: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) return false;
  try { await auth.getAccessToken(); } catch { return false; }

  const gmail = google.gmail({ version: "v1", auth });

  // Get threadId for proper threading
  let threadId: string | undefined;
  try {
    const detail = await gmail.users.messages.get({ userId: "me", id: originalEmailId, format: "minimal" });
    threadId = detail.data.threadId ?? undefined;
  } catch { /* proceed without threading */ }

  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const rawMessage = [
    `To: ${toEmail}`,
    `Subject: ${replySubject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join("\r\n");

  const encoded = Buffer.from(rawMessage).toString("base64url");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId },
    });
    logger.info({ userName, toEmail, subject }, "[DraftScanner] Reply sent");
    return true;
  } catch (err) {
    logger.warn({ err, toEmail }, "[DraftScanner] Send failed — gmail.send scope may not be granted");
    return false;
  }
}
