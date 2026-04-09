import webpush from "web-push";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

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
          { TTL: 60 * 60 * 4 } // 4 hour TTL
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

  logger.info({ sent, failed, tag: payload.tag }, "[Push] sendPushToAll complete");
  return { sent, failed };
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}
