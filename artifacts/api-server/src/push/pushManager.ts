import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";

// ── Ensure expo_push_tokens table exists (idempotent) ────────────────────────
query(`
  CREATE TABLE IF NOT EXISTS expo_push_tokens (
    id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
    user_name text NOT NULL,
    expo_push_token text NOT NULL UNIQUE,
    device_id text,
    user_agent text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )
`).catch((err) => logger.warn({ err }, "[Push] expo_push_tokens table init failed — may already exist"));

// ── contact_push_links: links a contact name to another Winston user account ─
// When David says "remind Sarah to call the dentist", the scheduler looks up
// Sarah's linked_user_name and sends an Expo push to HER devices.
query(`
  CREATE TABLE IF NOT EXISTS contact_push_links (
    id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
    owner_user_name   text NOT NULL,
    contact_name      text NOT NULL,
    linked_user_name  text NOT NULL,
    created_at        timestamptz DEFAULT now(),
    UNIQUE(owner_user_name, linked_user_name)
  )
`).catch((err) => logger.warn({ err }, "[Push] contact_push_links table init failed — may already exist"));

export interface EventDetail {
  id: number;
  venue: string;
  artistOrEvent: string;
  eventDateText: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  icon?: string;
  badge?: string;
  url?: string;
  mapsUrl?: string;                // For departure alerts — full directions URL (origin → destination)
  mapsDeepLink?: string;           // Compact Maps deep-link, preferred on mobile: maps.google.com/?daddr=...
  destination?: string;            // Raw destination address so native app can build its own Maps URL
  reminderId?: number;
  requireInteraction?: boolean;
  silent?: boolean;
  notificationType?: string;       // e.g. "concert-alert", "reminder", "morning", "departure"
  companionMessage?: string;       // What the companion should say/display when notification is tapped
  eventDetails?: EventDetail[];    // For concert-alert: structured event info for the native app
  // Weather-alert specific: tells native app to fetch weather for current GPS, not saved home location
  useCurrentLocation?: boolean;
  alertLat?: number;               // Lat where the alert was issued (home/profile location)
  alertLon?: number;               // Lon where the alert was issued
  alertCity?: string;              // City name for the alert area
  // Full NWS alert details — native app shows these in the weather screen when notification is tapped
  alertHeadline?: string;
  alertDescription?: string;
  alertInstruction?: string;
  alertEvent?: string;
  alertArea?: string;
  alertExpires?: string;
  // Notification action category — maps to a registered Expo notification category on the native app.
  // e.g. "medication-action" shows "Taken ✓" and "Remind in 30 min" buttons.
  categoryId?: string;
  // Optional auto-trigger message — native app sends this text on the user's behalf when tapped,
  // so the briefing/conversation starts immediately without manual input.
  autoSendMessage?: string;
}

/**
 * Send a push notification through all registered Expo push tokens for the
 * given user. Web push (browser/PWA) has been retired — Expo is the sole
 * notification channel for Winston.
 */
export async function sendPushToAll(
  payload: PushPayload,
  userName = NATIVE_USER
): Promise<{ sent: number; failed: number }> {
  const result = await sendExpoNotifications(payload, userName).catch((err) => {
    logger.warn({ err }, "[Push] Expo notification send failed");
    return { sent: 0, failed: 0 };
  });
  logger.info(
    { expoSent: result.sent, expoFailed: result.failed, tag: payload.tag },
    "[Push] sendPushToAll complete"
  );
  return result;
}

// ── Expo Push Token management ────────────────────────────────────────────────

export async function saveExpoToken(
  userName: string,
  expoPushToken: string,
  deviceId?: string,
  userAgent?: string
): Promise<{ id: number | null; action: "inserted" | "updated" }> {
  const { rows } = await query<{ id: number; xmax: string }>(
    `INSERT INTO expo_push_tokens (user_name, expo_push_token, device_id, user_agent, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (expo_push_token) DO UPDATE SET
       user_name   = EXCLUDED.user_name,
       device_id   = EXCLUDED.device_id,
       updated_at  = now()
     RETURNING id, xmax::text`,
    [userName, expoPushToken, deviceId ?? null, userAgent ?? null]
  );
  const row = rows[0];
  if (!row) return { id: null, action: "inserted" };
  const action = row.xmax === "0" ? "inserted" : "updated";
  return { id: row.id, action };
}

export async function removeExpoToken(expoPushToken: string): Promise<void> {
  await query(`DELETE FROM expo_push_tokens WHERE expo_push_token = $1 RETURNING id`, [expoPushToken]);
}

export async function getExpoTokens(userName = NATIVE_USER): Promise<string[]> {
  // Return only the most-recently-updated token per device_id so stale tokens
  // from previous app installs/re-installs don't receive (and fail) every send.
  const { rows } = await query<{ expo_push_token: string }>(
    `SELECT DISTINCT ON (device_id) expo_push_token
       FROM expo_push_tokens
      WHERE user_name = $1
      ORDER BY device_id, updated_at DESC`,
    [userName]
  );
  return rows.map((r) => r.expo_push_token);
}

async function sendExpoNotifications(
  payload: PushPayload,
  userName = NATIVE_USER
): Promise<{ sent: number; failed: number }> {
  const tokens = await getExpoTokens(userName);
  if (!tokens.length) return { sent: 0, failed: 0 };

  const messages = tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    sound: "default",
    priority: "high",
    channelId: "default",
    // categoryId maps to a registered Expo notification category on the native app —
    // enables OS-level action buttons (e.g. "Taken ✓", "Remind in 30 min").
    ...(payload.categoryId ? { categoryId: payload.categoryId } : {}),
    data: {
      // NOTE: do NOT include payload.url (web app URL) here — it causes the native
      // Android app to open the web app in a browser when the notification is tapped.
      // The native app handles taps itself using these structured fields.
      ...(payload.reminderId != null ? { reminderId: payload.reminderId } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
      ...(payload.notificationType ? { notificationType: payload.notificationType } : {}),
      ...(payload.companionMessage ? { companionMessage: payload.companionMessage } : {}),
      ...(payload.eventDetails ? { eventDetails: payload.eventDetails } : {}),
      // Departure alert Maps fields — native app should call Linking.openURL(mapsDeepLink ?? mapsUrl)
      // when notificationType === "departure" and the notification is tapped.
      ...(payload.mapsUrl ? { mapsUrl: payload.mapsUrl } : {}),
      ...(payload.mapsDeepLink ? { mapsDeepLink: payload.mapsDeepLink } : {}),
      ...(payload.destination ? { destination: payload.destination } : {}),
      // Weather-alert: native app should navigate to the weather screen on tap
      ...(payload.useCurrentLocation ? { useCurrentLocation: true } : {}),
      ...(payload.alertLat != null ? { alertLat: payload.alertLat } : {}),
      ...(payload.alertLon != null ? { alertLon: payload.alertLon } : {}),
      ...(payload.alertCity ? { alertCity: payload.alertCity } : {}),
      // Full NWS alert details for display in the native weather screen
      ...(payload.alertHeadline ? { alertHeadline: payload.alertHeadline } : {}),
      ...(payload.alertDescription ? { alertDescription: payload.alertDescription } : {}),
      ...(payload.alertInstruction ? { alertInstruction: payload.alertInstruction } : {}),
      ...(payload.alertEvent ? { alertEvent: payload.alertEvent } : {}),
      ...(payload.alertArea ? { alertArea: payload.alertArea } : {}),
      ...(payload.alertExpires ? { alertExpires: payload.alertExpires } : {}),
      // autoSendMessage: native app sends this text automatically when tapped (no user typing).
      ...(payload.autoSendMessage ? { autoSendMessage: payload.autoSendMessage } : {}),
    },
  }));

  logger.info({ count: messages.length, title: payload.title }, "[Expo Push] Sending notifications");

  let sent = 0;
  let failed = 0;

  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn({ status: res.status, errText }, "[Expo Push] API error response");
      return { sent: 0, failed: tokens.length };
    }

    const result = (await res.json()) as { data: Array<{ status: string; id?: string; details?: { error?: string } }> };
    const tickets = result.data ?? [];

    await Promise.all(
      tickets.map(async (ticket, i) => {
        if (ticket.status === "ok") {
          sent++;
        } else {
          failed++;
          const errorCode = ticket.details?.error;
          logger.warn({ token: tokens[i]?.slice(-20), errorCode }, "[Expo Push] Ticket error");
          // DeviceNotRegistered / InvalidCredentials — token is dead, remove it
          if ((errorCode === "DeviceNotRegistered" || errorCode === "InvalidCredentials") && tokens[i]) {
            await removeExpoToken(tokens[i]).catch(() => {});
            logger.info({ token: tokens[i].slice(-20), errorCode }, "[Expo Push] Removed invalid/unregistered token");
          }
        }
      })
    );
  } catch (err) {
    logger.error({ err }, "[Expo Push] Unexpected error sending notifications");
    failed = tokens.length;
  }

  logger.info({ sent, failed }, "[Expo Push] sendExpoNotifications complete");
  return { sent, failed };
}
