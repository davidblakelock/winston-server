import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import type { NewOrder } from "./ordersManager.js";

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
];

function buildGmailQuery(since?: Date): string {
  const subjectClauses = ORDER_SUBJECT_KEYWORDS
    .map((k) => `subject:"${k}"`)
    .join(" OR ");
  let q = `(${subjectClauses}) -in:spam -in:trash`;
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

interface ParsedOrder {
  retailer: string | null;
  item_name: string | null;
  order_number: string | null;
  tracking_number: string | null;
  carrier: string | null;
  expected_date: string | null;
  order_total: string | null;
  order_url: string | null;
  status: "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null;
}

async function parseOrderFromEmail(
  subject: string,
  from: string,
  body: string,
  emailDate: string
): Promise<ParsedOrder | null> {
  const truncatedBody = body.slice(0, 6000);
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Extract order/shipping information from this email. Return ONLY valid JSON or the literal null if this is NOT a real order/shipping email.

Email subject: ${subject}
Email from: ${from}
Email date: ${emailDate}
Today's date: ${today}

Email body:
${truncatedBody}

Return JSON with exactly these fields (null for any not found):
{
  "retailer": "Amazon" | "Nordstrom" | exact retailer name — NOT the shipping carrier,
  "item_name": exact product name — be specific, NOT just "Amazon order" (e.g. "Vitamix 5200 Blender" or "Nike Air Max 270 Men's Size 11"),
  "order_number": order/confirmation number as string,
  "tracking_number": carrier tracking number (NOT order number),
  "carrier": "UPS" | "FedEx" | "USPS" | "DHL" | null,
  "expected_date": "YYYY-MM-DD" delivery date or null,
  "order_total": dollar amount as string e.g. "$149.99" or null,
  "order_url": URL to track order on retailer site or null,
  "status": "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered"
}

Rules:
- item_name MUST be the actual product name. If the email lists multiple items, list the first or most prominent one. Never say "your order" or "Amazon package".
- If this is a shipping notification → status is "shipped" or "in_transit"
- If "out for delivery" → status is "out_for_delivery"
- If delivered confirmation → status is "delivered"
- If just an order confirmation (no tracking yet) → status is "ordered"
- If this does NOT appear to be a real order/shipping email, return null`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text === "null") return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as ParsedOrder;
    if (!parsed.retailer || !parsed.item_name) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Claude Haiku parse failed");
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export interface ScannedOrder extends NewOrder {
  email_id: string;
}

export async function scanOrderEmails(
  userName: string,
  since?: Date
): Promise<ScannedOrder[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[OrderScanner] No auth client — Google not connected");
    return [];
  }

  try {
    await auth.getAccessToken();
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Token refresh failed");
    return [];
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
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[OrderScanner] Found order emails");

  const results: ScannedOrder[] = [];

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
      const date = getHeader("Date");
      const body = extractBodyFromPayload((detail.data.payload ?? {}) as GmailPart);

      if (!body || body.length < 50) continue;

      const parsed = await parseOrderFromEmail(subject, from, body, date);
      if (!parsed) continue;

      results.push({
        email_id: msgId,
        retailer: parsed.retailer!,
        item_name: parsed.item_name!,
        order_number: parsed.order_number,
        tracking_number: parsed.tracking_number,
        carrier: parsed.carrier,
        status: parsed.status ?? "ordered",
        expected_date: parsed.expected_date,
        order_total: parsed.order_total,
        order_url: parsed.order_url,
      });

      logger.info(
        { emailId: msgId, retailer: parsed.retailer, item: parsed.item_name, status: parsed.status },
        "[OrderScanner] Parsed order from email"
      );
    } catch (err) {
      logger.warn({ err, msgId }, "[OrderScanner] Failed to process email");
    }
  }

  return results;
}
