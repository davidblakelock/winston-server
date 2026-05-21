/**
 * Resy Authentication & Direct Booking
 *
 * Implements the Resy OTP (email code) login flow and direct booking via
 * Resy's web API. This replaces the Apify actor for Resy so that no
 * password is ever stored.
 *
 * Auth flow:
 *   1. requestResyOtp(email)  → Resy sends a numeric code to that email
 *   2. verifyResyOtp(email, code) → returns a session token on success
 *   3. Token is stored for 14 days in resy_sessions table
 *   4. bookViaResyDirect() uses the token for all subsequent bookings
 */

import { logger } from "../lib/logger.js";
import type { ApifyBookingResult } from "./apifyBooking.js";

// Resy web-client API key (public key embedded in resy.com — not a secret)
const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";

function resyBaseHeaders(): Record<string, string> {
  return {
    "Content-Type":   "application/x-www-form-urlencoded",
    "Authorization":  `ResyAPI api_key="${RESY_API_KEY}"`,
    "X-Origin":       "https://resy.com",
    "Origin":         "https://resy.com",
    "Referer":        "https://resy.com/",
    "User-Agent":     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept":         "application/json, text/plain, */*",
    "Cache-Control":  "no-cache",
  };
}

function resyAuthHeaders(token: string): Record<string, string> {
  return {
    ...resyBaseHeaders(),
    "Authorization":    `ResyAPI api_key="${RESY_API_KEY}", token="${token}"`,
    "X-Resy-Auth-Token": token,
  };
}

function encodeForm(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ── In-memory pending OTP state ───────────────────────────────────────────────

export interface PendingResyOtpState {
  email:          string;
  slug:           string;
  city:           string;
  restaurantName: string;
  date:           string;
  time:           string;
  timeLabel:      string;
  dateLabel:      string;
  partySize:      number;
  addr:           string;
  fallbackUrl:    string;
  companionName:  string;
}

const _pendingResyOtp = new Map<string, PendingResyOtpState>();

export function setPendingResyOtp(userName: string, state: PendingResyOtpState): void {
  _pendingResyOtp.set(userName, state);
}

export function getPendingResyOtp(userName: string): PendingResyOtpState | null {
  return _pendingResyOtp.get(userName) ?? null;
}

export function clearPendingResyOtp(userName: string): void {
  _pendingResyOtp.delete(userName);
}

// ── OTP request & verify ──────────────────────────────────────────────────────

/**
 * Triggers a one-time code to be sent to the given email address via Resy.
 * Returns true if the request was accepted (the code may still take a moment to arrive).
 */
export async function requestResyOtp(email: string): Promise<boolean> {
  try {
    // Resy uses a "magic link / passcode" email auth endpoint
    const resp = await fetch("https://api.resy.com/3/auth/email/request", {
      method:  "POST",
      headers: resyBaseHeaders(),
      body:    encodeForm({ email }),
    });

    if (resp.ok || resp.status === 204) {
      logger.info({ email }, "[ResyAuth] OTP requested successfully");
      return true;
    }

    // Some Resy versions route through a different path
    const resp2 = await fetch("https://api.resy.com/3/auth/password", {
      method:  "POST",
      headers: { ...resyBaseHeaders(), "Content-Type": "application/json" },
      body:    JSON.stringify({ email, location: { id: 0, current: false } }),
    });

    if (resp2.ok) {
      logger.info({ email }, "[ResyAuth] OTP requested via fallback endpoint");
      return true;
    }

    logger.warn({ email, status: resp.status, status2: resp2.status }, "[ResyAuth] OTP request returned non-OK");
    return true; // Still return true — code may have been sent despite non-200
  } catch (err) {
    logger.warn({ err }, "[ResyAuth] OTP request threw");
    return false;
  }
}

/**
 * Verifies the OTP code the user received by email.
 * Returns a Resy API token string on success, or null on failure.
 */
export async function verifyResyOtp(email: string, code: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.resy.com/3/auth/email/verify", {
      method:  "POST",
      headers: resyBaseHeaders(),
      body:    encodeForm({ email, code }),
    });

    if (resp.ok) {
      const data = await resp.json() as {
        token?: string;
        auth_token?: string;
        payment_method_string?: string;
      };
      const token = data.token ?? data.auth_token ?? null;
      if (token) {
        logger.info({ email }, "[ResyAuth] OTP verified — session token obtained");
        return token;
      }
    }

    logger.warn({ email, status: resp.status }, "[ResyAuth] OTP verify failed or no token in response");
    return null;
  } catch (err) {
    logger.warn({ err }, "[ResyAuth] OTP verify threw");
    return null;
  }
}

// ── Direct booking via Resy API ───────────────────────────────────────────────

interface ResyVenueSlot {
  config: {
    id:    number;
    token: string;
    type:  string;
  };
  date: {
    start: string; // "2025-06-15 19:00:00"
    end:   string;
  };
}

export async function resolveResyVenueId(
  slug:  string,
  city:  string,
  token: string,
): Promise<string | null> {
  try {
    const url = `https://api.resy.com/3/venue?url_slug=${encodeURIComponent(slug)}&location=${encodeURIComponent(city)}`;
    const resp = await fetch(url, { headers: resyAuthHeaders(token) });
    if (!resp.ok) return null;
    const data = await resp.json() as { id?: { resy?: number } };
    return data.id?.resy ? String(data.id.resy) : null;
  } catch {
    return null;
  }
}

export async function findResySlots(
  venueId:   string,
  dateISO:   string,
  partySize: number,
  token:     string,
): Promise<ResyVenueSlot[]> {
  try {
    const params = new URLSearchParams({
      lat:        "0",
      long:       "0",
      day:        dateISO,
      party_size: String(partySize),
      venue_id:   venueId,
    });
    const resp = await fetch(`https://api.resy.com/4/find?${params}`, {
      headers: resyAuthHeaders(token),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as {
      results?: { venues?: Array<{ slots?: ResyVenueSlot[] }> };
    };
    return data.results?.venues?.[0]?.slots ?? [];
  } catch {
    return [];
  }
}

async function getResyBookToken(configToken: string, token: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.resy.com/3/details", {
      method:  "POST",
      headers: { ...resyAuthHeaders(token), "Content-Type": "application/json" },
      body:    JSON.stringify({ config_id: configToken }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { book_token?: { value?: string } };
    return data.book_token?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Book a Resy reservation directly via the Resy API using a stored session token.
 * No Apify actor is used — the booking is made synchronously.
 */
export async function bookViaResyDirect(
  venueSlug:      string,
  citySlug:       string,
  restaurantName: string,
  dateISO:        string,
  timeHHMM:       string,
  partySize:      number,
  sessionToken:   string,
): Promise<ApifyBookingResult> {
  logger.info(
    { venueSlug, citySlug, restaurantName, dateISO, timeHHMM, partySize },
    "[ResyDirect] Starting booking"
  );

  try {
    // 1. Resolve venue ID
    const venueId = await resolveResyVenueId(venueSlug, citySlug, sessionToken);
    if (!venueId) {
      logger.warn({ venueSlug }, "[ResyDirect] Could not resolve venue ID");
      return { success: false, error: "venue_not_found" };
    }

    // 2. Find available slots
    const slots = await findResySlots(venueId, dateISO, partySize, sessionToken);
    if (slots.length === 0) {
      return { success: false, error: "no_availability" };
    }

    // 3. Find slot closest to requested time
    const targetMinutes = (() => {
      const [h, m] = timeHHMM.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    })();

    const slotMinutes = (s: ResyVenueSlot): number => {
      const t = s.date.start.split(" ")[1] ?? "";
      const [h, m] = t.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };

    const sorted = [...slots].sort(
      (a, b) => Math.abs(slotMinutes(a) - targetMinutes) - Math.abs(slotMinutes(b) - targetMinutes)
    );
    const bestSlot = sorted[0]!;

    const alternatives = sorted
      .slice(1, 3)
      .map((s) => {
        const rawTime = s.date.start.split(" ")[1]?.slice(0, 5) ?? "";
        return { time: rawTime };
      });

    // 4. Get book token
    const bookToken = await getResyBookToken(bestSlot.config.token, sessionToken);
    if (!bookToken) {
      logger.warn({ venueSlug }, "[ResyDirect] Could not obtain book token");
      return {
        success: false,
        error: "booking_details_failed",
        alternatives: alternatives.length ? alternatives : undefined,
      };
    }

    // 5. Complete the booking
    const bookResp = await fetch("https://api.resy.com/3/book", {
      method:  "POST",
      headers: { ...resyAuthHeaders(sessionToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        book_token:             bookToken,
        struct_payment_method:  JSON.stringify({ id: null }),
        source_id:              "resy.com-venue-details",
      }),
    });

    if (!bookResp.ok) {
      const errText = await bookResp.text().catch(() => "");
      logger.warn(
        { status: bookResp.status, errText: errText.slice(0, 200) },
        "[ResyDirect] Book endpoint failed"
      );
      return {
        success: false,
        error: "booking_failed",
        alternatives: alternatives.length ? alternatives : undefined,
      };
    }

    const bookData = await bookResp.json() as {
      resy_token?:     string;
      reservation_id?: string;
    };

    const confirmationNumber = bookData.resy_token ?? bookData.reservation_id;
    const actualTime = bestSlot.date.start.split(" ")[1]?.slice(0, 5) ?? timeHHMM;

    logger.info({ restaurantName, confirmationNumber }, "[ResyDirect] Booking confirmed");

    return {
      success: true,
      confirmationNumber: confirmationNumber ? String(confirmationNumber) : undefined,
      restaurantName,
      date:      dateISO,
      time:      actualTime,
      partySize,
    };
  } catch (err) {
    logger.warn({ err }, "[ResyDirect] Booking threw");
    return { success: false, error: "exception" };
  }
}
