import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { createTracker, getStatusLabel } from "./easypostManager.js";
import { MODEL_HAIKU } from "../lib/models.js";
import { upsertOrder, type OrderStatus } from "./ordersManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Direct sender-domain check — replaces the old CARRIER_SENDER_DOMAINS-derived
// filter list. Only used to gate the no-tracking-number pseudo-status path.
function isAmazonSender(from: string): boolean {
  return from.toLowerCase().includes("amazon.com");
}

// Infrastructure noise, not retailer/order content — excluded structurally,
// not as a keyword/retailer allow-list. Mailgun's own billing/transactional
// emails to this account were showing up as spurious Claude-classification
// candidates on every scan.
const EXCLUDED_SENDER_DOMAINS = ["mailgun.com", "mailgun.net"];

// Broad query, no subject-keyword or retailer allow-list. Those were exactly
// the brittle, hardcoded-list problem: a real King Arthur "Shipment
// Confirmation" email was silently invisible to this scanner because it
// didn't literally match any string in the old list, and the next
// retailer's different wording would fail the same way. extractOrderDetails()
// is the actual filter now — Claude already returns null for trackingNumber
// and orderStatusStage on anything that isn't a genuine order/shipping email.
//
// Two structural (not keyword-based) narrowings on top of that broad net:
//   - EXCLUDED_SENDER_DOMAINS — infrastructure noise, not retailer content.
//   - (is:unread OR after:since) — avoids re-running Claude on the same
//     already-read backlog every tick, while still catching older unread
//     mail the user hasn't dealt with yet.
//
// Deliberately NOT mirroring the social scan's `in:inbox` restriction here:
// order/shipping emails commonly land in Promotions/Updates, so restricting
// to the inbox label would silently drop real orders.
function buildGmailQuery(since?: Date): string {
  const exclusions = EXCLUDED_SENDER_DOMAINS.map((d) => `-from:${d}`).join(" ");
  const base = `-in:spam -in:trash -from:me ${exclusions}`;
  if (!since) return base;

  const epoch = Math.floor(since.getTime() / 1000);
  return `(is:unread OR after:${epoch}) ${base}`;
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

// Strips only <style> and <script> block noise. Every other tag — including
// <a href="...">tracking link</a> — is left intact. Retailers frequently put
// the actual tracking number only in an href, not in the visible link text;
// Claude reads the raw markup itself, so no custom link-extraction logic here.
function stripNoiseTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
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
    return text.includes("<") ? stripNoiseTags(text) : text;
  }
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    return decoded.includes("<") ? stripNoiseTags(decoded) : decoded;
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
  orderStatusStage: OrderStatus | null; // "ordered" | "shipped" | "out_for_delivery" | "delivered" | null
}

const VALID_ORDER_STAGES = new Set<OrderStatus>(["ordered", "shipped", "out_for_delivery", "delivered"]);

// Single Claude call: classifies the email AND extracts the full order record
// in one pass. No regex pre-extraction or hints — Claude reads the raw markup
// itself (see stripNoiseTags — hrefs are left intact).
//
// trackingNumber may legitimately come back null (e.g. Amazon Logistics
// "Ordered"/"Shipped" emails never carry one) — that's not a failure, it's
// classification. The caller decides what to do with a no-tracking-number
// result; this function only returns null on a genuine extraction failure
// (API error or unparseable response).
async function extractOrderDetails(
  subject: string,
  from: string,
  body: string
): Promise<ExtractedOrder | null> {
  // Raised from the original 20,000-char cap: with HTML tags no longer
  // stripped (stripNoiseTags keeps hrefs, etc.), the same email is a larger
  // payload. 40,000 chars comfortably covers a typical retail confirmation
  // or shipping email's markup (after <style>/<script> noise is removed)
  // without truncating mid-content.
  const truncatedBody = body.slice(0, 40000);

  const prompt = `Read this email and determine whether it is a genuine order or shipping notification. Extract a shipping tracking number if one is present — check link hrefs as well as visible text, since retailers often only put the tracking number in a "Track Package" link's URL, not in the link's display text.

Email subject: ${subject}
Email from: ${from}

Email body:
${truncatedBody}

Return ONLY valid JSON with exactly these fields — use null for any field not present in the email:
{
  "trackingNumber": "the shipping tracking number (from a carrier like UPS, FedEx, USPS, DHL, Amazon Logistics, OnTrac, LaserShip, etc — check href attributes too), or null if this email does not contain one",
  "carrier": "UPS, FedEx, USPS, DHL, Amazon Logistics, etc, or null",
  "orderNumber": "the order/confirmation number, or null",
  "retailer": "the store or retailer name, or null",
  "itemName": "a short description of what was ordered/shipped, or null",
  "expectedDeliveryDate": "YYYY-MM-DD expected delivery date, or null",
  "orderStatusStage": "one of \\"ordered\\", \\"shipped\\", \\"out_for_delivery\\", \\"delivered\\" based on the email's own status language (e.g. subject line, headline), or null if unclear"
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
    logger.info({ subject, rawClaudeResponse: text.slice(0, 500) }, "[OrderScanner] Claude raw response");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as ExtractedOrder;

    // Guard against a malformed date reaching the `date`-typed column.
    if (parsed.expectedDeliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.expectedDeliveryDate)) {
      parsed.expectedDeliveryDate = null;
    }

    // Guard against Claude returning a stage outside the 4 allowed values.
    if (parsed.orderStatusStage && !VALID_ORDER_STAGES.has(parsed.orderStatusStage)) {
      parsed.orderStatusStage = null;
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

export interface OrderScanResult {
  newCount: number;
  // Raw count of messageIds the Gmail query itself returned, before the
  // per-tick processing cap. Callers use this — not newCount — to decide
  // whether to advance order_sync_state.last_scan_at: a scan that found zero
  // candidates (transient auth/API failure, or a genuinely quiet inbox)
  // must not move the watermark forward, or the next scan's lookback window
  // silently shrinks to almost nothing instead of ever reaching back far
  // enough to find real order emails again.
  candidatesFound: number;
}

export async function scanOrderEmails(
  userName: string,
  since?: Date
): Promise<OrderScanResult> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[OrderScanner] No auth client — Google not connected");
    return { newCount: 0, candidatesFound: 0 };
  }

  try {
    await auth.getAccessToken();
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Token refresh failed");
    return { newCount: 0, candidatesFound: 0 };
  }

  const gmail = google.gmail({ version: "v1", auth });
  const q = buildGmailQuery(since);

  logger.info({ userName, since: since?.toISOString(), q }, "[OrderScanner] Scanning Gmail");

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({
      userId: "me",
      // Raised from 100 now that the query has no subject/domain restriction —
      // a broad query surfaces far more candidates per scan than the old
      // narrow one did.
      maxResults: 200,
      q,
    });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Gmail list failed");
    return { newCount: 0, candidatesFound: 0 };
  }

  logger.info({ userName, count: messageIds.length }, "[OrderScanner] Found order emails");

  let newCount = 0;

  // Raised from 50 alongside maxResults, same reasoning — still a sane bound
  // on Claude calls per tick (Haiku is fast/cheap; see lib/models.ts).
  for (const msgId of messageIds.slice(0, 100)) {
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

      if (!body || body.length < 50) {
        logger.info({ subject, from, bodyLength: body?.length ?? 0 }, "[OrderScanner] Body extraction returned empty/short — skipping");
        continue;
      }

      const order = await extractOrderDetails(subject, from, body);
      if (!order) continue;

      const hasTrackingNumber = !!order.trackingNumber;
      // Amazon Logistics deliveries often never expose a real carrier tracking
      // number. When Claude has genuinely found none but the email's own
      // order_number + status language give us enough to track informally,
      // fall back to a pseudo-status row instead of dropping the email.
      // Every other retailer keeps the existing behavior: no tracking number,
      // no row.
      const isAmazonPseudoStatus =
        !hasTrackingNumber &&
        !!order.orderStatusStage &&
        !!order.orderNumber &&
        isAmazonSender(from);

      if (!hasTrackingNumber && !isAmazonPseudoStatus) continue;

      if (hasTrackingNumber) {
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

        // Create the EasyPost tracker BEFORE inserting so the initial row
        // reflects the package's actual current status. Tracker.create()
        // returns the carrier's already-known status immediately — a package
        // can already be delivered by the time we first scan its
        // confirmation/shipping email, and hardcoding 'pre_transit' would
        // overwrite that with a stale default. Mirrors the fields the
        // webhook handler (routes/easypost.ts) writes on every subsequent
        // tracker.updated event — status stays the raw EasyPost code (what
        // getOrders()/upsertOrder() compare against), getStatusLabel() only
        // feeds status_detail (the human-readable string), matching what
        // those columns are actually for.
        const tracker = await createTracker(trackingNumber, order.carrier ?? undefined);
        const initialStatus = tracker?.status ?? "pre_transit";
        const statusDetail = tracker ? getStatusLabel(tracker.status) : null;
        const carrier = tracker?.carrier ?? order.carrier;
        const expectedDate = tracker?.estDeliveryDate
          ? new Date(tracker.estDeliveryDate).toISOString().split("T")[0]
          : order.expectedDeliveryDate;
        const trackingEvents = tracker ? JSON.stringify(tracker.trackingEvents) : "[]";

        const { rows: inserted } = await query<{ id: number }>(
          `INSERT INTO orders (user_name, tracking_number, carrier, order_number, retailer, item_name, expected_date, status, status_detail, tracking_events, easypost_tracker_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW())
           RETURNING id`,
          [userName, trackingNumber, carrier, order.orderNumber, retailer, itemName, expectedDate, initialStatus, statusDetail, trackingEvents, tracker?.trackerId ?? null]
        );
        if (inserted[0]) newCount++;
        logger.info(
          { emailId: msgId, trackingNumber, carrier, status: initialStatus, trackerId: tracker?.trackerId ?? null },
          "[OrderScanner] Order row inserted"
        );
      } else {
        // Amazon pseudo-status path — no tracking number, but Amazon's own
        // order_number and status language give us enough to track informally.
        // upsertOrder()'s order_number-only tier merges Ordered → Shipped →
        // Delivered emails into the same row instead of creating duplicates.
        const retailer = order.retailer ?? senderDisplayName(from);
        const itemName = order.itemName ?? subject;

        const upserted = await upsertOrder(userName, {
          retailer,
          item_name: itemName,
          order_number: order.orderNumber,
          carrier: order.carrier,
          status: order.orderStatusStage!,
          expected_date: order.expectedDeliveryDate,
          email_id: msgId,
        });

        if (upserted) {
          newCount++;
          logger.info(
            { emailId: msgId, orderNumber: order.orderNumber, status: order.orderStatusStage },
            "[OrderScanner] Amazon pseudo-status order upserted (no tracking number)"
          );
        }
      }
    } catch (err) {
      logger.warn({ err, msgId }, "[OrderScanner] Failed to process email");
    }
  }

  return { newCount, candidatesFound: messageIds.length };
}
