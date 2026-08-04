import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { createTracker, getStatusLabel } from "./easypostManager.js";
import { upsertOrder, type OrderStatus } from "./ordersManager.js";
import { classifyEmail, type ClassifiedEmail } from "../email/emailClassifier.js";

function senderDisplayName(from: string): string {
  const match = from.match(/^(.*?)\s*<[^>]+>/);
  return match ? match[1].trim().replace(/^"|"$/g, "") : from.trim();
}

// ── Order result handler — shared by the unified background scan
// (backgroundEmailScanner.ts, which now does one Gmail pass covering
// meetings/records/orders/replies instead of a separate order-only scanner
// racing the social scan over the same is:unread mail) and scanOrdersOnly()
// below (the manual "sync my orders" button's own on-demand pass). Extracts
// nothing itself — classifyEmail() already did that; this just decides what
// to write to the orders table from an already-classified "save_to_orders"
// result. Returns true if a row was created or updated.
export async function handleOrderResult(
  userName: string,
  msgId: string,
  from: string,
  subject: string,
  order: NonNullable<ClassifiedEmail["order"]>
): Promise<boolean> {
  const hasTrackingNumber = !!order.trackingNumber;
  // Amazon Logistics deliveries often never expose a real carrier tracking
  // number — that was the original, narrower reasoning here. Confirmed via a
  // real dropped order that this isn't Amazon-specific at all: Narvar (a
  // third-party post-purchase platform used by many retailers, e.g. Peter
  // Millar) wraps the actual carrier tracking number behind its own opaque
  // redirect links and never exposes it in the email itself, same as Amazon
  // Logistics. Any sender can hit this — gate purely on whether the email
  // itself gives us enough to track informally (order number + status), not
  // on who sent it.
  const hasPseudoStatus =
    !hasTrackingNumber &&
    !!order.status &&
    !!order.orderNumber;

  if (!hasTrackingNumber && !hasPseudoStatus) {
    // Still a real drop case — classifyEmail called this an order but
    // extraction found no tracking number AND no order number/status to fall
    // back on. Log what was actually extracted so a report of "my order
    // didn't show up" is traceable to classifier output instead of guesswork.
    logger.info(
      { emailId: msgId, from, subject, retailer: order.retailer, orderNumber: order.orderNumber, status: order.status },
      "[OrderScanner] Order dropped — no tracking number and not enough for a pseudo-status row"
    );
    return false;
  }

  if (hasTrackingNumber) {
    const trackingNumber = order.trackingNumber!;
    const retailer = order.retailer || senderDisplayName(from);
    const itemName = order.itemName || subject;

    // Create the EasyPost tracker BEFORE writing so the row reflects the
    // package's actual current status. Tracker.create() returns the
    // carrier's already-known status immediately — a package can already be
    // delivered by the time we first scan its confirmation/shipping email,
    // and hardcoding 'pre_transit' would overwrite that with a stale
    // default. Mirrors the fields the webhook handler (routes/easypost.ts,
    // via easypostSync.ts) writes on every subsequent tracker.updated event —
    // status stays the raw EasyPost code (what getOrders()/upsertOrder()
    // compare against), getStatusLabel() only feeds status_detail (the
    // human-readable string).
    const tracker = await createTracker(trackingNumber, order.carrier ?? undefined);
    const initialStatus = tracker?.status ?? "pre_transit";
    const statusDetail = tracker ? getStatusLabel(tracker.status) : null;
    const carrier = tracker?.carrier ?? order.carrier;
    const expectedDate = tracker?.estDeliveryDate
      ? new Date(tracker.estDeliveryDate).toISOString().split("T")[0]
      : order.expectedDate;
    const trackingEvents = tracker ? JSON.stringify(tracker.trackingEvents) : "[]";

    // Route through upsertOrder() rather than a raw INSERT — real data loss
    // found in production without this: a tracking-bearing "shipped" email
    // arriving after an earlier no-tracking "ready to ship" email for the
    // SAME order_number always created a brand new row here (dedup was
    // tracking_number-only), leaving upsertOrder's own "merge into the
    // existing pseudo-status row" logic (Priority 2, built for exactly this
    // case) completely unreachable from this path. The raw INSERT also never
    // set email_id at all, which fed a second bug: consolidateOrders'
    // order_number dedup step later collapsed genuinely different packages
    // (two different real tracking numbers under one shared order_number)
    // down to one row, since nothing here gave it email-level identity to
    // reason about. upsertOrder's own tracking_number-first matching still
    // correctly no-ops/updates on a true repeat scan of the same email.
    const upserted = await upsertOrder(userName, {
      retailer, item_name: itemName, order_number: order.orderNumber ?? null,
      tracking_number: trackingNumber, carrier, status: initialStatus as OrderStatus,
      expected_date: expectedDate, email_id: msgId,
    });

    if (!upserted) {
      logger.warn({ emailId: msgId, trackingNumber }, "[OrderScanner] upsertOrder failed for tracking-bearing order");
      return false;
    }

    // EasyPost-specific fields (raw tracking event history, the resolved
    // tracker id) aren't part of upsertOrder's general NewOrder shape —
    // set them directly on whichever row it resolved to (freshly inserted or
    // merged into an existing one).
    await query(
      `UPDATE orders SET status_detail = $1, tracking_events = $2::jsonb, easypost_tracker_id = COALESCE($3, easypost_tracker_id) WHERE id = $4`,
      [statusDetail, trackingEvents, tracker?.trackerId ?? null, upserted.id]
    );

    logger.info(
      { emailId: msgId, orderId: upserted.id, trackingNumber, carrier, status: initialStatus, trackerId: tracker?.trackerId ?? null },
      "[OrderScanner] Order row inserted"
    );
    return true;
  }

  // Pseudo-status path — no tracking number, but the email's own order
  // number and status language give us enough to track informally (Amazon
  // Logistics, Narvar-templated retailers, and likely others all withhold a
  // real carrier tracking number the same way). upsertOrder()'s
  // order_number-only tier merges Ordered → Shipped → Delivered emails into
  // the same row instead of creating duplicates.
  const retailer = order.retailer || senderDisplayName(from);
  const itemName = order.itemName || subject;

  const upserted = await upsertOrder(userName, {
    retailer,
    item_name: itemName,
    order_number: order.orderNumber,
    carrier: order.carrier,
    status: order.status!,
    expected_date: order.expectedDate,
    email_id: msgId,
  });

  if (upserted) {
    logger.info(
      { emailId: msgId, orderNumber: order.orderNumber, status: order.status },
      "[OrderScanner] Pseudo-status order upserted (no tracking number)"
    );
  }
  return !!upserted;
}

// ── Manual "sync my orders" entry point (POST /api/orders/sync) ─────────────
// The passive background scan (backgroundEmailScanner.ts) now covers orders
// as part of its single unified pass — this is only for the on-demand button,
// which needs its own immediate Gmail read rather than waiting for the next
// scheduled tick. Reuses the same classifyEmail() classifier and the same
// handleOrderResult() write logic above; only order-classified results are
// acted on here, everything else the classifier finds on this on-demand pass
// is deliberately ignored — the button says "sync my orders," not "run a
// full scan."

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
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
// <a href="...">tracking link</a> — is left intact; the classifier reads the
// raw markup itself.
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

export interface OrderScanResult {
  newCount: number;
  // Raw count of messageIds the Gmail query itself returned, before the
  // per-tick processing cap. Purely a diagnostic/logging signal now — no
  // watermark depends on it.
  candidatesFound: number;
}

export async function scanOrdersOnly(userName: string): Promise<OrderScanResult> {
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
  const q = `in:inbox is:unread -in:spam -in:trash -from:me`;

  logger.info({ userName, q }, "[OrderScanner] Scanning Gmail (manual sync)");

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 200, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[OrderScanner] Gmail list failed");
    return { newCount: 0, candidatesFound: 0 };
  }

  logger.info({ userName, count: messageIds.length }, "[OrderScanner] Found candidate emails");

  // Was a plain sequential for-loop — one Gmail fetch + one Claude classify
  // call per candidate, fully serialized. Confirmed live at 53 seconds for
  // 11 candidates (the manual "refresh" button's own reported complaint).
  // Batched with bounded concurrency instead of full parallelism to stay
  // reasonable against Gmail/Anthropic rate limits.
  const CONCURRENCY = 5;
  let newCount = 0;

  async function processOne(msgId: string): Promise<void> {
    try {
      const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      const subject = getHeader("Subject");
      const from = getHeader("From");
      const rawPayload = (detail.data.payload ?? {}) as GmailPart;
      const body = extractBodyFromPayload(rawPayload);

      if (!body || body.length < 50) {
        logger.info({ msgId, subject, bodyChars: body?.length ?? 0 }, "[OrderScanner] Skipped — body too short to classify");
        return;
      }

      const result = await classifyEmail(from, subject, body);
      if (!result || result.action !== "save_to_orders" || !result.order) {
        logger.info({ msgId, subject, action: result?.action ?? "none" }, "[OrderScanner] Skipped — not classified as an order");
        return;
      }

      const created = await handleOrderResult(userName, msgId, from, subject, result.order);
      if (created) {
        newCount++;
      } else {
        logger.info({ msgId, subject }, "[OrderScanner] Classified as an order but not written — see handleOrderResult log above for why");
      }
    } catch (err) {
      logger.warn({ err, msgId }, "[OrderScanner] Failed to process email");
    }
  }

  const candidates = messageIds.slice(0, 100);
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map(processOne));
  }

  return { newCount, candidatesFound: messageIds.length };
}
