/**
 * Unified email classifier — single decision per email: what action, if any, it warrants.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EmailAction = "save_to_records" | "save_to_orders" | "meeting_request" | "needs_reply" | "urgent_alert" | "fyi" | "none";

export interface ClassifiedEmail {
  action: EmailAction;
  summary: string | null;
  _subject?: string;

  record?: {
    category: "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other";
    vendorName: string;
    confirmationNumber: string | null;
    dateStart: string | null;
    dateEnd: string | null;
    time: string | null;
    address: string | null;
    phone: string | null;
    website: string | null;
    amount: string | null;
  };

  order?: {
    retailer: string;
    itemName: string;
    orderNumber: string | null;
    trackingNumber: string | null;
    carrier: string | null;
    status: "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null;
    expectedDate: string | null;
    orderTotal: string | null;
    orderUrl: string | null;
  };

  meeting?: {
    proposedDateTimeStr: string | null;
    isOpenEnded: boolean;
    isConfirmation: boolean;
  };
}

export async function classifyEmail(
  from: string,
  subject: string,
  body: string,
  vacationMode = false,
): Promise<ClassifiedEmail | null> {
  const today = new Date().toISOString().split("T")[0];
  // 15,000 chars, not the smaller cap a pure meeting/record/reply classifier
  // would need — this call also does order/tracking extraction (folded in
  // from the old standalone order scanner), and a retail shipping
  // confirmation's tracking number is frequently buried deep in an href
  // partway down a large HTML email, well past what a tight cap would reach.
  const truncated = body.slice(0, 15000);

  const vacationLine = vacationMode
    ? "\nThe user is currently on vacation — only flag this as something other than none if it is genuinely urgent or time-sensitive; hold lower-priority items."
    : "";

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}

Body:
${truncated}
${vacationLine}
Decide what action this email warrants, if any. Return ONLY valid JSON:

{
  "action": "save_to_records" | "save_to_orders" | "meeting_request" | "needs_reply" | "urgent_alert" | "fyi" | "none",
  "summary": "one short sentence, or null",

  // include if action="save_to_records" — a genuine, actually-booked confirmation.
  // Read the ENTIRE email body, not just the opening lines — confirmation
  // numbers and dates are often lower down (in an itinerary block, a table,
  // or near the fine print) rather than in the first sentence. Look for a
  // PNR/record locator, e-ticket number, or booking reference specifically,
  // and for the actual travel/appointment date even if it's stated
  // indirectly (e.g. "Saturday, August 17" rather than a labeled field).
  "record": {
    "category": "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other",
    "vendorName": "string",
    "confirmationNumber": "string or null",
    "dateStart": "YYYY-MM-DD or null",
    "dateEnd": "YYYY-MM-DD or null",
    "time": "string or null",
    "address": "string or null",
    "phone": "string or null",
    "website": "string or null",
    "amount": "string or null"
  },

  // include if action="save_to_orders" — a shipping/order/delivery update.
  // Check link hrefs as well as visible text for a tracking number —
  // retailers frequently put it only in a "Track Package" link's URL, not
  // in the link's display text. trackingNumber may legitimately come back
  // null (Amazon Logistics "Ordered"/"Shipped" emails never carry one) —
  // that's not a failure, still classify it as save_to_orders as long as
  // status and orderNumber are present so it can still be tracked informally.
  "order": {
    "retailer": "string",
    "itemName": "string",
    "orderNumber": "string or null",
    "trackingNumber": "the shipping tracking number (UPS, FedEx, USPS, DHL, Amazon Logistics, OnTrac, LaserShip, etc — check hrefs too), or null if genuinely absent",
    "carrier": "UPS" | "FedEx" | "USPS" | "DHL" | "Amazon Logistics" | null,
    "status": "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null,
    "expectedDate": "YYYY-MM-DD or null",
    "orderTotal": "$XX.XX or null",
    "orderUrl": "string or null"
  },

  // include if action="meeting_request" — someone personally asking to schedule a call/meeting/appointment:
  "meeting": {
    "proposedDateTimeStr": "YYYY-MM-DD HH:MM or null",
    "isOpenEnded": true | false
  }
}

Rules for choosing action:
- "save_to_records": a genuine, actually-booked confirmation — hotel, restaurant reservation, car rental, flight or train ticket, warranty registration, home service appointment (plumber, HVAC, etc.), vehicle service appointment. Requires either a real confirmation/booking/reservation reference number OR explicit confirmed-booking language ("your booking is confirmed," "e-ticket," "itinerary number") — not just an email that happens to mention a date and a place. Specifically exclude price-alerts, fare-trackers, "prices dropped," saved-search notifications, and other browsing/tracking emails from travel search sites and aggregators (Google Flights, Google Hotels, Kayak, Skyscanner, Hopper, etc.) — these are never the airline/hotel/vendor itself and never represent an actual booking, no matter how specific the date or route mentioned. Subscription charge receipts and recurring billing are NOT records — use "fyi" instead.
- "save_to_orders": shipping, delivery, or order status update from a retailer or carrier — an order confirmation, a "your item shipped," an "out for delivery," "your order is ready to ship," or a "delivered" notice. This is a broad category — ANY email whose subject or body states an order/shipment status update belongs here, even if the body is short, templated, or looks routine. A tracking number is NOT required — Amazon Logistics deliveries especially often have no real carrier tracking number, but the order is still worth tracking by order number and status language alone. Do not downgrade an order-status email to "fyi" or "none" just because it's short or looks automated — routine and low-effort is normal for these, not a sign it's noise.
- "meeting_request": a real person communicating about a meeting or appointment — either (a) a NEW request where the user hasn't responded yet and a time may or may not be set, or (b) a CONFIRMATION that an already-proposed plan is locked in (time, place, and attendees decided; no response needed, just acknowledge it happened). Set isConfirmation=false for new requests, isConfirmation=true when the meeting is already confirmed.
- "needs_reply": anything from a real person that reasonably expects a response — a question, a catch-up message, a personal note — even if casual.
- "urgent_alert": anything genuinely urgent requiring the user's immediate awareness — fraud alerts, suspicious login warnings, account security notices, unrecognized transaction alerts, identity theft warnings. Also use this for large or unexpected financial transactions from payment platforms (Venmo, Zelle, PayPal, Cash App, Apple Pay) — any single transfer of $200 or more qualifies. Always flag these prominently; never drop them silently.
- "fyi": a small recurring charge, subscription renewal, or routine low-value account/balance notice — gym membership charge ($0–$50), SaaS billing, streaming renewal, routine bank activity summary, small peer payments. Worth briefly mentioning, not stored anywhere.
- "none": pure marketing, newsletters, promotional offers, automated service notifications with no real information value. Use this ONLY for noise. Never use "none" for anything financial, security-related, or potentially urgent — and never for an order/shipping status update, no matter how routine-looking; those always belong in "save_to_orders", never "none".`;

  try {
    logger.info({ subject, bodyChars: truncated.length }, "[EmailClassifier] Sending email body to Claude (cost)");
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ClassifiedEmail;
    if (!parsed.action || parsed.action === "none") return null;
    parsed._subject = subject;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[EmailClassifier] Classification failed");
    return null;
  }
}
