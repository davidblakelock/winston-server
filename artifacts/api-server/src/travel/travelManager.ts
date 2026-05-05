import { query } from "../db.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { logger } from "../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TravelSegmentType = "flight" | "hotel" | "car_rental" | "train" | "cruise" | "other";

export interface TravelSegment {
  id: number;
  user_name: string;
  segment_type: TravelSegmentType;
  title: string;
  confirmation_number: string | null;
  // Flight fields
  airline: string | null;
  flight_number: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  departure_time: string | null;   // ISO timestamptz
  arrival_time: string | null;     // ISO timestamptz
  // Hotel fields
  hotel_name: string | null;
  hotel_address: string | null;
  checkin_date: string | null;     // YYYY-MM-DD
  checkout_date: string | null;    // YYYY-MM-DD
  // Car rental fields
  car_rental_company: string | null;
  pickup_location: string | null;
  dropoff_location: string | null;
  pickup_datetime: string | null;  // ISO timestamptz
  dropoff_datetime: string | null;
  // Meta
  email_id: string | null;
  email_subject: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ── Startup migration ─────────────────────────────────────────────────────────

export async function ensureTravelTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS travel_segments (
        id                  serial PRIMARY KEY,
        user_name           text NOT NULL DEFAULT '${NATIVE_USER}',
        segment_type        text NOT NULL,
        title               text NOT NULL,
        confirmation_number text,
        airline             text,
        flight_number       text,
        departure_airport   text,
        arrival_airport     text,
        departure_time      timestamptz,
        arrival_time        timestamptz,
        hotel_name          text,
        hotel_address       text,
        checkin_date        date,
        checkout_date       date,
        car_rental_company  text,
        pickup_location     text,
        dropoff_location    text,
        pickup_datetime     timestamptz,
        dropoff_datetime    timestamptz,
        email_id            text,
        email_subject       text,
        notes               text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS travel_segments_email_id_idx
      ON travel_segments (user_name, email_id) WHERE email_id IS NOT NULL
    `).catch(() => {});
    logger.info("[Travel] travel_segments table ready");
  } catch (err) {
    logger.warn({ err }, "[Travel] Startup migration warning");
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function getUpcomingTravel(userName = NATIVE_USER): Promise<TravelSegment[]> {
  const nowIso = new Date().toISOString();
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  const { rows } = await query<TravelSegment>(
    `SELECT * FROM travel_segments
     WHERE user_name = $1
       AND (
         departure_time > $2
         OR checkin_date >= $3
         OR pickup_datetime > $2
       )
     ORDER BY
       COALESCE(departure_time, checkin_date::timestamptz, pickup_datetime) ASC NULLS LAST`,
    [userName, nowIso, todayStr]
  );
  return rows;
}

export async function getTodayTravelSegments(userName = NATIVE_USER): Promise<TravelSegment[]> {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  const { rows } = await query<TravelSegment>(
    `SELECT * FROM travel_segments
     WHERE user_name = $1
       AND (
         (departure_time >= $2::date AND departure_time < $3::date)
         OR checkin_date = $2
         OR (pickup_datetime >= $2::date AND pickup_datetime < $3::date)
       )
     ORDER BY COALESCE(departure_time, checkin_date::timestamptz, pickup_datetime) ASC NULLS LAST`,
    [userName, todayStr, tomorrowStr]
  );
  return rows;
}

export interface NewTravelSegment {
  segment_type: TravelSegmentType;
  title: string;
  confirmation_number?: string | null;
  airline?: string | null;
  flight_number?: string | null;
  departure_airport?: string | null;
  arrival_airport?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  hotel_name?: string | null;
  hotel_address?: string | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
  car_rental_company?: string | null;
  pickup_location?: string | null;
  dropoff_location?: string | null;
  pickup_datetime?: string | null;
  dropoff_datetime?: string | null;
  email_id?: string | null;
  email_subject?: string | null;
  notes?: string | null;
}

export async function upsertTravelSegment(
  userName: string,
  seg: NewTravelSegment,
): Promise<TravelSegment | null> {
  try {
    const { rows } = await query<TravelSegment>(
      `INSERT INTO travel_segments
         (user_name, segment_type, title, confirmation_number,
          airline, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time,
          hotel_name, hotel_address, checkin_date, checkout_date,
          car_rental_company, pickup_location, dropoff_location,
          pickup_datetime, dropoff_datetime,
          email_id, email_subject, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (user_name, email_id)
       WHERE email_id IS NOT NULL
       DO UPDATE SET
         segment_type        = EXCLUDED.segment_type,
         title               = EXCLUDED.title,
         confirmation_number = COALESCE(EXCLUDED.confirmation_number, travel_segments.confirmation_number),
         airline             = COALESCE(EXCLUDED.airline, travel_segments.airline),
         flight_number       = COALESCE(EXCLUDED.flight_number, travel_segments.flight_number),
         departure_airport   = COALESCE(EXCLUDED.departure_airport, travel_segments.departure_airport),
         arrival_airport     = COALESCE(EXCLUDED.arrival_airport, travel_segments.arrival_airport),
         departure_time      = COALESCE(EXCLUDED.departure_time, travel_segments.departure_time),
         arrival_time        = COALESCE(EXCLUDED.arrival_time, travel_segments.arrival_time),
         hotel_name          = COALESCE(EXCLUDED.hotel_name, travel_segments.hotel_name),
         hotel_address       = COALESCE(EXCLUDED.hotel_address, travel_segments.hotel_address),
         checkin_date        = COALESCE(EXCLUDED.checkin_date, travel_segments.checkin_date),
         checkout_date       = COALESCE(EXCLUDED.checkout_date, travel_segments.checkout_date),
         car_rental_company  = COALESCE(EXCLUDED.car_rental_company, travel_segments.car_rental_company),
         pickup_location     = COALESCE(EXCLUDED.pickup_location, travel_segments.pickup_location),
         dropoff_location    = COALESCE(EXCLUDED.dropoff_location, travel_segments.dropoff_location),
         pickup_datetime     = COALESCE(EXCLUDED.pickup_datetime, travel_segments.pickup_datetime),
         dropoff_datetime    = COALESCE(EXCLUDED.dropoff_datetime, travel_segments.dropoff_datetime),
         notes               = COALESCE(EXCLUDED.notes, travel_segments.notes),
         updated_at          = now()
       RETURNING *`,
      [
        userName,
        seg.segment_type,
        seg.title,
        seg.confirmation_number ?? null,
        seg.airline ?? null,
        seg.flight_number ?? null,
        seg.departure_airport ?? null,
        seg.arrival_airport ?? null,
        seg.departure_time ?? null,
        seg.arrival_time ?? null,
        seg.hotel_name ?? null,
        seg.hotel_address ?? null,
        seg.checkin_date ?? null,
        seg.checkout_date ?? null,
        seg.car_rental_company ?? null,
        seg.pickup_location ?? null,
        seg.dropoff_location ?? null,
        seg.pickup_datetime ?? null,
        seg.dropoff_datetime ?? null,
        seg.email_id ?? null,
        seg.email_subject ?? null,
        seg.notes ?? null,
      ]
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn({ err, title: seg.title }, "[Travel] upsertTravelSegment failed");
    return null;
  }
}

export async function deleteTravelSegment(id: number, userName: string): Promise<boolean> {
  const { rows } = await query<{ id: number }>(
    `DELETE FROM travel_segments WHERE id = $1 AND user_name = $2 RETURNING id`,
    [id, userName]
  );
  return rows.length > 0;
}

// ── Briefing formatter ────────────────────────────────────────────────────────

export function formatTravelForBriefing(segments: TravelSegment[]): string {
  if (segments.length === 0) return "";

  const lines: string[] = ["[VERIFIED — Travel — from confirmed booking emails]"];

  for (const seg of segments) {
    if (seg.segment_type === "flight") {
      const dep = seg.departure_time
        ? new Date(seg.departure_time).toLocaleTimeString("en-US", {
            timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
          })
        : "TBD";
      const arr = seg.arrival_time
        ? new Date(seg.arrival_time).toLocaleTimeString("en-US", {
            timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
          })
        : "TBD";
      lines.push(
        `✈ FLIGHT: ${seg.airline ?? ""} ${seg.flight_number ?? ""} — ` +
        `${seg.departure_airport ?? "?"} → ${seg.arrival_airport ?? "?"}, ` +
        `departs ${dep}, arrives ${arr}` +
        (seg.confirmation_number ? ` (conf: ${seg.confirmation_number})` : ""),
      );
    } else if (seg.segment_type === "hotel") {
      lines.push(
        `🏨 HOTEL: ${seg.hotel_name ?? seg.title}` +
        (seg.hotel_address ? ` — ${seg.hotel_address}` : "") +
        (seg.checkin_date ? `, check-in today` : "") +
        (seg.confirmation_number ? ` (conf: ${seg.confirmation_number})` : ""),
      );
    } else if (seg.segment_type === "car_rental") {
      const pickup = seg.pickup_datetime
        ? new Date(seg.pickup_datetime).toLocaleTimeString("en-US", {
            timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true,
          })
        : "TBD";
      lines.push(
        `🚗 CAR RENTAL: ${seg.car_rental_company ?? seg.title}` +
        (seg.pickup_location ? ` — pick up at ${seg.pickup_location}` : "") +
        ` at ${pickup}` +
        (seg.confirmation_number ? ` (conf: ${seg.confirmation_number})` : ""),
      );
    } else {
      lines.push(`🧳 TRAVEL: ${seg.title}` +
        (seg.confirmation_number ? ` (conf: ${seg.confirmation_number})` : ""));
    }
  }

  return "\n\n" + lines.join("\n");
}
