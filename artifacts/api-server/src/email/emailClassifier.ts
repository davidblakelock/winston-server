/**
 * Unified email classifier — shared by backgroundEmailScanner and periodicEmailScanner.
 *
 * Returns null when type="none" (no action needed), otherwise returns the full
 * classified result with extracted fields for the appropriate email type.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EmailType = "order" | "meeting" | "event" | "social" | "none";

export interface ClassifiedEmail {
  type: EmailType;
  summary: string | null;
  // internal — stamped with original subject so handlers can use it as a fallback label
  _subject?: string;
  // order fields
  retailer?: string | null;
  itemName?: string | null;
  orderNumber?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  expectedDate?: string | null;
  orderTotal?: string | null;
  orderUrl?: string | null;
  status?: "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null;
  // meeting fields
  eventTitle?: string | null;
  proposedDate?: string | null;
  proposedStartTime?: string | null;
  proposedEndTime?: string | null;
  location?: string | null;
  organizer?: string | null;
  organizerEmail?: string | null;
  // event fields
  eventDate?: string | null;
}

export async function classifyEmail(
  from: string,
  subject: string,
  date: string,
  body: string,
  hasActiveOrder = false,
): Promise<ClassifiedEmail | null> {
  const today = new Date().toISOString().split("T")[0];
  const truncated = body.slice(0, 3000);

  const orderNote = hasActiveOrder
    ? "\nNote: this may relate to an order already being tracked — if it's just a routine shipping or delivery update, use type=\"none\"."
    : "";

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}
Date: ${date}

Body:
${truncated}

Classify this email and extract relevant details. Return ONLY valid JSON:

{
  "type": "order" | "meeting" | "event" | "social" | "none",
  "summary": "one actionable sentence for the recipient, or null",

  // Include if type="order" — shipping/order/delivery emails:
  "retailer": exact retailer name or null,
  "itemName": specific product name (never just "your order") or null,
  "orderNumber": string or null,
  "trackingNumber": carrier tracking number or null,
  "carrier": "UPS" | "FedEx" | "USPS" | "DHL" | null,
  "expectedDate": "YYYY-MM-DD" or null,
  "orderTotal": "$XX.XX" or null,
  "orderUrl": tracking/order URL or null,
  "status": "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | null,

  // Include if type="meeting" — someone personally requesting a meeting/call/appointment:
  "eventTitle": meeting name or null,
  "proposedDate": "YYYY-MM-DD" or null,
  "proposedStartTime": "HH:MM" (24h) or null,
  "proposedEndTime": "HH:MM" (24h) or null,
  "location": location or null,
  "organizer": sender display name or null,
  "organizerEmail": sender email or null,

  // Include if type="event" — invitation to a group event/party/conference:
  "eventTitle": event name or null,
  "eventDate": "YYYY-MM-DD" or null,
  "organizer": organizer name or null
}

Rules:
- type="order": order/shipping/delivery emails from retailers or carriers
- type="meeting": someone personally requesting to schedule a 1:1 or small-group meeting, call, or appointment
- type="event": invitation to attend a group event (party, conference, webinar, save-the-date) not yet on calendar
- type="social": personal email from a real person — catch-up, check-in, or conversational email that warrants a reply but isn't scheduling a specific time
- type="none": newsletters, promotions, automated notifications, marketing, or anything with no reason for the recipient to act${orderNote}`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ClassifiedEmail;
    if (!parsed.type || parsed.type === "none") return null;
    parsed._subject = subject;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[EmailClassifier] Claude classification failed");
    return null;
  }
}
