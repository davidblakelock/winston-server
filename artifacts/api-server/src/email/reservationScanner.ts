/**
 * Restaurant Reservation Confirmation Scanner
 *
 * Scans Gmail for restaurant reservation confirmations from OpenTable, Resy,
 * Tock, and direct restaurant emails. For each new confirmation:
 *   1. Parses restaurant name, date, time, party size, confirmation number, address
 *   2. Creates a Google Calendar event (title = restaurant, location = address)
 *   3. Sends a push notification
 *   4. Departure alert fires automatically via the existing departure scheduler
 *      once a calendar event with a location is present.
 */

import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import { query } from "../db.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { MODEL_HAIKU } from "../lib/models.js";
import { insertUserRecord } from "../records/recordsManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TZ = "America/Chicago";

// ── Gmail body extraction helpers ─────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}

function extractBodyFromPayload(payload: GmailPart): string {
  function walk(parts: GmailPart[]): string {
    for (const mime of ["text/plain", "text/html"]) {
      for (const p of parts) {
        if (p.mimeType === mime && p.body?.data) return decodeBase64Url(p.body.data);
        if (p.parts) { const r = walk(p.parts); if (r) return r; }
      }
    }
    return "";
  }
  if (payload.parts?.length) return walk(payload.parts);
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Gmail query ───────────────────────────────────────────────────────────────
//
// Targets:
//   - OpenTable:  from:opentable.com (no-reply@opentable.com, etc.)
//   - Resy:       from:resy.com
//   - Tock:       from:tocktix.com or from:exploretock.com
//   - General:    subject keywords common across all restaurant booking platforms

const RESERVATION_QUERY_PARTS = [
  "from:opentable.com",
  "from:resy.com",
  "from:tocktix.com",
  "from:exploretock.com",
  'subject:"reservation confirmed"',
  'subject:"reservation confirmation"',
  'subject:"dining reservation"',
  'subject:"your reservation at"',
  'subject:"table confirmed"',
  'subject:"your table is confirmed"',
  'subject:"booking confirmed"',
  'subject:"dinner reservation"',
];

export function buildReservationQuery(since?: Date): string {
  const clauses = RESERVATION_QUERY_PARTS.join(" OR ");
  let q = `(${clauses}) -in:spam -in:trash`;
  if (since) {
    q += ` after:${Math.floor(since.getTime() / 1000)}`;
  } else {
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    q += ` after:${sevenDaysAgo}`;
  }
  return q;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function ensureReservationTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS reservation_confirmations (
      id                  integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
      user_name           text NOT NULL,
      gmail_id            text NOT NULL,
      restaurant_name     text NOT NULL,
      reservation_date    date NOT NULL,
      reservation_time    text,
      party_size          integer,
      confirmation_number text,
      address             text,
      calendar_event_id   text,
      created_at          timestamptz DEFAULT now(),
      UNIQUE(user_name, gmail_id)
    )
  `);
}

async function hasProcessed(userName: string, gmailId: string): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM reservation_confirmations WHERE user_name = $1 AND gmail_id = $2 LIMIT 1`,
    [userName, gmailId]
  );
  return rows.length > 0;
}

async function saveReservation(
  userName: string,
  gmailId: string,
  restaurantName: string,
  reservationDate: string,
  reservationTime: string | null,
  partySize: number | null,
  confirmationNumber: string | null,
  address: string | null,
  calendarEventId: string | null
): Promise<void> {
  await query(
    `INSERT INTO reservation_confirmations
       (user_name, gmail_id, restaurant_name, reservation_date, reservation_time, party_size, confirmation_number, address, calendar_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_name, gmail_id) DO NOTHING`,
    [userName, gmailId, restaurantName, reservationDate, reservationTime, partySize, confirmationNumber, address, calendarEventId]
  );
}

// ── Claude Haiku extraction ───────────────────────────────────────────────────

interface ParsedReservation {
  restaurant_name: string;
  date: string;
  time: string | null;
  party_size: number | null;
  confirmation_number: string | null;
  address: string | null;
}

async function parseReservationFromEmail(
  subject: string,
  from: string,
  body: string,
  emailDate: string,
): Promise<ParsedReservation | null> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const truncated = body.slice(0, 6000);

  const prompt = `Extract restaurant reservation details from this confirmation email. Return ONLY valid JSON or the literal null if this is NOT a restaurant reservation confirmation.

Email subject: ${subject}
From: ${from}
Email date: ${emailDate}
Today: ${today}

Body:
${truncated}

Return JSON with exactly these fields:
{
  "restaurant_name": "exact restaurant name as shown in the confirmation",
  "date": "YYYY-MM-DD — the actual reservation date (when you are dining)",
  "time": "HH:MM in 24-hour format (e.g. '19:30' for 7:30 PM) or null if not found",
  "party_size": number of guests as integer or null,
  "confirmation_number": "booking/confirmation/reference number as string or null",
  "address": "full restaurant street address if present in the email, or null"
}

Rules:
- Only return results for UPCOMING reservations (date on or after today: ${today})
- If this is NOT a restaurant reservation confirmation email, return null
- date MUST be in YYYY-MM-DD format
- time is when the table is reserved, NOT when the email was sent
- OpenTable confirmation numbers appear after 'Reservation #' or 'Confirmation #'
- Resy confirmation numbers appear after 'Reservation ID' or 'Booking #'`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text === "null") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ParsedReservation;
    if (!parsed.restaurant_name || !parsed.date) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[ReservationScanner] Claude parse failed");
    return null;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatReservationDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function formatReservationTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  const min = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${hour}${min} ${ampm}`;
}

function addTwoHours(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const newH = (h + 2) % 24;
  return `${String(newH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Chat-driven calendar helpers ──────────────────────────────────────────────

export interface PendingCalendarReservation {
  id: number;
  restaurantName: string;
  date: string;            // YYYY-MM-DD
  time: string | null;     // HH:MM 24h
  partySize: number | null;
  confirmationNumber: string | null;
  address: string | null;
}

/** Returns the most recent confirmed reservation that hasn't been added to the
 *  calendar yet (calendar_event_id IS NULL), within the last 14 days. */
export async function getLatestUnscheduledReservation(
  userName: string
): Promise<PendingCalendarReservation | null> {
  try {
    const { rows } = await query<{
      id: number;
      restaurant_name: string;
      reservation_date: string;
      reservation_time: string | null;
      party_size: number | null;
      confirmation_number: string | null;
      address: string | null;
    }>(
      `SELECT id, restaurant_name, reservation_date, reservation_time, party_size,
              confirmation_number, address
       FROM reservation_confirmations
       WHERE user_name = $1
         AND calendar_event_id IS NULL
         AND reservation_date >= CURRENT_DATE - INTERVAL '1 day'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userName]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      restaurantName: r.restaurant_name,
      date: r.reservation_date,
      time: r.reservation_time,
      partySize: r.party_size,
      confirmationNumber: r.confirmation_number,
      address: r.address,
    };
  } catch {
    return null;
  }
}

/** Marks a reservation record as having a calendar event. */
export async function markReservationCalendarCreated(
  reservationId: number,
  calendarEventId: string
): Promise<void> {
  await query(
    `UPDATE reservation_confirmations SET calendar_event_id = $1 WHERE id = $2`,
    [calendarEventId, reservationId]
  );
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export interface ScannedReservation {
  gmailId: string;
  restaurantName: string;
  date: string;
  time: string | null;
  partySize: number | null;
  confirmationNumber: string | null;
  address: string | null;
  calendarEventId: string | null;
}


export async function scanReservationEmails(
  userName: string,
  since?: Date,
): Promise<ScannedReservation[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[ReservationScanner] No auth client");
    return [];
  }
  try {
    await auth.getAccessToken();
  } catch {
    logger.warn({ userName }, "[ReservationScanner] Token refresh failed");
    return [];
  }

  const gmail = google.gmail({ version: "v1", auth });

  // Broad query — Claude classifies each email, so we don't rely on subject keywords.
  // This catches boutique hotels, local restaurants, independent service providers,
  // and any other vendor that doesn't use standard subject line conventions.
  const sinceDate = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const afterEpoch = Math.floor(sinceDate.getTime() / 1000);
  const q = [
    "in:inbox",
    "-in:spam",
    "-in:trash",
    "-from:me",
    `after:${afterEpoch}`,
  ].join(" ");

  logger.info({ userName, q }, "[ReservationScanner] Scanning Gmail");

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 50, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[ReservationScanner] Gmail list failed");
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[ReservationScanner] Found candidate emails");

  const results: ScannedReservation[] = [];

  for (const msgId of messageIds.slice(0, 30)) {
    try {
      const alreadySaved = await query<{ id: number }>(
        `SELECT id FROM user_records WHERE user_name = $1 AND gmail_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [userName, msgId]
      );
      if (alreadySaved.rows.length > 0) {
        logger.info({ msgId }, "[ReservationScanner] Already in user_records — skipping");
        continue;
      }

      const detail = await gmail.users.messages.get({
        userId: "me", id: msgId, format: "full",
      });

      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (n: string) =>
        headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";

      const subject = getHeader("Subject");
      const from = getHeader("From");
      const date = getHeader("Date");

      let body = extractBodyFromPayload((detail.data.payload ?? {}) as GmailPart);
      if (body.includes("<")) body = stripHtml(body);
      if (body.length < 30) continue;

      // Single Claude call: classify AND extract in one shot.
      // No hardcoded vendor lists or subject keywords — Claude determines
      // whether this is a confirmation worth saving and what category it belongs to.
      // This handles boutique hotels, local restaurants, independent contractors,
      // and any other vendor regardless of domain or subject line format.
      const snippet = body.slice(0, 2000);
      const extractResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 500,
        system: `You are reviewing an email to determine if it is a booking, reservation, or service confirmation worth saving to the user's personal records.

First, decide if this email is a confirmation of one of these categories:
- trip: restaurant reservation, flight, hotel, car rental, vacation rental, cruise, tour
- warranty: product warranty, extended warranty, protection plan, service plan
- subscription: software subscription, streaming service, membership, club
- home_service: home repair, cleaning, HVAC, plumbing, electrical, pest control, lawn service
- vehicle: car service, oil change, tire, auto repair, recall
- other: any other confirmation worth keeping

If this email is NOT a confirmation (e.g. it's a newsletter, receipt for a small purchase, shipping notification, marketing email, or account notification), return exactly: {"skip": true}

If it IS a confirmation, return ONLY this JSON — no explanation, no markdown:
{
  "skip": false,
  "category": "trip|warranty|subscription|home_service|vehicle|other",
  "label": "brief type label e.g. Hotel, Flight, Restaurant Reservation, Car Rental",
  "vendorName": "business or vendor name",
  "confirmationNumber": "confirmation/booking/reservation number or null",
  "dateStart": "YYYY-MM-DD or null",
  "dateEnd": "YYYY-MM-DD or null",
  "time": "HH:MM 24h or null",
  "address": "full address or null",
  "phone": "phone number or null",
  "website": "website URL or null",
  "amount": "total amount with currency symbol or null",
  "notes": "one-line summary of what this is, or null"
}
Today is ${new Date().toISOString().slice(0, 10)}. Only use upcoming or recent dates — ignore dates clearly in the past.`,
        messages: [{ role: "user", content: `Subject: ${subject}\nFrom: ${from}\n\n${snippet}` }],
      });

      const raw = extractResp.content[0]?.type === "text" ? extractResp.content[0].text.trim() : "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      let parsed: {
        skip?: boolean;
        category?: string;
        label?: string;
        vendorName?: string;
        confirmationNumber?: string | null;
        dateStart?: string | null;
        dateEnd?: string | null;
        time?: string | null;
        address?: string | null;
        phone?: string | null;
        website?: string | null;
        amount?: string | null;
        notes?: string | null;
      };
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        continue;
      }

      // Claude decided this isn't a confirmation worth saving
      if (parsed.skip === true) continue;
      if (!parsed.vendorName || !parsed.category) continue;

      // Validate category is one we recognize — default to "other" if not
      const validCategories = ["trip", "warranty", "home_service", "subscription", "vehicle", "other"] as const;
      type RecordCategory = typeof validCategories[number];
      const recordCategory: RecordCategory = validCategories.includes(parsed.category as RecordCategory)
        ? (parsed.category as RecordCategory)
        : "other";

      const detectedLabel = parsed.label ?? parsed.category;

      // Save to user_records via idempotent upsert
      await insertUserRecord(userName, {
        category: recordCategory,
        vendorName: parsed.vendorName,
        confirmationNumber: parsed.confirmationNumber ?? null,
        dateStart: parsed.dateStart ?? null,
        dateEnd: parsed.dateEnd ?? null,
        time: parsed.time ?? null,
        address: parsed.address ?? null,
        phone: parsed.phone ?? null,
        website: parsed.website ?? null,
        amount: parsed.amount ?? null,
        notes: parsed.notes ?? null,
        rawSnippet: body.slice(0, 500),
        gmailId: msgId,
      });

      const pushBody = [
        parsed.vendorName,
        parsed.dateStart,
        parsed.time,
        parsed.confirmationNumber ? `#${parsed.confirmationNumber}` : null,
      ].filter(Boolean).join(" · ");

      await sendFcmNotification({
        userName,
        notificationType: "reservation",
        title: `${detectedLabel} confirmed ✓`,
        body: pushBody || `New ${detectedLabel.toLowerCase()} saved to your records`,
        data: {
          action: "navigate",
          screen: "/travel",
        },
      }).catch(() => {});

      results.push({
        gmailId: msgId,
        restaurantName: parsed.vendorName,
        date: parsed.dateStart ?? "",
        time: parsed.time ?? null,
        partySize: null,
        confirmationNumber: parsed.confirmationNumber ?? null,
        address: parsed.address ?? null,
        calendarEventId: null,
      });

      logger.info(
        { userName, vendor: parsed.vendorName, category: recordCategory, label: detectedLabel, confirmationNumber: parsed.confirmationNumber },
        "[ReservationScanner] Saved confirmation to user_records"
      );
    } catch (err) {
      logger.warn({ err, msgId }, "[ReservationScanner] Failed to process email");
    }
  }

  return results;
}
