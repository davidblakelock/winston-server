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
import { createCalendarEvent } from "../google/calendar.js";
import { sendPushToAll } from "../push/pushManager.js";
import { MODEL_HAIKU } from "../lib/models.js";

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
  await ensureReservationTable();

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
  const q = buildReservationQuery(since);

  logger.info({ userName, since: since?.toISOString(), q }, "[ReservationScanner] Scanning Gmail");

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
      if (await hasProcessed(userName, msgId)) {
        logger.info({ msgId }, "[ReservationScanner] Already processed — skipping");
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

      const parsed = await parseReservationFromEmail(subject, from, body, date);
      if (!parsed) {
        logger.info({ msgId, subject }, "[ReservationScanner] Not a reservation confirmation — skipping");
        continue;
      }

      // ── Create Google Calendar event ──────────────────────────────────────
      // Reserve 2 hours by default; use 7 PM if time is missing.
      const startTime = parsed.time ?? "19:00";
      const endTime = addTwoHours(startTime);

      const descriptionParts: string[] = [];
      if (parsed.confirmation_number) descriptionParts.push(`Confirmation: ${parsed.confirmation_number}`);
      if (parsed.party_size) descriptionParts.push(`Party of ${parsed.party_size}`);

      const calendarResult = await createCalendarEvent(
        {
          title: parsed.restaurant_name,
          date: parsed.date,
          startTime,
          endTime,
          location: parsed.address ?? undefined,
          description: descriptionParts.length > 0 ? descriptionParts.join("\n") : undefined,
        },
        userName
      ).catch((err) => {
        logger.warn({ err, restaurant: parsed.restaurant_name }, "[ReservationScanner] Calendar create failed");
        return null;
      });

      const calendarEventId = calendarResult?.id ?? null;

      // ── Persist dedup record ──────────────────────────────────────────────
      await saveReservation(
        userName, msgId,
        parsed.restaurant_name, parsed.date, parsed.time,
        parsed.party_size, parsed.confirmation_number,
        parsed.address, calendarEventId
      );

      // ── Push notification ─────────────────────────────────────────────────
      const dateLabel = formatReservationDate(parsed.date);
      const timeLabel = parsed.time ? ` at ${formatReservationTime(parsed.time)}` : "";
      const pushBody = `${parsed.restaurant_name} added to your calendar for ${dateLabel}${timeLabel}`;

      await sendPushToAll({
        title: "Reservation confirmed",
        body: pushBody,
        tag: `reservation-${userName}-${msgId}`,
        notificationType: "reservation",
        deepLink: "winston://calendar",
      }, userName).catch(() => {});

      results.push({
        gmailId: msgId,
        restaurantName: parsed.restaurant_name,
        date: parsed.date,
        time: parsed.time,
        partySize: parsed.party_size,
        confirmationNumber: parsed.confirmation_number,
        address: parsed.address,
        calendarEventId,
      });

      logger.info(
        {
          userName,
          msgId,
          restaurant: parsed.restaurant_name,
          date: parsed.date,
          time: parsed.time,
          calendarEventId,
          hasAddress: !!parsed.address,
        },
        "[ReservationScanner] Reservation confirmed — calendar event created, push sent"
      );
    } catch (err) {
      logger.warn({ err, msgId }, "[ReservationScanner] Failed to process email");
    }
  }

  return results;
}
