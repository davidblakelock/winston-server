import webpush from "web-push";
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

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? "emma@winston.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${VAPID_EMAIL}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

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
  mapsUrl?: string;                // For departure alerts — passed to native app to trigger Maps navigation
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
}

export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function saveSubscription(
  userName: string,
  sub: PushSubscriptionData,
  userAgent?: string,
  deviceId?: string
): Promise<number | null> {
  const { id } = await saveSubscriptionWithAction(userName, sub, userAgent, deviceId);
  return id;
}

export async function saveSubscriptionWithAction(
  userName: string,
  sub: PushSubscriptionData,
  userAgent?: string,
  deviceId?: string
): Promise<{ id: number | null; action: "inserted" | "updated" }> {
  // Use xmax to detect insert vs update
  const { rows } = await query<{ id: number; xmax: string }>(
    `INSERT INTO push_subscriptions (user_name, endpoint, p256dh, auth, user_agent, device_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_name, device_id) WHERE device_id IS NOT NULL DO UPDATE SET
       endpoint   = EXCLUDED.endpoint,
       p256dh     = EXCLUDED.p256dh,
       auth       = EXCLUDED.auth,
       updated_at = now()
     RETURNING id, xmax::text`,
    [userName, sub.endpoint, sub.p256dh, sub.auth, userAgent ?? null, deviceId ?? null]
  );
  const row = rows[0];
  if (!row) return { id: null, action: "inserted" };
  // xmax = 0 means inserted; non-zero means updated
  const action = row.xmax === "0" ? "inserted" : "updated";
  return { id: row.id, action };
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

export async function getSubscriptions(userName = NATIVE_USER): Promise<PushSubscriptionData[]> {
  const { rows } = await query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_name = $1`,
    [userName]
  );
  return rows;
}

export async function sendPushToAll(
  payload: PushPayload,
  userName = NATIVE_USER
): Promise<{ sent: number; failed: number }> {
  let webSent = 0;
  let webFailed = 0;

  // ── Web push (browser/PWA) — requires VAPID keys ──────────────────────────
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    const subs = await getSubscriptions(userName);
    logger.info(
      { webSubCount: subs.length, tag: payload.tag, title: payload.title },
      "[Push] sendPushToAll starting"
    );

    if (subs.length > 0) {
      // Do NOT include url/icon/badge from the API server domain — those would point
      // to the wrong origin. The service worker uses self.registration.scope (the
      // Winston frontend URL) as its fallback for all of these, which is always correct.
      const notificationData: Record<string, unknown> = {
        title: payload.title,
        body: payload.body,
        tag: payload.tag ?? "winston",
        requireInteraction: payload.requireInteraction ?? false,
        silent: payload.silent ?? false,
      };
      if (payload.url) notificationData.url = payload.url;
      if (payload.icon) notificationData.icon = payload.icon;
      if (payload.badge) notificationData.badge = payload.badge;
      if (payload.reminderId != null) notificationData.reminderId = payload.reminderId;
      if (payload.notificationType) notificationData.notificationType = payload.notificationType;
      if (payload.companionMessage) notificationData.companionMessage = payload.companionMessage;
      if (payload.eventDetails) notificationData.eventDetails = payload.eventDetails;
      const body = JSON.stringify(notificationData);

      await Promise.all(
        subs.map(async (sub) => {
          const endpointShort = sub.endpoint.slice(-40);
          const endpoint50 = sub.endpoint.slice(0, 50);

          console.log(`PUSH SEND: attempting to send to endpoint ${endpoint50}`);
          logger.info({ endpoint: endpointShort }, "[Push] Attempting delivery");

          try {
            const result = await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body,
              {
                TTL: 60 * 60 * 4, // 4 hour TTL
                urgency: "high",  // bypass Android Doze mode — default "normal" defers delivery when screen is off
              }
            );
            console.log(`PUSH SEND: FCM response status ${result.statusCode}`);
            console.log(`PUSH SEND: FCM response body ${result.body || "(empty)"}`);
            logger.info(
              {
                endpoint: endpointShort,
                statusCode: result.statusCode,
                body: result.body ?? "(empty)",
              },
              "[Push] FCM accepted"
            );
            webSent++;
          } catch (err: unknown) {
            const e = err as { statusCode?: number; body?: string; headers?: Record<string, string>; message?: string };
            const status = e.statusCode;
            const responseBody = e.body ?? "(no body)";

            console.log(`PUSH SEND: FCM response status ${status}`);
            console.log(`PUSH SEND: FCM response body ${responseBody}`);
            logger.warn(
              { endpoint: endpointShort, statusCode: status, responseBody },
              "[Push] FCM error response"
            );

            // 410 = subscription gone (browser unsubscribed)
            // 404 = subscription not found on FCM
            // 400 = malformed / invalid subscription (often means VAPID key mismatch
            //       or the subscription was created against a different VAPID key)
            if (status === 410 || status === 404 || status === 400) {
              await removeSubscription(sub.endpoint).catch((dbErr) => {
                logger.error({ dbErr, endpoint: endpointShort }, "[Push] Failed to delete expired subscription from DB");
              });
              console.log(`PUSH SEND: removed invalid/expired subscription from Supabase — status ${status} — endpoint ${endpoint50}`);
              logger.info(
                { endpoint: endpointShort, statusCode: status, reason: status === 400 ? "invalid/VAPID-mismatch" : "expired" },
                "[Push] Removed invalid/expired subscription from Supabase"
              );
            }

            webFailed++;
          }
        })
      );
    }
  } else {
    logger.warn("[Push] VAPID keys not configured — web push disabled (Expo will still be attempted)");
  }

  // ── Expo push (native mobile) — always attempted, independent of VAPID ────
  const expoResult = await sendExpoNotifications(payload, userName).catch((err) => {
    logger.warn({ err }, "[Push] Expo notification send failed");
    return { sent: 0, failed: 0 };
  });

  const totalSent = webSent + expoResult.sent;
  const totalFailed = webFailed + expoResult.failed;
  logger.info(
    { webSent, webFailed, expoSent: expoResult.sent, expoFailed: expoResult.failed, tag: payload.tag },
    "[Push] sendPushToAll complete"
  );
  return { sent: totalSent, failed: totalFailed };
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

// ── Expo Push Notification support ───────────────────────────────────────────

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
  await query(`DELETE FROM expo_push_tokens WHERE expo_push_token = $1`, [expoPushToken]);
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
    data: {
      // NOTE: do NOT include payload.url (web app URL) here — it causes the native
      // Android app to open the web app in a browser when the notification is tapped.
      // The native app handles taps itself using these structured fields.
      ...(payload.reminderId != null ? { reminderId: payload.reminderId } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
      ...(payload.notificationType ? { notificationType: payload.notificationType } : {}),
      ...(payload.companionMessage ? { companionMessage: payload.companionMessage } : {}),
      ...(payload.eventDetails ? { eventDetails: payload.eventDetails } : {}),
      // mapsUrl is a Google Maps directions link — native app should open it via Linking.openURL
      ...(payload.mapsUrl ? { mapsUrl: payload.mapsUrl } : {}),
      // Weather-alert: native app should acquire GPS and call /api/weather/morning?lat=X&lon=Y
      ...(payload.useCurrentLocation ? { useCurrentLocation: true } : {}),
      ...(payload.alertLat != null ? { alertLat: payload.alertLat } : {}),
      ...(payload.alertLon != null ? { alertLon: payload.alertLon } : {}),
      ...(payload.alertCity ? { alertCity: payload.alertCity } : {}),
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
