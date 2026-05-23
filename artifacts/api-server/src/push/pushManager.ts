import { query } from "../db.js";
import { logger } from "../lib/logger.js";
import { NATIVE_USER } from "../auth/middleware.js";
import { getProactiveMode, shouldSendPushForMode } from "../proactiveMode/proactiveModeManager.js";

// ── Ensure expo_push_tokens table exists and has all audit columns ────────────
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

// Add audit/failure-tracking columns idempotently so existing rows keep their data.
Promise.all([
  query(`ALTER TABLE expo_push_tokens ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0`),
  query(`ALTER TABLE expo_push_tokens ADD COLUMN IF NOT EXISTS last_failure_at timestamptz`),
  query(`ALTER TABLE expo_push_tokens ADD COLUMN IF NOT EXISTS last_failure_reason text`),
  query(`ALTER TABLE expo_push_tokens ADD COLUMN IF NOT EXISTS last_save_by text`),
]).then(async () => {
  // Log current token state on every server start so disappearances are visible.
  const { rows } = await query<{
    id: number; user_name: string; expo_push_token: string;
    device_id: string | null; failure_count: number;
    last_failure_at: string | null; last_failure_reason: string | null;
    last_save_by: string | null; created_at: string; updated_at: string;
  }>(`SELECT id, user_name, expo_push_token, device_id, failure_count,
             last_failure_at, last_failure_reason, last_save_by,
             created_at, updated_at
        FROM expo_push_tokens ORDER BY updated_at DESC`);
  logger.info(
    {
      count: rows.length,
      tokens: rows.map(r => ({
        id: r.id,
        userName: r.user_name,
        tokenTail: "…" + r.expo_push_token.slice(-20),
        deviceId: r.device_id,
        failureCount: r.failure_count,
        lastFailureAt: r.last_failure_at,
        lastFailureReason: r.last_failure_reason,
        lastSaveBy: r.last_save_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
    "[Push] ── SERVER STARTUP: expo_push_tokens current state ──"
  );
}).catch((err) => logger.warn({ err }, "[Push] expo_push_tokens audit column migration failed"));

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
  /** Set true when the notification is about/from a VIP contact — bypasses mode-based suppression. */
  vipOverride?: boolean;
  deepLink?: string;
  mapsUrl?: string;
  mapsDeepLink?: string;
  destination?: string;
  reminderId?: number;
  requireInteraction?: boolean;
  silent?: boolean;
  notificationType?: string;
  companionMessage?: string;
  eventDetails?: EventDetail[];
  useCurrentLocation?: boolean;
  alertLat?: number;
  alertLon?: number;
  alertCity?: string;
  alertHeadline?: string;
  alertDescription?: string;
  alertInstruction?: string;
  alertEvent?: string;
  alertArea?: string;
  alertExpires?: string;
  // Maps to a registered Expo notification category on the native app.
  // e.g. "medication-action" shows "Taken ✓" and "Remind in 30 min" buttons.
  categoryIdentifier?: string;
  autoSendMessage?: string;
  billId?: number;
  billName?: string;
  amount?: string;
  dueDateISO?: string;
}

// ── Expo Push Token management ────────────────────────────────────────────────

export async function saveExpoToken(
  userName: string,
  expoPushToken: string,
  deviceId?: string,
  userAgent?: string,
  saveBy = "app-registration"
): Promise<{ id: number | null; action: "inserted" | "updated" }> {
  const { rows } = await query<{ id: number; xmax: string }>(
    `INSERT INTO expo_push_tokens (user_name, expo_push_token, device_id, user_agent, updated_at, failure_count, last_failure_at, last_failure_reason, last_save_by)
     VALUES ($1, $2, $3, $4, now(), 0, NULL, NULL, $5)
     ON CONFLICT (expo_push_token) DO UPDATE SET
       user_name           = EXCLUDED.user_name,
       device_id           = EXCLUDED.device_id,
       updated_at          = now(),
       failure_count       = 0,
       last_failure_at     = NULL,
       last_failure_reason = NULL,
       last_save_by        = EXCLUDED.last_save_by
     RETURNING id, xmax::text`,
    [userName, expoPushToken, deviceId ?? null, userAgent ?? null, saveBy]
  );
  const row = rows[0];
  if (!row) {
    logger.error({ userName, tokenTail: "…" + expoPushToken.slice(-20), saveBy }, "[Push] saveExpoToken: INSERT returned no row — token NOT saved");
    return { id: null, action: "inserted" };
  }
  const action = row.xmax === "0" ? "inserted" : "updated";
  logger.info(
    { id: row.id, userName, tokenTail: "…" + expoPushToken.slice(-20), deviceId: deviceId ?? null, saveBy, action },
    `[Push] Token ${action === "inserted" ? "SAVED (new)" : "UPDATED (existing)"} — expo_push_tokens id=${row.id}`
  );
  return { id: row.id, action };
}

export async function removeExpoToken(expoPushToken: string, reason = "explicit-delete"): Promise<void> {
  const { rows } = await query<{ id: number; user_name: string; device_id: string | null }>(
    `DELETE FROM expo_push_tokens WHERE expo_push_token = $1 RETURNING id, user_name, device_id`,
    [expoPushToken]
  );
  if (rows.length > 0) {
    const r = rows[0];
    logger.warn(
      { id: r.id, userName: r.user_name, deviceId: r.device_id, tokenTail: "…" + expoPushToken.slice(-20), reason },
      `[Push] Token DELETED from expo_push_tokens — reason: ${reason}`
    );
  } else {
    logger.info({ tokenTail: "…" + expoPushToken.slice(-20), reason }, "[Push] removeExpoToken: token not found (already gone)");
  }
}

/**
 * Mark a token as failed — logs the failure and increments the counter but
 * NEVER auto-deletes the token.  Tokens are only removed when the native app
 * explicitly calls DELETE /api/push/expo-token.  Re-opening the app always
 * re-registers and resets failure_count to 0, so stale-token blips (Expo
 * service issues, app reinstalls, overnight scheduler runs before the app
 * reconnects) can no longer permanently wipe the token.
 */
async function recordTokenFailure(expoPushToken: string, errorCode: string): Promise<void> {
  const { rows } = await query<{ id: number; failure_count: number; user_name: string; device_id: string | null }>(
    `UPDATE expo_push_tokens
        SET failure_count       = failure_count + 1,
            last_failure_at     = now(),
            last_failure_reason = $2
      WHERE expo_push_token = $1
      RETURNING id, failure_count, user_name, device_id`,
    [expoPushToken, errorCode]
  );
  if (!rows[0]) return;
  const { id, failure_count, user_name, device_id } = rows[0];
  logger.warn(
    { id, userName: user_name, deviceId: device_id, tokenTail: "…" + expoPushToken.slice(-20), errorCode, failureCount: failure_count },
    `[Push] Token failure recorded (${failure_count} total) — token retained, will recover when app re-registers`
  );
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

// ── Shared message builder ────────────────────────────────────────────────────
// Single source of truth for what every Expo push message looks like.
// Both the normal send path and the test endpoints use this so payloads never
// diverge from what the real schedulers send.
export function buildExpoMessages(payload: PushPayload, tokens: string[]) {
  return tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    sound: "default",
    priority: "high",
    channelId: "default",
    // categoryId is the Expo Push API field name (exp.host/--/api/v2/push/send).
    // The client-side SDK calls it categoryIdentifier; the push API calls it categoryId.
    // Using the wrong name causes Expo to silently ignore it, showing no action buttons.
    ...(payload.categoryIdentifier ? { categoryId: payload.categoryIdentifier } : {}),
    data: {
      ...(payload.reminderId != null ? { reminderId: payload.reminderId } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
      ...(payload.notificationType ? { notificationType: payload.notificationType } : {}),
      ...(payload.companionMessage ? { companionMessage: payload.companionMessage } : {}),
      ...(payload.eventDetails ? { eventDetails: payload.eventDetails } : {}),
      ...(payload.mapsUrl ? { mapsUrl: payload.mapsUrl } : {}),
      ...(payload.mapsDeepLink ? { mapsDeepLink: payload.mapsDeepLink } : {}),
      ...(payload.destination ? { destination: payload.destination } : {}),
      ...(payload.useCurrentLocation ? { useCurrentLocation: true } : {}),
      ...(payload.alertLat != null ? { alertLat: payload.alertLat } : {}),
      ...(payload.alertLon != null ? { alertLon: payload.alertLon } : {}),
      ...(payload.alertCity ? { alertCity: payload.alertCity } : {}),
      ...(payload.alertHeadline ? { alertHeadline: payload.alertHeadline } : {}),
      ...(payload.alertDescription ? { alertDescription: payload.alertDescription } : {}),
      ...(payload.alertInstruction ? { alertInstruction: payload.alertInstruction } : {}),
      ...(payload.alertEvent ? { alertEvent: payload.alertEvent } : {}),
      ...(payload.alertArea ? { alertArea: payload.alertArea } : {}),
      ...(payload.alertExpires ? { alertExpires: payload.alertExpires } : {}),
      ...(payload.autoSendMessage ? { autoSendMessage: payload.autoSendMessage } : {}),
      // Mirror categoryIdentifier in data so the native app can always read it from
      // notification.request.content.data regardless of Expo version quirks.
      ...(payload.categoryIdentifier ? { categoryIdentifier: payload.categoryIdentifier } : {}),
      ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
      ...(payload.billId != null ? { billId: payload.billId } : {}),
      ...(payload.billName ? { billName: payload.billName } : {}),
      ...(payload.amount != null ? { amount: payload.amount } : {}),
      ...(payload.dueDateISO ? { dueDateISO: payload.dueDateISO } : {}),
    },
  }));
}

// ── Core Expo HTTP send ───────────────────────────────────────────────────────
// Sends to an explicit list of tokens — no DB lookup. Used by both the normal
// scheduler path and the test endpoints so payloads are always identical.
export async function sendPushToTokens(
  payload: PushPayload,
  tokens: string[]
): Promise<{ sent: number; failed: number }> {
  if (!tokens.length) return { sent: 0, failed: 0 };

  const messages = buildExpoMessages(payload, tokens);
  logger.info({ count: messages.length, title: payload.title }, "[Expo Push] Sending notifications");

  let sent = 0;
  let failed = 0;

  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
          if ((errorCode === "DeviceNotRegistered" || errorCode === "InvalidCredentials") && tokens[i]) {
            await recordTokenFailure(tokens[i], errorCode).catch((e) =>
              logger.warn({ e }, "[Expo Push] recordTokenFailure threw")
            );
          }
        }
      })
    );
  } catch (err) {
    logger.error({ err }, "[Expo Push] Unexpected error sending notifications");
    failed = tokens.length;
  }

  logger.info({ sent, failed }, "[Expo Push] sendPushToTokens complete");
  return { sent, failed };
}

async function sendExpoNotifications(
  payload: PushPayload,
  userName = NATIVE_USER
): Promise<{ sent: number; failed: number }> {
  const tokens = await getExpoTokens(userName);
  return sendPushToTokens(payload, tokens);
}

/**
 * Send a push notification via Expo Push Notification service to all registered
 * native app tokens for the given user.
 *
 * Respects the user's proactive mode — notifications may be suppressed based on
 * their category. Set payload.vipOverride=true to bypass mode suppression for
 * VIP-contact notifications.
 */
export async function sendPushToAll(
  payload: PushPayload,
  userName = NATIVE_USER
): Promise<{ sent: number; failed: number }> {
  try {
    const mode = await getProactiveMode(userName);
    const allowed = shouldSendPushForMode(mode, payload.notificationType, payload.vipOverride);
    if (!allowed) {
      logger.info(
        { userName, mode, notificationType: payload.notificationType, tag: payload.tag },
        "[Push] Suppressed by proactive mode"
      );
      return { sent: 0, failed: 0 };
    }
  } catch {
    // If mode lookup fails, proceed with send (fail open for safety)
  }

  const result = await sendExpoNotifications(payload, userName).catch((err) => {
    logger.warn({ err }, "[Push] Expo notification send failed");
    return { sent: 0, failed: 0 };
  });

  logger.info(
    { sent: result.sent, failed: result.failed, tag: payload.tag },
    "[Push] sendPushToAll complete"
  );
  return result;
}
