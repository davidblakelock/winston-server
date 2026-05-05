import { google } from "googleapis";
import { getAuthClientForUser } from "../google/oauth.js";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import type { NewTravelSegment, TravelSegmentType } from "./travelManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Gmail helpers ─────────────────────────────────────────────────────────────

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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ").trim();
}

// ── Gmail query ───────────────────────────────────────────────────────────────

const TRAVEL_SUBJECT_KEYWORDS = [
  "flight confirmation", "your flight", "booking confirmation",
  "itinerary", "e-ticket", "eticket", "boarding pass",
  "hotel confirmation", "hotel reservation", "reservation confirmed",
  "check-in", "check in reminder",
  "car rental", "vehicle reservation", "rental confirmation",
  "travel itinerary", "trip confirmation", "your reservation",
  "airline", "departure", "arrival",
];

export function buildTravelQuery(since?: Date): string {
  const subjectClauses = TRAVEL_SUBJECT_KEYWORDS
    .map((k) => `subject:"${k}"`).join(" OR ");
  let q = `(${subjectClauses}) -in:spam -in:trash`;
  if (since) {
    q += ` after:${Math.floor(since.getTime() / 1000)}`;
  } else {
    const oneEightyDaysAgo = Math.floor((Date.now() - 180 * 24 * 60 * 60 * 1000) / 1000);
    q += ` after:${oneEightyDaysAgo}`;
  }
  return q;
}

// ── Claude Haiku extraction ───────────────────────────────────────────────────

interface ParsedTravel {
  segment_type: TravelSegmentType;
  title: string;
  confirmation_number: string | null;
  // Flight
  airline: string | null;
  flight_number: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  departure_time: string | null;   // ISO 8601
  arrival_time: string | null;     // ISO 8601
  // Hotel
  hotel_name: string | null;
  hotel_address: string | null;
  checkin_date: string | null;     // YYYY-MM-DD
  checkout_date: string | null;    // YYYY-MM-DD
  // Car rental
  car_rental_company: string | null;
  pickup_location: string | null;
  dropoff_location: string | null;
  pickup_datetime: string | null;
  dropoff_datetime: string | null;
  notes: string | null;
}

async function parseTravelFromEmail(
  subject: string,
  from: string,
  body: string,
  emailDate: string,
): Promise<ParsedTravel | null> {
  const today = new Date().toISOString().split("T")[0];
  const truncated = body.slice(0, 6000);

  const prompt = `Extract travel booking details from this confirmation email. Return ONLY valid JSON or the literal null if this is NOT a travel confirmation.

Email subject: ${subject}
From: ${from}
Date: ${emailDate}
Today: ${today}

Body:
${truncated}

Return JSON:
{
  "segment_type": "flight" | "hotel" | "car_rental" | "train" | "cruise" | "other",
  "title": "Short human-readable title e.g. 'AA 1234 DFW→LAX' or 'Marriott Dallas'",
  "confirmation_number": "booking/confirmation number as string or null",
  "airline": "airline name or null (flights only)",
  "flight_number": "e.g. 'AA 1234' or null",
  "departure_airport": "3-letter IATA code e.g. 'DFW' or null",
  "arrival_airport": "3-letter IATA code or null",
  "departure_time": "ISO 8601 datetime with timezone or null — CRITICAL: infer timezone from airport",
  "arrival_time": "ISO 8601 datetime with timezone or null",
  "hotel_name": "hotel name or null",
  "hotel_address": "full address or null",
  "checkin_date": "YYYY-MM-DD or null",
  "checkout_date": "YYYY-MM-DD or null",
  "car_rental_company": "e.g. 'Hertz', 'Enterprise' or null",
  "pickup_location": "pickup address/airport or null",
  "dropoff_location": "dropoff address/airport or null",
  "pickup_datetime": "ISO 8601 or null",
  "dropoff_datetime": "ISO 8601 or null",
  "notes": "any other important details or null"
}

Rules:
- Only return results for UPCOMING travel (departure_time / checkin_date in the future from today: ${today})
- If this is NOT a travel confirmation, return null
- For flights: DFW = America/Chicago, LAX = America/Los_Angeles, JFK/LGA/EWR = America/New_York, ORD = America/Chicago, MIA = America/New_York, etc.
- If time zone cannot be determined, use UTC`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
    if (!text || text === "null") return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as ParsedTravel;
    if (!parsed.title || !parsed.segment_type) return null;
    return parsed;
  } catch (err) {
    logger.warn({ err }, "[TravelScanner] Claude parse failed");
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export interface ScannedTravelSegment extends NewTravelSegment {
  email_id: string;
}

export async function scanTravelEmails(
  userName: string,
  since?: Date,
): Promise<ScannedTravelSegment[]> {
  const auth = await getAuthClientForUser(userName);
  if (!auth) {
    logger.warn({ userName }, "[TravelScanner] No auth client");
    return [];
  }
  try { await auth.getAccessToken(); } catch {
    logger.warn({ userName }, "[TravelScanner] Token refresh failed");
    return [];
  }

  const gmail = google.gmail({ version: "v1", auth });
  const q = buildTravelQuery(since);

  logger.info({ userName, since: since?.toISOString(), q }, "[TravelScanner] Scanning Gmail");

  let messageIds: string[] = [];
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: 100, q });
    messageIds = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "[TravelScanner] Gmail list failed");
    return [];
  }

  logger.info({ userName, count: messageIds.length }, "[TravelScanner] Found candidate emails");

  const results: ScannedTravelSegment[] = [];

  for (const msgId of messageIds.slice(0, 50)) {
    try {
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
      if (body.length < 50) continue;

      const parsed = await parseTravelFromEmail(subject, from, body, date);
      if (!parsed) continue;

      results.push({
        email_id: msgId,
        email_subject: subject,
        segment_type: parsed.segment_type,
        title: parsed.title,
        confirmation_number: parsed.confirmation_number,
        airline: parsed.airline,
        flight_number: parsed.flight_number,
        departure_airport: parsed.departure_airport,
        arrival_airport: parsed.arrival_airport,
        departure_time: parsed.departure_time,
        arrival_time: parsed.arrival_time,
        hotel_name: parsed.hotel_name,
        hotel_address: parsed.hotel_address,
        checkin_date: parsed.checkin_date,
        checkout_date: parsed.checkout_date,
        car_rental_company: parsed.car_rental_company,
        pickup_location: parsed.pickup_location,
        dropoff_location: parsed.dropoff_location,
        pickup_datetime: parsed.pickup_datetime,
        dropoff_datetime: parsed.dropoff_datetime,
        notes: parsed.notes,
      });

      logger.info(
        { emailId: msgId, title: parsed.title, type: parsed.segment_type },
        "[TravelScanner] Parsed travel segment",
      );
    } catch (err) {
      logger.warn({ err, msgId }, "[TravelScanner] Failed to process email");
    }
  }

  return results;
}
