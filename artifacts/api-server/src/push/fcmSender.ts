import { getMessaging } from "firebase-admin/messaging";
import { getFcmTokens, removeFcmToken } from "./pushManager.js";
import { logger } from "../lib/logger.js";

export interface FcmNotificationParams {
  userName: string;
  notificationType: "medication" | "bill" | "reminder" | "other";
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendFcmNotification(
  params: FcmNotificationParams
): Promise<{ sent: number; failed: number }> {
  const { userName, notificationType, title, body, data } = params;

  const tokens = await getFcmTokens(userName);
  if (tokens.length === 0) {
    logger.info({ userName }, "[FCM] No FCM tokens registered for user — skipping send");
    return { sent: 0, failed: 0 };
  }

  // FCM data values must all be strings — stringify defensively in case callers
  // pass numbers or booleans through the `data` spread.
  const dataPayload: Record<string, string> = {
    notificationType,
    ...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])),
  };

  const messaging = getMessaging();
  let sent = 0;
  let failed = 0;

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const messageId = await messaging.send({
          token,
          notification: { title, body },
          data: dataPayload,
        });
        sent++;
        logger.info(
          { userName, tokenTail: "…" + token.slice(-20), messageId },
          "[FCM] Notification sent"
        );
      } catch (err: unknown) {
        failed++;
        const code = (err as { code?: string })?.code ?? "unknown";
        logger.warn(
          { userName, tokenTail: "…" + token.slice(-20), code, err },
          "[FCM] Send failed for token — skipping"
        );
        // These two codes are definitive: the token is permanently invalid and
        // will never succeed. Hard-delete it so dead tokens don't accumulate.
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          await removeFcmToken(token, code).catch((e) =>
            logger.warn({ e }, "[FCM] removeFcmToken threw during cleanup")
          );
        }
      }
    })
  );

  logger.info({ userName, sent, failed, notificationType }, "[FCM] sendFcmNotification complete");
  return { sent, failed };
}
