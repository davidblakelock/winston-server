import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { createTracker } from "./easypostManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Subject-line filter ────────────────────────────────────────────────────────
const ORDER_SUBJECT_KEYWORDS = [
  "order confirmation",
  "your order",
  "has shipped",
  "out for delivery",
  "out_for_delivery",
  "delivered",
  "shipment notification",
  "shipping confirmation",
  "order shipped",
  "package delivered",
  "your package",
  "order update",
  "tracking number",
  // Additional patterns missed by the above
  "your delivery",
  "delivery scheduled",
  "delivery notification",
  "package notification",
  "delivery exception",
  "attempted delivery",
  "ready for pickup",
];

// Known carrier sender domains — emails from these are captured even if the
// subject doesn't match a keyword (e.g. "FedEx Shipment 123456789").
// Include subdomains (e.g. e.fedex.com, pkge.net for FedEx) explicitly since
// Gmail's from: operator does NOT match subdomains automatically.
const CARRIER_SENDER_DOMAINS = [
  "fedex.com",
  "e.fedex.com",
  "fedexemail.com",
  "ups.com",
  "pkginfo.ups.com",
  "usps.com",
  "email.usps.com",
  "dhl.com",
  "dhlexpress.com",
  "ontrac.com",
  "lasership.com",
  "amazon.com",
  "notifications.amazon.com",
  "ship.amazon.com",
];

function buildGmailQuery(since?: Date): string {
  const subjectClauses = ORDER_SUBJECT_KEYWORDS
    .map((k) => `subject:"${k}"`)
    .join(" OR ");

  // Also catch emails from known carrier domains that mention package/tracking.
  // e.g. "Your FedEx package is on the way" never matches the subject keywords above.
  const fromClauses = CARRIER_SENDER_DOMAINS.map((d) => `from:${d}`).join(" OR ");
  const carrierClause = `(${fromClauses}) (package OR delivery OR shipment OR tracking OR order)`;

  let q = `((${subjectClauses}) OR (${carrierClause})) -in:spam -in:trash`;
  if (since) {
    const epoch = Math.floor(since.getTime() / 1000);
    q += ` after:${epoch}`;
  }
  return q;
}

// ── Email body extraction ─────────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function extractTextFromParts(parts: GmailPart[], preferHtml = true): string {
  const order = preferHtml ? ["text/html", "text/plain"] : ["text/plain", "text/html"];
  for (const mime of order) {
    for (const part of parts) {
      if (part.mimeType === mime && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const found = extractTextFromParts(part.parts, preferHtml);
        if (found) return found;
      }
    }
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractBodyFromPayload(payload: GmailPart): string {
  if (payload.parts && payload.parts.length > 0) {
    const text = extractTextFromParts(payload.parts, true);
    return text.includes("<") ? stripHtml(text) : text;
  }
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    return decoded.includes("<") ? stripHtml(decoded) : decoded;
  }
  return "";
}

// Returns raw HTML before stripping — used to pre-extract tracking numbers
// from href attributes that get removed by stripHtml.
function extractRawHtmlFromPayload(payload: GmailPart): string {
  if (payload.parts && payload.parts.length > 0) {
    return extractTextFromParts(payload.parts, true);
  }
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  return "";
}

// ── Claude Haiku extraction ───────────────────────────────────────────────────

// ── Pre-extraction: pull tracking numbers from URLs before Claude sees the body ─
// Amazon embeds TBA numbers in URLs (track.amazon.com/tracking/TBAxxxxxxxxx).
// Claude may miss these if they're only in href attributes after HTML stripping.
function preExtractTrackingNumber(body: string): string | null {
  // Amazon TBA: appears in URLs like track.amazon.com/tracking/TBA123456789000
  const tbaMatch = body.match(/\bTBA\d{12,}\b/i);
  if (tbaMatch) return tbaMatch[0].toUpperCase();

  // UPS 1Z tracking in URLs
  const upsMatch = body.match(/\b1Z[A-Z0-9]{16}\b/i);
  if (upsMatch) return upsMatch[0].toUpperCase();

  // FedEx 12- or 15-digit in URLs
  const fedexMatch = body.match(/tracking[_\-/=](\d{12}|\d{15})\b/i);
  if (fedexMatch) return fedexMatch[1]!;

  // USPS 22-digit starting with 9
  const uspsMatch = body.match(/\b(9\d{21})\b/);
  if (uspsMatch) return uspsMatch[1]!;

  return null;
}

async function extractTrackingNumber(
  subject: string,
  from: string,
  body: string,
  preExtractedTracking?: string | null
): Promise<string | null> {
  const truncatedBody = body.slice(0, 6000);

  // Use the caller-provided pre-extracted value (from raw HTML) or fall back to
  // scanning the already-stripped body as a secondary attempt.
  const preExtracted = preExtractedTracking ?? preExtractTrackingNumber(body);

  const prompt = `Does this email contain a shipping tracking number from a carrier like UPS, FedEx, USPS, DHL, Amazon Logistics? If yes, extract just the tracking number. If no, return none.

Email subject: ${subject}
Email from: ${from}${preExtracted ? `\nPre-extracted tracking number found in email URLs: ${preExtracted}` : ""}

Email body:
${truncatedBody}

Reply with ONLY the tracking number, or the literal word "none" — nothing else.`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 40,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text.toLowerCase() === "none") {
      return null;
    }
    return text;
  } catch (err) {
    logger.warn({ err, subject, from }, "[OrderScanner] Claude Haiku tracking extraction failed");
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────────────────
// Minimal pipeline: extract a tracking number, skip if already on file,
// insert a bare-bones row, then create an EasyPost tracker for it.
// No other order fields (order_number, carrier, expected_date, order_total,
// order_url) are parsed — EasyPost webhooks fill in status/tracking_events.

function senderDisplayName(from: string): string {
  const match = from.match(/^(.*?)\s*<[^>]+>/);
  return match ? match[1].trim().replace(/^"|"$/g, "") : from.trim();
}

export async function scanOrderEmails(
  userName: string,
  since?: Date
): Promise<number> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[OrderScanner] No auth client — Google not connected");
    return 0;
  }

  try {
    await auth.getAccessToken();
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Token refresh failed");
    return 0;
  }

  const gmail = google.gmail({ version: "v1", auth });
  const q = buildGmailQuery(since);

  logger.info({ userName, since: since?.toISOString(), q }, "[OrderScanner] Scanning Gmail");

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      q,
    });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Gmail list failed");
    return 0;
  }

  logger.info({ userName, count: messageIds.length }, "[OrderScanner] Found order emails");

  let newCount = 0;

  for (const msgId of messageIds.slice(0, 50)) {
    try {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "full",
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      const subject = getHeader("Subject");
      const from = getHeader("From");
      const rawPayload = (detail.data.payload ?? {}) as GmailPart;
      // Pre-extract from raw HTML BEFORE stripping so TBA numbers in href
      // attributes (track.amazon.com/tracking/TBAxxxxxxx) are captured.
      const rawHtml = extractRawHtmlFromPayload(rawPayload);
      const preExtractedTracking = preExtractTrackingNumber(rawHtml) ?? preExtractTrackingNumber(rawHtml.replace(/<[^>]+>/g, " "));
      const body = extractBodyFromPayload(rawPayload);

      if (!body || body.length < 50) continue;

      const trackingNumber = await extractTrackingNumber(subject, from, body, preExtractedTracking);
      if (!trackingNumber) continue;

      // Check if tracking number already exists in orders table — skip if yes
      const { rows: existing } = await query<{ id: number }>(
        `SELECT id FROM orders WHERE user_name = $1 AND tracking_number = $2`,
        [userName, trackingNumber]
      );
      if (existing.length > 0) {
        logger.info({ trackingNumber }, "[OrderScanner] Tracking number already on file — skipping");
        continue;
      }

      // Insert minimal row
      const { rows: inserted } = await query<{ id: number }>(
        `INSERT INTO orders (user_name, tracking_number, retailer, item_name, status, created_at)
         VALUES ($1, $2, $3, $4, 'pre_transit', NOW())
         RETURNING id`,
        [userName, trackingNumber, senderDisplayName(from), subject]
      );
      newCount++;
      logger.info({ emailId: msgId, trackingNumber }, "[OrderScanner] Minimal order row inserted");

      // Create EasyPost tracker
      const tracker = await createTracker(trackingNumber);
      if (tracker && inserted[0]) {
        await query(
          `UPDATE orders SET easypost_tracker_id = $1 WHERE id = $2`,
          [tracker.trackerId, inserted[0].id]
        ).catch((err) => logger.warn({ err }, "[OrderScanner] Failed to store EasyPost tracker ID"));
        logger.info({ trackerId: tracker.trackerId, trackingNumber }, "[OrderScanner] EasyPost tracker created");
      }
    } catch (err) {
      logger.warn({ err, msgId }, "[OrderScanner] Failed to process email");
    }
  }

  return newCount;
}
