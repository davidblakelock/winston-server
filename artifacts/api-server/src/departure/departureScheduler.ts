import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, getCompanionDisplayName, type CollectedData } from "../onboarding/onboardingManager.js";
import {
  estimateDriveTime,
  shouldFireAlert,
  buildDepartureAlertMessage,
  extractEventLocation,
  computeLeaveAt,
} from "./departureManager.js";
import { fetchTodayEvents } from "../google/calendar.js";
import { query } from "../db.js";
import { NATIVE_STORED_NAME } from "../auth/middleware.js";
import {
  searchNearbyVenueTypes,
  buildNeighborhoodBrief,
} from "../maps/googleMapsIntel.js";

// ── Schema migration: add user_name to departure_alert_log if missing ─────────
query(`ALTER TABLE departure_alert_log ADD COLUMN IF NOT EXISTS user_name text NOT NULL DEFAULT '${NATIVE_STORED_NAME}'`)
  .catch(() => {});
query(`ALTER TABLE departure_alert_log ADD COLUMN IF NOT EXISTS event_start_iso text`)
  .catch(() => {});

function localDateStr(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// ── In-memory set to avoid double-firing ─────────────────────────────────────
const _alertedToday = new Set<string>();

async function hasAlertBeenSent(eventTitle: string, eventDate: string, eventStartIso: string, userName: string): Promise<boolean> {
  const key = `${userName}::${eventTitle}::eventDate::${eventDate}::${eventStartIso}`;
  if (_alertedToday.has(key)) return true;

  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM departure_alert_log
       WHERE event_title = $1 AND event_date = $2 AND event_start_iso = $3 AND user_name = $4`,
      [eventTitle, eventDate, eventStartIso, userName]
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventTitle: string, eventDate: string, eventStartIso: string, userName: string): Promise<void> {
  const key = `${userName}::${eventTitle}::eventDate::${eventDate}::${eventStartIso}`;
  _alertedToday.add(key);

  try {
    await query(
      `INSERT INTO departure_alert_log (event_title, event_date, event_start_iso, user_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [eventTitle, eventDate, eventStartIso, userName]
    );
  } catch {}
}

// ── Clear in-memory set at midnight ──────────────────────────────────────────
let _lastDay: string | null = null;
function clearIfNewDay() {
  const today = localDateStr("America/Chicago");
  if (_lastDay !== today) {
    _alertedToday.clear();
    _lastDay = today;
  }
}

// ── Per-user check ────────────────────────────────────────────────────────────
async function checkDepartureAlertsForUser(userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
  const tz = profile?.timezone ?? "America/Chicago";
  const displayName = profile?.name ?? userName;
  const homeAddress = profile?.homeAddress ?? ((profile?.rawData as CollectedData)?.homeAddress) ?? "";
  const homeLat = (profile?.homeLatitude && profile.homeLatitude !== 0 ? profile.homeLatitude : null)
    ?? (profile?.latitude && profile.latitude !== 0 ? profile.latitude : null)
    ?? 32.7767;
  const homeLon = (profile?.homeLongitude && profile.homeLongitude !== 0 ? profile.homeLongitude : null)
    ?? (profile?.longitude && profile.longitude !== 0 ? profile.longitude : null)
    ?? -96.7970;

  // If no text address, fall back to "lat,lon" — Google Maps Directions API accepts coordinates as origin.
  // This unblocks users who have GPS coordinates saved but never filled in a street address.
  const effectiveHomeAddress = homeAddress || `${homeLat},${homeLon}`;
  if (!effectiveHomeAddress) {
    logger.warn({ userName }, "Departure check skipped — no home address or coordinates in profile");
    return;
  }
  if (!homeAddress) {
    logger.info({ userName, effectiveHomeAddress }, "Departure check: using coordinate fallback for home address");
  }

  let events: Awaited<ReturnType<typeof fetchTodayEvents>>;
  try {
    events = await fetchTodayEvents(userName);
  } catch {
    return;
  }

  if (!events) return;

  const now = new Date();
  const today = localDateStr(tz);

  for (const event of events) {
    if (!event.summary || event.allDay || !event.startIso) {
      logger.info({ event: event.summary ?? "(no summary)", allDay: event.allDay, userName }, "[DepartureAlert] Skipping event — allDay, missing summary, or missing startIso");
      continue;
    }
    const start = new Date(event.startIso);

    const minutesUntilEvent = (start.getTime() - now.getTime()) / 60000;
    // Pre-filter: allow up to 4 hours out so long drives (up to ~3.5h) are covered.
    if (minutesUntilEvent < 0 || minutesUntilEvent > 240) {
      logger.info({ event: event.summary, minutesUntilStart: Math.round(minutesUntilEvent), userName }, "[DepartureAlert] Skipping event — outside 0–240 minute window");
      continue;
    }

    const location = extractEventLocation({
      summary: event.summary,
      location: event.location,
      description: event.description,
    });
    if (!location) {
      logger.info({ event: event.summary, userName }, "Departure check: event has no location — skipping");
      continue;
    }

    const alreadySent = await hasAlertBeenSent(event.summary, today, event.startIso, userName);
    if (alreadySent) {
      logger.info({ event: event.summary, eventDate: today, userName }, "[DepartureAlert] Skipping event — alert already sent today");
      continue;
    }

    const drive = await estimateDriveTime(location, effectiveHomeAddress, homeLat, homeLon);
    if (!drive) {
      logger.info({ event: event.summary, origin: effectiveHomeAddress, destination: location, userName }, "[DepartureAlert] Skipping event — estimateDriveTime returned null");
      continue;
    }

    const fire = shouldFireAlert(start, drive.durationMinutes, now);
    if (!fire) {
      logger.info({ event: event.summary, minutesUntilStart: Math.round(minutesUntilEvent), driveDurationMinutes: drive.durationMinutes, userName }, "[DepartureAlert] Skipping event — shouldFireAlert returned false");
      continue;
    }

    const baseMessage = buildDepartureAlertMessage(
      event.summary,
      start,
      drive.durationMinutes,
      location,
      drive.source === "google-maps",
      displayName
    );

    const companionName = getCompanionDisplayName(profile?.companionPersona, profile?.companionName);

    // Universal Google Maps navigation URL — opens native Maps app on iOS/Android
    // when tapped via Linking.openURL; falls back to browser on web.
    // No &origin= — omitting it tells Google Maps to use the device's current
    // GPS location as the starting point, which is correct for a departure alert
    // (the user may not be at home when they tap it).
    const mapsUrl =
      `https://www.google.com/maps/dir/?api=1` +
      `&destination=${encodeURIComponent(location)}` +
      `&travelmode=driving`;

    // Compact deep-link variant: more likely to trigger the native Maps app
    // directly on iOS and Android without a browser redirect.
    const mapsDeepLink =
      `https://maps.google.com/?daddr=${encodeURIComponent(location)}&dirflg=d`;

    const eventTimeStr = start.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const leaveAt = computeLeaveAt(start, drive.durationMinutes);
    const leaveTimeStr = leaveAt.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const roundedMins = Math.round(drive.durationMinutes / 5) * 5 || 5;
    const trafficLabel = drive.source === "google-maps" ? "w/ traffic" : "est.";

    // ── Neighborhood intelligence — parking + nearby spots ──────────────────
    let neighborhoodBrief: string | null = null;
    try {
      const userPrefs = (profile?.hobbies ?? [])
        .filter((i) => /bar|cocktail|coffee|wine|drink|whiskey/i.test(i))
        .slice(0, 4);

      // Pick the most relevant nearby category based on event time
      const eventHour = start.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      const nearbyType = parseInt(eventHour, 10) >= 17 ? "cocktail bar" : "coffee shop";

      const nearbyData = await searchNearbyVenueTypes(location, ["parking", nearbyType], 2);

      const hasParking = (nearbyData.get("parking") ?? []).length > 0;
      const hasNearby = (nearbyData.get(nearbyType) ?? []).length > 0;

      if (hasParking || hasNearby) {
        neighborhoodBrief = await buildNeighborhoodBrief(
          event.summary,
          eventTimeStr,
          leaveTimeStr,
          drive.durationMinutes,
          location,
          nearbyData,
          userPrefs
        );
        logger.info(
          { event: event.summary, hasParking, hasNearby, hasBrief: !!neighborhoodBrief },
          "[NeighborhoodIntel] Brief built"
        );
      }
    } catch (err) {
      logger.warn({ err }, "[NeighborhoodIntel] Failed to build neighborhood brief — using base alert");
    }

    const message = neighborhoodBrief ?? baseMessage;
    const pushBody = neighborhoodBrief
      ? neighborhoodBrief.replace(/\n+/g, " ").slice(0, 160)
      : `${roundedMins} min ${trafficLabel} · Leave now for ${eventTimeStr}${location.length < 50 ? ` · ${location}` : ""}`;

    broadcastToUser(userName, "reminder", {
      id: `departure-${event.summary}-${Date.now()}`,
      userName,
      reminderText: message,
      speakText: message,
      isDeparture: true,
      mapsUrl,
    });

    logger.info(
      { event: event.summary, userName, payload: { action: "open_url", url: mapsUrl, mapsDeepLink, destination: location } },
      "[DepartureAlert] FCM payload"
    );

    sendFcmNotification({
      userName,
      notificationType: "departure",
      title: `🚗 Leave by ${leaveTimeStr} — ${event.summary}`,
      body: pushBody,
      data: {
        action: "open_url",
        url: mapsUrl,
        mapsDeepLink,
        destination: location,
      },
    }).catch(() => {});

    await markAlertSent(event.summary, today, event.startIso, userName);

    logger.info(
      { event: event.summary, driveMinutes: drive.durationMinutes, source: drive.source, userName },
      "Departure alert fired"
    );
  }
}

// ── Main scheduler check ──────────────────────────────────────────────────────
async function checkDepartureAlerts(): Promise<void> {
  clearIfNewDay();
  try {
    const users = await getActiveUsers();
    if (users.length === 0) return;
    await Promise.allSettled(users.map((u) => checkDepartureAlertsForUser(u.userName)));
  } catch (err) {
    logger.warn({ err }, "Departure scheduler: failed to load active users");
  }
}

export function startDepartureScheduler(): void {
  let _running = false;
  cron.schedule("*/10 * * * *", async () => {
    if (_running) return;
    _running = true;
    try {
      await checkDepartureAlerts();
    } catch (err) {
      logger.error({ err }, "Departure scheduler error");
    } finally {
      _running = false;
    }
  });

  logger.info("Departure alert scheduler started");
}
