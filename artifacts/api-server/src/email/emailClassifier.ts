/**
 * Unified email classifier — single decision per email: what action, if any, it warrants.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EmailAction = "save_to_records" | "save_to_orders" | "meeting_request" | "needs_reply" | "none";

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
  };
}

export async function classifyEmail(
  from: string,
  subject: string,
  body: string,
): Promise<ClassifiedEmail | null> {
  const today = new Date().toISOString().split("T")[0];
  const truncated = body.slice(0, 3000);

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}

Body:
${truncated}

Decide what action this email warrants, if any. Return ONLY valid JSON:

{
  "action": "save_to_records" | "save_to_orders" | "meeting_request" | "needs_reply" | "none",
  "summary": "one short sentence, or null",

  // include if action="save_to_records" — a booking/confirmation worth filing (hotel, restaurant, warranty, home service, subscription, vehicle, other):
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

  // include if action="save_to_orders" — a shipping/order/delivery update:
  "order": {
    "retailer": "string",
    "itemName": "string",
    "orderNumber": "string or null",
    "trackingNumber": "string or null",
    "carrier": "UPS" | "FedEx" | "USPS" | "DHL" | null,
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
- "save_to_records": a confirmation/booking worth filing away — hotel, restaurant reservation, warranty registration, home service appointment, subscription renewal, vehicle service. Never extract financial account numbers, SSNs, payment card numbers, or medical/clinical details — only logistics (confirmation number, dates, address, phone, website).
- "save_to_orders": shipping, delivery, or order status update from a retailer or carrier.
- "meeting_request": a real person personally asking to schedule time — a call, meeting, lunch, appointment.
- "needs_reply": anything else from a real person that reasonably expects a response — a question, a catch-up message, a personal note — even if casual.
- "none": newsletters, marketing, automated notifications, anything with no real action to take.

CRITICAL: If the email's content is primarily financial (bank statement, account balance, wire transfer) or medical (lab results, diagnosis, clinical record), return action="none" — do not extract or surface any details from it.`;

  try {
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
