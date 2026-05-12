import { logger } from "../lib/logger.js";
import type { BookingCredentials } from "./bookingCredentialsManager.js";

// ── Apify actor IDs ────────────────────────────────────────────────────────────
const OPENTABLE_ACTOR_ID = "canadesk/opentable";
const RESY_ACTOR_ID      = "clearpath/resy-booker";

// ── Global API key (server-level, not per-user) ───────────────────────────────
function getApiKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }

export function isApifyApiKeyConfigured(): boolean {
  return !!getApiKey();
}

/** True when this user has OpenTable credentials saved AND the global API key exists. */
export function isOpenTableBookingReadyForUser(creds: BookingCredentials): boolean {
  return !!(getApiKey() && creds.openTableEmail && creds.openTablePassword);
}

/** True when this user has Resy credentials saved AND the global API key exists. */
export function isResyBookingReadyForUser(creds: BookingCredentials): boolean {
  return !!(getApiKey() && creds.resyEmail && creds.resyPassword);
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface ApifyBookingResult {
  success: boolean;
  confirmationNumber?: string;
  restaurantName?: string;
  date?: string;
  time?: string;
  partySize?: number;
  /** Returned when the requested slot is taken but alternatives are available. */
  alternatives?: Array<{ time: string }>;
  /** Machine-readable reason when success=false. */
  error?: string;
}

// ── Apify actor runner ────────────────────────────────────────────────────────

/**
 * Call an Apify actor using the synchronous run endpoint.
 * Returns the first dataset item, or null on any error.
 * Timeout is 90 s — safely under Replit proxy limit.
 */
async function runActor(
  actorId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const token = getApiKey();
  if (!token) return null;

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}` +
    `/run-sync-get-dataset-items?token=${token}&timeout=90`;

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(input),
      signal:  AbortSignal.timeout(92_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { actorId, status: res.status, body: body.slice(0, 300) },
        "[Apify] Actor run failed"
      );
      return null;
    }

    const data  = (await res.json()) as unknown;
    const items = Array.isArray(data) ? data : null;
    if (!items || items.length === 0) return null;
    return items[0] as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, actorId }, "[Apify] Actor request threw");
    return null;
  }
}

// ── OpenTable booking ─────────────────────────────────────────────────────────

/**
 * Book a reservation on OpenTable via the canadesk/opentable Apify actor.
 * Credentials are taken from the user's saved profile — never from env vars.
 *
 * @param restaurantSlug  OpenTable slug (e.g. "nobu-dallas")
 * @param restaurantName  Human-readable name for notifications
 * @param dateISO         YYYY-MM-DD
 * @param timeHHMM        24-hour HH:MM
 * @param partySize       Party size (≥ 1)
 * @param creds           Per-user booking credentials from the database
 */
export async function bookViaOpenTable(
  restaurantSlug: string,
  restaurantName: string,
  dateISO: string,
  timeHHMM: string,
  partySize: number,
  creds: BookingCredentials
): Promise<ApifyBookingResult> {
  if (!isOpenTableBookingReadyForUser(creds)) {
    return { success: false, error: "credentials_not_configured" };
  }

  logger.info(
    { restaurantSlug, restaurantName, dateISO, timeHHMM, partySize },
    "[Apify] Starting OpenTable booking"
  );

  const result = await runActor(OPENTABLE_ACTOR_ID, {
    restaurantSlug,
    restaurantName,
    restaurantId: restaurantSlug,
    date:         dateISO,
    time:         timeHHMM,
    partySize,
    covers:       partySize,
    email:        creds.openTableEmail,
    password:     creds.openTablePassword,
    firstName:    "David",
    lastName:     "Lock",
  });

  if (!result) {
    return { success: false, error: "actor_failed" };
  }

  const isSuccess =
    result["success"] === true           ||
    result["status"]  === "confirmed"    ||
    result["status"]  === "CONFIRMED"    ||
    !!result["confirmationNumber"]       ||
    !!result["confirmation_number"]      ||
    !!result["reservationId"];

  if (isSuccess) {
    const conf =
      (result["confirmationNumber"] ??
       result["confirmation_number"] ??
       result["reservationId"] ??
       result["id"]) as string | undefined;
    logger.info({ restaurantName, conf }, "[Apify] OpenTable booking confirmed");
    return {
      success: true,
      confirmationNumber: conf ? String(conf) : undefined,
      restaurantName: (result["restaurantName"] as string | undefined) ?? restaurantName,
      date:      dateISO,
      time:      timeHHMM,
      partySize,
    };
  }

  const rawAlts =
    result["alternatives"] ??
    result["availableTimes"] ??
    result["available_times"] ??
    result["slots"];

  const alternatives = Array.isArray(rawAlts)
    ? (rawAlts as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map((a) => ({ time: String(a["time"] ?? a["timeLabel"] ?? a) }))
    : undefined;

  const errorMsg = String(
    result["error"] ?? result["message"] ?? result["reason"] ?? "unavailable"
  );
  logger.warn({ restaurantName, error: errorMsg, alternatives }, "[Apify] OpenTable booking failed");
  return { success: false, alternatives, error: errorMsg };
}

// ── Resy booking ──────────────────────────────────────────────────────────────

/**
 * Book a reservation on Resy via the clearpath/resy-booker Apify actor.
 * Credentials are taken from the user's saved profile — never from env vars.
 *
 * @param restaurantSlug  Resy venue slug
 * @param citySlug        Resy city slug (e.g. "dal")
 * @param restaurantName  Human-readable name for notifications
 * @param dateISO         YYYY-MM-DD
 * @param timeHHMM        24-hour HH:MM
 * @param partySize       Party size
 * @param creds           Per-user booking credentials from the database
 */
export async function bookViaResy(
  restaurantSlug: string,
  citySlug: string,
  restaurantName: string,
  dateISO: string,
  timeHHMM: string,
  partySize: number,
  creds: BookingCredentials
): Promise<ApifyBookingResult> {
  if (!isResyBookingReadyForUser(creds)) {
    return { success: false, error: "credentials_not_configured" };
  }

  logger.info(
    { restaurantSlug, citySlug, restaurantName, dateISO, timeHHMM, partySize },
    "[Apify] Starting Resy booking"
  );

  const result = await runActor(RESY_ACTOR_ID, {
    restaurantSlug,
    venueSlug:  restaurantSlug,
    venue_id:   restaurantSlug,
    city:       citySlug,
    restaurantName,
    date:       dateISO,
    time:       timeHHMM,
    time_slot:  timeHHMM,
    partySize,
    party_size: partySize,
    seats:      partySize,
    email:      creds.resyEmail,
    password:   creds.resyPassword,
  });

  if (!result) {
    return { success: false, error: "actor_failed" };
  }

  const isSuccess =
    result["success"] === true           ||
    result["status"]  === "confirmed"    ||
    result["status"]  === "CONFIRMED"    ||
    !!result["confirmationNumber"]       ||
    !!result["reservation_id"]           ||
    !!result["resyToken"];

  if (isSuccess) {
    const conf =
      (result["confirmationNumber"] ??
       result["reservation_id"] ??
       result["resyToken"] ??
       result["id"]) as string | undefined;
    logger.info({ restaurantName, conf }, "[Apify] Resy booking confirmed");
    return {
      success: true,
      confirmationNumber: conf ? String(conf) : undefined,
      restaurantName: (result["restaurantName"] as string | undefined) ?? restaurantName,
      date:      dateISO,
      time:      timeHHMM,
      partySize,
    };
  }

  const rawAlts =
    result["alternatives"] ??
    result["availableTimes"] ??
    result["available_times"] ??
    result["slots"];

  const alternatives = Array.isArray(rawAlts)
    ? (rawAlts as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map((a) => ({ time: String(a["time"] ?? a["timeLabel"] ?? a) }))
    : undefined;

  const errorMsg = String(
    result["error"] ?? result["message"] ?? result["reason"] ?? "unavailable"
  );
  logger.warn({ restaurantName, error: errorMsg, alternatives }, "[Apify] Resy booking failed");
  return { success: false, alternatives, error: errorMsg };
}
