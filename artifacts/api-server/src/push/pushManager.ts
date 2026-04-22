import webpush from "web-push";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Ensure expo_push_tokens table exists (idempotent) ────────────────────────
query(`
  CREATE TABLE IF NOT EXISTS expo_push_tokens (
    id integer GENERATED ALWAYS AS IDENTITY NOT NULL PRIMARY KEY,
    user_name text DEFAULT 'David' NOT NULL,
    expo_push_token text NOT NULL UNIQUE,
    device_id text,
    user_agent text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )
`).catch((err) => logger.warn({ err }, "[Push] expo_push_tokens table init failed — may already exist"));

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

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  icon?: string;
  badge?: string;
  url?: string;
  reminderId?: number;
  requireInteraction?: boolean;
  silent?: boolean;
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

export async function getSubscriptions(userName = "David"): Promise<PushSubscriptionData[]> {
  const { rows } = await query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_name = $1`,
    [userName]
  );
  return rows;
}

export async function sendPushToAll(
  payload: PushPayload,
  userName = "David"
): Promise<{ sent: number; failed: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logger.warn("VAPID keys not configured — push notifications disabled");
    return { sent: 0, failed: 0 };
  }

  const subs = await getSubscriptions(userName);
  logger.info(
    { count: subs.length, tag: payload.tag, title: payload.title },
    "[Push] sendPushToAll starting"
  );
  if (!subs.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

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
        sent++;
      } catch (err: unknown) {
        const e = err as { statusCode?: number; body?: string; headers?: Record<string, string>; message?: string };
        const status = e.statusCode;
        const responseBody = e.body ?? "(no body)";

        console.log(`PUSH SEND: FCM response status ${status}`);
        console.log(`PUSH SEND: FCM response body ${responseBody}`);
        logger.warn(
          {
            endpoint: endpointShort,
            statusCode: status,
            responseBody,
          },
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

        failed++;
      }
    })
  );

  // Also send to any registered Expo push tokens (native mobile app)
  const expoResult = await sendExpoNotifications(payload, userName).catch((err) => {
    logger.warn({ err }, "[Push] Expo notification send failed");
    return { sent: 0, failed: 0 };
  });

  const totalSent = sent + expoResult.sent;
  const totalFailed = failed + expoResult.failed;
  logger.info(
    { webSent: sent, webFailed: failed, expoSent: expoResult.sent, expoFailed: expoResult.failed, tag: payload.tag },
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

export async function getExpoTokens(userName = "David"): Promise<string[]> {
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
  userName = "David"
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
      ...(payload.reminderId != null ? { reminderId: payload.reminderId } : {}),
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
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
