import { logger } from "../lib/logger.js";

// ── Apify actor IDs ────────────────────────────────────────────────────────────
const OPENTABLE_ACTOR_ID = "canadesk/opentable";

// ── Global API key (server-level, not per-user) ───────────────────────────────
function getApiKey(): string { return (process.env.APIFY_API_KEY ?? "").trim(); }

export function isApifyApiKeyConfigured(): boolean {
  return !!getApiKey();
}

/** True when the Apify API key is configured (no user credentials needed for guest booking). */
export function isOpenTableReady(): boolean {
  return !!getApiKey();
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

// ── Guest info ────────────────────────────────────────────────────────────────

export interface GuestInfo {
  firstName: string;
  lastName:  string;
  email:     string;
  phone:     string;
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

// ── OpenTable booking (guest mode — no login required) ────────────────────────

/**
 * Book a reservation on OpenTable via the canadesk/opentable Apify actor.
 * Uses guest booking — only the user's name, email, and phone are needed.
 * No OpenTable account or password is required.
 *
 * @param restaurantSlug  OpenTable slug (e.g. "nobu-dallas")
 * @param restaurantName  Human-readable name for notifications
 * @param dateISO         YYYY-MM-DD
 * @param timeHHMM        24-hour HH:MM
 * @param partySize       Party size (≥ 1)
 * @param guest           User's name, email, and phone from their profile
 */
export async function bookViaOpenTable(
  restaurantSlug: string,
  restaurantName: string,
  dateISO:        string,
  timeHHMM:       string,
  partySize:      number,
  guest:          GuestInfo,
): Promise<ApifyBookingResult> {
  if (!isOpenTableReady()) {
    return { success: false, error: "apify_not_configured" };
  }

  logger.info(
    { restaurantSlug, restaurantName, dateISO, timeHHMM, partySize },
    "[Apify] Starting OpenTable guest booking"
  );

  const result = await runActor(OPENTABLE_ACTOR_ID, {
    restaurantSlug,
    restaurantName,
    restaurantId:  restaurantSlug,
    date:          dateISO,
    time:          timeHHMM,
    partySize,
    covers:        partySize,
    // Guest booking fields — no email/password
    firstName:    guest.firstName,
    lastName:     guest.lastName,
    email:        guest.email,
    phone:        guest.phone,
    phoneNumber:  guest.phone,
    guestMode:    true,
    skipLogin:    true,
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
