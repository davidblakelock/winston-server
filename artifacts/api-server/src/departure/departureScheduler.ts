import cron from "node-cron";
import { broadcastToUser } from "../reminders/sseStore.js";
import { sendPushToAll } from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { getProfile, getActiveUsers, type CollectedData } from "../onboarding/onboardingManager.js";
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

const TZ = "America/Chicago";

async function getCompanionName(userName: string): Promise<string> {
  const profile = await getProfile(userName).catch(() => null);
  return profile?.companionName ?? "Your Companion";
}

function localDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// ── In-memory set to avoid double-firing ─────────────────────────────────────
const _alertedToday = new Set<string>();

async function hasAlertBeenSent(eventTitle: string, eventDate: string, userName: string): Promise<boolean> {
  const key = `${userName}::${eventTitle}::${eventDate}`;
  if (_alertedToday.has(key)) return true;

  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM departure_alert_log
       WHERE event_title = $1 AND event_date = $2 AND user_name = $3`,
      [eventTitle, eventDate, userName]
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  } catch {
    return false;
  }
}

async function markAlertSent(eventTitle: string, eventDate: string, userName: string): Promise<void> {
  const key = `${userName}::${eventTitle}::${eventDate}`;
  _alertedToday.add(key);

  try {
    await query(
      `INSERT INTO departure_alert_log (event_title, event_date, user_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [eventTitle, eventDate, userName]
    );
  } catch {}
}

// ── Clear in-memory set at midnight ──────────────────────────────────────────
let _lastDay: string | null = null;
function clearIfNewDay() {
  const today = localDateStr();
  if (_lastDay !== today) {
    _alertedToday.clear();
    _lastDay = today;
  }
}

// ── Per-user check ────────────────────────────────────────────────────────────
async function checkDepartureAlertsForUser(userName: string): Promise<void> {
  const profile = await getProfile(userName).catch(() => null);
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
  const today = localDateStr();

  for (const event of events) {
    if (!event.summary || event.allDay || !event.startIso) continue;
    const start = new Date(event.startIso);

    const minutesUntilEvent = (start.getTime() - now.getTime()) / 60000;
    // Pre-filter: allow up to 4 hours out so long drives (up to ~3.5h) are covered.
    if (minutesUntilEvent < 0 || minutesUntilEvent > 240) continue;

    const location = extractEventLocation({
      summary: event.summary,
      location: event.location,
      description: event.description,
    });
    if (!location) {
      logger.info({ event: event.summary, userName }, "Departure check: event has no location — skipping");
      continue;
    }

    const alreadySent = await hasAlertBeenSent(event.summary, today, userName);
    if (alreadySent) continue;

    const drive = await estimateDriveTime(location, effectiveHomeAddress, homeLat, homeLon);
    if (!drive) continue;

    const fire = shouldFireAlert(start, drive.durationMinutes, now);
    if (!fire) continue;

    const baseMessage = buildDepartureAlertMessage(
      event.summary,
      start,
      drive.durationMinutes,
      location,
      drive.source === "google-maps",
      displayName
    );

    const companionName = await getCompanionName(userName);

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
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const leaveAt = computeLeaveAt(start, drive.durationMinutes);
    const leaveTimeStr = leaveAt.toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const roundedMins = Math.round(drive.durationMinutes / 5) * 5 || 5;
    const trafficLabel = drive.source === "google-maps" ? "w/ traffic" : "est.";

    // ── Neighborhood intelligence — parking + nearby spots ──────────────────
    let neighborhoodBrief: string | null = null;
    try {
      const rawData = profile?.rawData as { foodPreferences?: string[]; interests?: string[] } | null;
      const userPrefs = [
        ...(rawData?.foodPreferences ?? []),
        ...(rawData?.interests ?? []).filter((i) => /bar|cocktail|coffee|wine|drink|whiskey/i.test(i)),
      ].slice(0, 4);

      // Pick the most relevant nearby category based on event time
      const eventHour = start.toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false });
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

    await sendPushToAll({
      title: `🚗 Leave by ${leaveTimeStr} — ${event.summary}`,
      body: pushBody,
      tag: `departure-${userName}-${event.summary}`,
      url: mapsUrl,             // web push click action
      mapsUrl,                  // native app: open via Linking.openURL on tap
      mapsDeepLink,             // compact Maps deep-link (preferred on mobile)
      destination: location,    // raw destination for native app to build its own URL
      notificationType: "departure",
      categoryIdentifier: "departure-action",  // native app registered category for tap → Maps
      requireInteraction: true,
    }, userName).catch(() => {});

    await markAlertSent(event.summary, today, userName);

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
  cron.schedule("*/2 * * * *", async () => {
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
