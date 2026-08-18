import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { createTracker, getStatusLabel } from "./easypostManager.js";
import { upsertOrder, getOrdersNeedingEmailFollowup, type OrderStatus } from "./ordersManager.js";
import { classifyEmail, type ClassifiedEmail } from "../email/emailClassifier.js";

function senderDisplayName(from: string): string {
  const match = from.match(/^(.*?)\s*<[^>]+>/);
  return match ? match[1].trim().replace(/^"|"$/g, "") : from.trim();
}

function senderEmailAddress(from: string): string | null {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase() || null;
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
    // merged into an existing one). sender_email is set here too (COALESCE
    // keeps whichever was captured first) so scanOrderStatusUpdates below
    // has something to search by if this order ever loses its tracker.
    await query(
      `UPDATE orders SET status_detail = $1, tracking_events = $2::jsonb, easypost_tracker_id = COALESCE($3, easypost_tracker_id), sender_email = COALESCE(sender_email, $4) WHERE id = $5`,
      [statusDetail, trackingEvents, tracker?.trackerId ?? null, senderEmailAddress(from), upserted.id]
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
    // No tracking number to ever hand EasyPost, so this order can ONLY be
    // updated again by a later email — capture who it's from so
    // scanOrderStatusUpdates below knows where to look for it.
    await query(
      `UPDATE orders SET sender_email = COALESCE(sender_email, $1) WHERE id = $2`,
      [senderEmailAddress(from), upserted.id]
    );
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

// ── Status-update follow-up scan for orders with no tracking number ─────────
// The main scan (both this file's manual sync and backgroundEmailScanner.ts)
// only ever looks at is:unread mail — reasonable for catching genuinely new
// order emails, but it means an order that can ONLY be updated by a later
// email (no carrier tracking number to hand EasyPost — Amazon Logistics,
// Narvar-templated retailers like Peter Millar, etc.) silently stops
// updating forever the moment that follow-up email gets marked read by
// anything other than this scan itself — a notification preview, the Gmail
// app, another integration. Confirmed live: a Peter Millar order's status
// email arrived and was read before the next scan tick, and the order was
// never updated because nothing ever looked at it again.
//
// This closes that gap with a second, narrowly-scoped pass: for each order
// that fits that description, search specifically for OTHER mail from the
// same sender (the address captured on the original order email) since the
// order was created — regardless of read status — and run any that aren't
// already tied to an order through the exact same classify + handleOrderResult
// pipeline used everywhere else. upsertOrder's existing order-number-only
// merge tier (the same one that already makes Amazon's Ordered → Shipped →
// Delivered emails update one row instead of creating duplicates) does the
// actual merge — this only has to find the candidate emails.
// Merging a follow-up email into an existing order (upsertOrder, all three
// priority tiers) never overwrites that order's email_id — it's reserved for
// the order's original identity email, by design (COALESCE(email_id, ...) /
// omitted from the UPDATE entirely). That's correct for identity, but it
// means the `WHERE email_id = $2` "already seen" check below can only ever
// match that one original email — every later follow-up (a "ready to ship"
// after "order confirmed", etc.) fails that check forever and gets
// re-fetched and re-sent to Claude on every single hourly tick indefinitely.
// Confirmed live: the same "ready to ship" email for order 321 was
// reprocessed 7+ times over as many hours, wastefully and with a real risk
// of a later pass extracting a slightly different value than an earlier one
// and silently overwriting a field that was already correct. Track
// processed follow-up email IDs separately so each one is only ever
// evaluated once, independent of the order's own identity email_id.
async function ensureFollowupLogTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS order_followup_scan_log (
      user_name  text NOT NULL,
      email_id   text NOT NULL,
      scanned_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_name, email_id)
    )
  `).catch(() => {});
}
const _followupLogTableInit = ensureFollowupLogTable();

export async function scanOrderStatusUpdates(userName: string): Promise<{ updated: number }> {
  await _followupLogTableInit;
  const orders = await getOrdersNeedingEmailFollowup(userName);
  if (orders.length === 0) return { updated: 0 };

  const auth = await getAuthClientForUser(userName);
  if (!auth) return { updated: 0 };
  try {
    await auth.getAccessToken();
  } catch (err) {
    logger.warn({ err, userName }, "[OrderScanner] Status-update scan — token refresh failed");
    return { updated: 0 };
  }
  const gmail = google.gmail({ version: "v1", auth });

  let updated = 0;

  for (const order of orders) {
    if (!order.sender_email) continue;
    const afterEpoch = Math.floor(new Date(order.created_at).getTime() / 1000);
    const q = `from:${order.sender_email} after:${afterEpoch} -in:spam -in:trash -from:me`;

    try {
      const list = await gmail.users.messages.list({ userId: "me", maxResults: 10, q });
      const messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean)
        .filter((id) => id !== order.email_id);
      if (messageIds.length === 0) continue;

      for (const msgId of messageIds) {
        // Skip anything already tied to ANY order — either this same order
        // seen on a prior tick, or a genuinely different package from the
        // same retailer that the main scan already picked up.
        const { rows: seen } = await query<{ id: number }>(
          `SELECT id FROM orders WHERE user_name = $1 AND email_id = $2 LIMIT 1`,
          [userName, msgId]
        );
        if (seen.length > 0) continue;

        const { rows: alreadyProcessed } = await query<{ email_id: string }>(
          `SELECT email_id FROM order_followup_scan_log WHERE user_name = $1 AND email_id = $2 LIMIT 1`,
          [userName, msgId]
        );
        if (alreadyProcessed.length > 0) continue;

        const detail = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
        const headers = detail.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
        const subject = getHeader("Subject");
        const from = getHeader("From");
        const body = extractBodyFromPayload((detail.data.payload ?? {}) as GmailPart);
        if (!body || body.length < 50) continue;

        const result = await classifyEmail(from, subject, body);
        // Mark processed once a real classification came back — regardless of
        // outcome — so a routine/irrelevant follow-up doesn't get re-sent to
        // Claude every hour forever. Deliberately NOT marked on a thrown
        // error above (network/Gmail hiccup) — that should still retry next tick.
        await query(
          `INSERT INTO order_followup_scan_log (user_name, email_id) VALUES ($1, $2)
           ON CONFLICT (user_name, email_id) DO NOTHING`,
          [userName, msgId]
        ).catch(() => {});
        if (!result || result.action !== "save_to_orders" || !result.order) continue;

        const wrote = await handleOrderResult(userName, msgId, from, subject, result.order);
        if (wrote) {
          updated++;
          logger.info(
            { orderId: order.id, msgId, subject },
            "[OrderScanner] Status-update scan — merged a follow-up email into an existing no-tracking order"
          );
        }
      }
    } catch (err) {
      logger.warn({ err, orderId: order.id, senderEmail: order.sender_email }, "[OrderScanner] Status-update scan failed for order");
    }
  }

  return { updated };
}
