import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { createTracker } from "./easypostManager.js";
import { MODEL_HAIKU } from "../lib/models.js";

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

// ── Claude Haiku extraction ───────────────────────────────────────────────────

interface ExtractedOrder {
  trackingNumber: string | null;
  carrier: string | null;
  orderNumber: string | null;
  retailer: string | null;
  itemName: string | null;
  expectedDeliveryDate: string | null; // YYYY-MM-DD or null
}

// Single Claude call: classifies the email AND extracts the full order record
// in one pass. No regex pre-extraction or hints — Claude reads the body itself.
async function extractOrderDetails(
  subject: string,
  from: string,
  body: string
): Promise<ExtractedOrder | null> {
  const truncatedBody = body.slice(0, 20000);

  const prompt = `Read this email and determine whether it is a genuine order or shipping notification containing a trackable shipping tracking number (from a carrier like UPS, FedEx, USPS, DHL, Amazon Logistics, OnTrac, LaserShip, etc).

Email subject: ${subject}
Email from: ${from}

Email body:
${truncatedBody}

Return ONLY valid JSON with exactly these fields — use null for any field not present in the email:
{
  "trackingNumber": "the shipping tracking number, or null if this email does not contain one",
  "carrier": "UPS, FedEx, USPS, DHL, Amazon Logistics, etc, or null",
  "orderNumber": "the order/confirmation number, or null",
  "retailer": "the store or retailer name, or null",
  "itemName": "a short description of what was ordered/shipped, or null",
  "expectedDeliveryDate": "YYYY-MM-DD expected delivery date, or null"
}

If this email does not contain a genuine trackable shipping tracking number, set trackingNumber to null.
Reply with ONLY the JSON object — no explanation, no markdown code fences.`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as ExtractedOrder;
    if (!parsed.trackingNumber) return null;

    // Guard against a malformed date reaching the `date`-typed column.
    if (parsed.expectedDeliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.expectedDeliveryDate)) {
      parsed.expectedDeliveryDate = null;
    }

    return parsed;
  } catch (err) {
    logger.warn({ err, subject, from }, "[OrderScanner] Claude order extraction failed");
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────────────────
// Extracts a full structured order record (tracking number, carrier, order
// number, retailer, item name, expected delivery date) in a single Claude
// call, skips if already on file, inserts the row, then creates an EasyPost
// tracker for it.

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
      const body = extractBodyFromPayload(rawPayload);

      if (!body || body.length < 50) continue;

      const order = await extractOrderDetails(subject, from, body);
      if (!order) continue;
      const trackingNumber = order.trackingNumber!;

      // Check if tracking number already exists in orders table — skip if yes
      const { rows: existing } = await query<{ id: number }>(
        `SELECT id FROM orders WHERE user_name = $1 AND tracking_number = $2`,
        [userName, trackingNumber]
      );
      if (existing.length > 0) {
        logger.info({ trackingNumber }, "[OrderScanner] Tracking number already on file — skipping");
        continue;
      }

      const retailer = order.retailer ?? senderDisplayName(from);
      const itemName = order.itemName ?? subject;

      const { rows: inserted } = await query<{ id: number }>(
        `INSERT INTO orders (user_name, tracking_number, carrier, order_number, retailer, item_name, expected_date, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pre_transit', NOW())
         RETURNING id`,
        [userName, trackingNumber, order.carrier, order.orderNumber, retailer, itemName, order.expectedDeliveryDate]
      );
      newCount++;
      logger.info({ emailId: msgId, trackingNumber, carrier: order.carrier }, "[OrderScanner] Order row inserted");

      // Create EasyPost tracker — pass the extracted carrier when known, for more reliable tracking
      const tracker = await createTracker(trackingNumber, order.carrier ?? undefined);
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
