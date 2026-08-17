/**
 * Unified email classifier — single decision per email: what action, if any, it warrants.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { MODEL_HAIKU } from "../lib/models.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type EmailAction = "save_to_records" | "save_to_orders" | "meeting_request" | "needs_reply" | "urgent_alert" | "fyi" | "none";

// Deterministic backstop for the food-order exclusion — the prompt already
// tells the model to exclude food from both save_to_orders and
// save_to_records, but that's prompt-only enforcement, and it has already
// been observed live to fail twice on the same shape of case (a local
// pizzeria's order-confirmation email, which reads enough like a real
// shipping/booking confirmation — order number, status language — to slip
// past a purely instructional exclusion). This checks the concrete fields
// the model itself extracted (retailer/item/vendor names, plus the sender)
// against known food-vendor language and overrides the action regardless of
// what the model decided, so this specific failure mode can't recur.
const FOOD_KEYWORDS = /\b(pizza|pizzeria|taco|burrito|taqueria|burger|sushi|hibachi|noodle|ramen|pho\b|bbq|barbecue|wings?|sandwich|deli|bakery|donut|doughnut|bagel|coffee|café|cafe|diner|grill|kitchen|eatery|bar\s*&?\s*grill|catering|food\s*truck|drive-?thru|steakhouse)\b/i;
const FOOD_ORDERING_DOMAINS = /(doordash|ubereats|uber\.com\/eats|grubhub|postmates|seamless\.com|toasttab|chownow|olo\.com|slicelife|ezcater)/i;

function isFoodOrder(fields: {
  from: string;
  subject: string;
  retailer?: string | null;
  itemName?: string | null;
  vendorName?: string | null;
}): boolean {
  const haystack = [fields.from, fields.subject, fields.retailer, fields.itemName, fields.vendorName]
    .filter(Boolean)
    .join(" ");
  return FOOD_KEYWORDS.test(haystack) || FOOD_ORDERING_DOMAINS.test(haystack);
}

export interface ClassifiedEmail {
  action: EmailAction;
  summary: string | null;
  _subject?: string;

  record?: {
    category: "trip" | "warranty" | "subscription" | "other";
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
  // Optional — the user's existing user_records, formatted for prompt
  // injection (see getRecentRecordsContextBlock in recordsManager.ts). Only
  // callers that write to user_records (backgroundEmailScanner.ts) pass
  // this; order-scanning callers (gmailOrderScanner.ts) leave it unset,
  // since it's irrelevant there. Without it, "don't duplicate a known
  // event" is unenforceable — the classifier has no way to know an event
  // is already on file when judging a single email in isolation, which was
  // confirmed live as the actual cause of duplicate records (two rows for
  // the same home inspection, pulled from two emails in the same thread).
  existingRecordsBlock: string | null = null,
): Promise<ClassifiedEmail | null> {
  const today = new Date().toISOString().split("T")[0];
  // 40,000 chars (was 15,000 — confirmed too small via a real dropped order:
  // a Narvar-templated shipping email came in at 76K stripped chars, with the
  // retailer's own name not appearing until char ~16,700 and the actual order
  // block well past that — the classifier was never seeing real content at
  // all, just MJML/responsive-table markup, on any email built with a
  // template this heavy). Raised well past where that email's real content
  // starts, not just past where it happened to end.
  const truncated = body.slice(0, 40000);

  const vacationLine = vacationMode
    ? "\nThe user is currently on vacation — only flag this as something other than none if it is genuinely urgent or time-sensitive; hold lower-priority items."
    : "";

  const existingRecordsLine = existingRecordsBlock
    ? `\nEXISTING RECORDS ALREADY ON FILE (for the save_to_records duplicate check only — see that rule below):\n${existingRecordsBlock}\n`
    : "";

  const prompt = `Today: ${today}
From: ${from}
Subject: ${subject}
${existingRecordsLine}
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
    "category": "trip" | "warranty" | "subscription" | "other",
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
- "save_to_records": a genuine, actually-booked confirmation for a FUTURE service, or a document worth keeping — hotel, restaurant reservation, car rental, flight or train ticket, warranty registration. Requires a real confirmation/booking/reservation reference number in the vast majority of cases — a PNR, e-ticket number, itinerary number, or booking reference actually printed in the email. The one exception: an email with no reference number can still qualify ONLY if it lays out a full, concrete itinerary (a specific vendor, date, time, and location, reading like a real confirmed booking) rather than just mentioning a date in passing — a bare "your appointment is confirmed" with no reference number and no concrete itinerary detail is NOT enough on its own, and neither is an informal back-and-forth email thread between the user and a person (a realtor, an inspector, a contractor) casually coordinating a time — a real back-and-forth conversation about scheduling something is not a confirmed booking document, no matter how specific the date/time mentioned gets; if the email reads like two people talking, not like a confirmation notice, it does not qualify. NEVER use "save_to_records" for a home or vehicle service appointment (plumber, HVAC, contractor, home inspection, mechanic, oil change, etc.) even with a specific date, time, vendor, and confirmation number — these belong on the user's calendar, not filed as records, same exclusion as personal appointments below. NEVER use "save_to_records" for a generic account-status or "check your account for updates" email (a lender, bank, or service provider nudging you to log into a portal) — that's not a future-dated booking with a concrete date/time/location, regardless of how significant the underlying matter (a mortgage, a loan, an account application) is. Check this email against the EXISTING RECORDS ALREADY ON FILE block above (when present) before deciding: if this email is about the same event as one of those — the same trip, the same warranty, the same vendor and rough date — even if described slightly differently (a different phrasing of the vendor name, a follow-up in the same conversation, a status update on the same booking), it is NOT a new record; use "fyi" instead (or "none" if it adds nothing new). This is the single most common way duplicates happen — a second or third email about a booking that's already on file — so check this every time, not just when something is explicitly labeled "reminder." Never save a receipt or payment confirmation as a record — a receipt proves a payment happened, it isn't a future-dated booking; use "fyi" instead, whether it's a one-time or recurring charge. This includes a "purchase confirmed" / "package purchased" / "payment received" email for something like a class package, punch card, or membership — that's a receipt for money already spent, not a future-dated booking, EVEN IF it carries what looks like a confirmation or order number; a reference number alone does not make something a record — check whether the email is about a completed payment (receipt → fyi) versus an actual scheduled future booking (record). NEVER use "save_to_records" for a personal appointment, class, or session that's really a calendar item, not a document worth filing — a fitness class booking, personal training session, salon/spa appointment, or medical/dental appointment — even with a specific date, time, and confirmation number; these belong on the user's calendar, not filed as records — use "fyi" instead. NEVER use "save_to_records" for food — restaurant orders, pizza, delivery-app orders (Uber Eats, DoorDash, Grubhub, Postmates), catering — same exclusion as save_to_orders below; use "fyi" instead. When setting dateEnd (expiration/renewal/valid-through), it must come from a date EXPLICITLY stated in the email — never infer, estimate, or assume a standard term (e.g. never assume "expires 1 year from purchase" just because the category is "subscription"); leave dateEnd null if the email doesn't state one. Specifically exclude price-alerts, fare-trackers, "prices dropped," saved-search notifications, and other browsing/tracking emails from travel search sites and aggregators (Google Flights, Google Hotels, Kayak, Skyscanner, Hopper, etc.) — these are never the airline/hotel/vendor itself and never represent an actual booking, no matter how specific the date or route mentioned. Also exclude league/class schedules, signup notices, or membership emails that don't carry both a reference number and a specific confirmed session — "here's the schedule" or "you're registered" with no reference number is not a record.
- "save_to_orders": shipping, delivery, or order status update from a retailer or carrier, for a PHYSICAL item that ships TO the user and can be tracked — an order confirmation, a "your item shipped," an "out for delivery," "your order is ready to ship," or a "delivered" notice. This is a broad category for physical goods — ANY email whose subject or body states a physical order/shipment status update belongs here, even if the body is short, templated, or looks routine. A tracking number is NOT required — Amazon Logistics deliveries especially often have no real carrier tracking number, but the order is still worth tracking by order number and status language alone. Do not downgrade a physical order-status email to "fyi" or "none" just because it's short or looks automated — routine and low-effort is normal for these, not a sign it's noise. NEVER use "save_to_orders" for food — restaurant orders, pizza, delivery-app orders (Uber Eats, DoorDash, Grubhub, Postmates), coffee-shop mobile orders, or any prepared food being cooked and delivered/picked up directly by the vendor. Food is never shipped by a carrier and there's nothing meaningful to track — use "fyi" instead, regardless of whether the email has an order number or status language. This applies to any restaurant by name too, not just the well-known delivery apps — a local pizzeria's own order-confirmation email is still food, not a shippable order. NEVER use "save_to_orders" for a trade-in, mail-in, or return kit email — "send us your old device," "ship your trade-in within 30 days," a prepaid return label, or similar — these describe the USER shipping something OUT, not a retailer shipping something IN to them, so there is no delivery status to ever reach and nothing trackable the same way; use "fyi" instead.
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

    if (
      (parsed.action === "save_to_orders" || parsed.action === "save_to_records") &&
      isFoodOrder({
        from,
        subject,
        retailer: parsed.order?.retailer,
        itemName: parsed.order?.itemName,
        vendorName: parsed.record?.vendorName,
      })
    ) {
      logger.info(
        { subject, from, originalAction: parsed.action },
        "[EmailClassifier] Deterministic food-keyword override — downgrading to fyi"
      );
      parsed.action = "fyi";
      parsed.order = undefined;
      parsed.record = undefined;
    }

    parsed._subject = subject;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[EmailClassifier] Classification failed");
    return null;
  }
}
