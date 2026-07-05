/**
 * Push notification routes — Expo only.
 *
 * All notifications go through the Expo Push Notification service to the
 * native Android app. There is no web/browser frontend.
 *
 * Routes:
 *   POST   /push/expo-token        Register an Expo push token
 *   DELETE /push/expo-token        Remove an Expo push token
 *   GET    /push/expo-status       Diagnostic: list registered Expo tokens
 *   GET    /push/calendar-debug    Full diagnostic: Google auth + calendar + Expo tokens
 */

import { Router } from "express";
import { maybeSendMorningPushOnTokenRegistration } from "../push/morningPushScheduler.js";
import {
  saveExpoToken,
  removeExpoToken,
  getExpoTokens,
  saveFcmToken,
} from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { tryAuthenticate, authenticate, NATIVE_USER, resolveUserAlias } from "../auth/middleware.js";
import { sendFcmNotification } from "../push/fcmSender.js";
import { getAuthClientForUser } from "../google/oauth.js";
import { fetchTodayEvents } from "../google/calendar.js";

const router = Router();

// POST /api/push/expo-token — register an Expo push token from the native app
router.post("/push/expo-token", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const { expoPushToken, userName: bodyUserName, deviceId } = req.body as {
    expoPushToken?: string;
    userName?: string;
    deviceId?: string;
  };
  const userName = authedUser ?? (resolveUserAlias(bodyUserName ?? "") || NATIVE_USER);

  if (!expoPushToken || typeof expoPushToken !== "string") {
    res.status(400).json({ error: "Missing expoPushToken" });
    return;
  }
  if (!expoPushToken.startsWith("ExponentPushToken[") && !expoPushToken.startsWith("ExpoPushToken[")) {
    res.status(400).json({ error: "Invalid expoPushToken format — expected ExponentPushToken[...] or ExpoPushToken[...]" });
    return;
  }

  try {
    const userAgent = (req.headers["user-agent"] ?? "unknown").slice(0, 200);
    const { id, action } = await saveExpoToken(userName, expoPushToken, deviceId, userAgent);
    logger.info({ userName, deviceId, tokenTail: expoPushToken.slice(-20), id, action }, "[Expo Push] Token registered");
    res.json({ success: true, id, action });
    // If it's still within the morning wake window and the push hasn't fired yet
    // (because the server had no token at 6 AM), send it now immediately.
    maybeSendMorningPushOnTokenRegistration(userName).catch(() => {});
  } catch (err) {
    logger.error({ err }, "[Expo Push] Failed to save token");
    res.status(500).json({ error: "Failed to save Expo push token" });
  }
});

// POST /api/push/fcm-token — register a native FCM token from the native app
router.post("/push/fcm-token", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const { fcmToken, userName: bodyUserName, deviceId } = req.body as {
    fcmToken?: string;
    userName?: string;
    deviceId?: string;
  };
  const userName = authedUser ?? (resolveUserAlias(bodyUserName ?? "") || NATIVE_USER);

  if (!fcmToken || typeof fcmToken !== "string" || !fcmToken.trim()) {
    res.status(400).json({ error: "Missing or empty fcmToken" });
    return;
  }

  try {
    const { action } = await saveFcmToken(userName, fcmToken.trim(), deviceId);
    logger.info({ userName, deviceId, action }, "[FCM Push] Token registered");
    res.json({ success: true, action });
  } catch (err) {
    logger.error({ err }, "[FCM Push] Failed to save token");
    res.status(500).json({ error: "Failed to save FCM token" });
  }
});

// DELETE /api/push/expo-token — remove an Expo push token (on logout / unsubscribe)
router.delete("/push/expo-token", async (req, res) => {
  const { expoPushToken } = req.body as { expoPushToken?: string };
  if (!expoPushToken) {
    res.status(400).json({ error: "Missing expoPushToken" });
    return;
  }
  try {
    const userAgent = (req.headers["user-agent"] ?? "unknown").slice(0, 200);
    const ip = (req.headers["x-forwarded-for"] as string | undefined) ?? req.socket.remoteAddress ?? "unknown";
    req.log.warn({ tokenTail: expoPushToken.slice(-20), userAgent, ip }, "[Expo Push] DELETE /push/expo-token called — explicit token removal requested");
    await removeExpoToken(expoPushToken, `DELETE /api/push/expo-token — ua=${userAgent.slice(0, 80)} ip=${ip}`);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Failed to remove token");
    res.status(500).json({ error: "Failed to remove Expo push token" });
  }
});

// GET /api/push/expo-status — diagnostic: list registered Expo tokens with full audit data
router.get("/push/expo-status", async (req, res) => {
  try {
    const authedUser = await tryAuthenticate(req);
    const rawQueryUser = req.query.userName as string | undefined;
    const userName = authedUser ?? (rawQueryUser ? resolveUserAlias(rawQueryUser) : null) ?? NATIVE_USER;
    const { query: dbQuery } = await import("../db.js");
    const { rows } = await dbQuery<{
      id: number; expo_push_token: string; device_id: string | null;
      failure_count: number; last_failure_at: string | null;
      last_failure_reason: string | null; last_save_by: string | null;
      created_at: string; updated_at: string;
    }>(`SELECT id, expo_push_token, device_id, failure_count,
               last_failure_at, last_failure_reason, last_save_by,
               created_at, updated_at
          FROM expo_push_tokens
         WHERE user_name = $1
         ORDER BY updated_at DESC`, [userName]);
    res.json({
      userName,
      tokenCount: rows.length,
      tokens: rows.map((r) => ({
        id: r.id,
        tokenTail: "…" + r.expo_push_token.slice(-20),
        deviceId: r.device_id,
        failureCount: r.failure_count,
        lastFailureAt: r.last_failure_at,
        lastFailureReason: r.last_failure_reason,
        lastSaveBy: r.last_save_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Status check error");
    res.status(500).json({ error: "Status check failed" });
  }
});

// GET /api/push/calendar-debug — full diagnostic: Google auth + calendar + Expo tokens
router.get("/push/calendar-debug", async (req, res) => {
  const authedUser = await tryAuthenticate(req);
  const userName = authedUser ?? (req.query.userName as string | undefined) ?? NATIVE_USER;

  const result: Record<string, unknown> = { userName, ts: new Date().toISOString() };

  let authClient: Awaited<ReturnType<typeof getAuthClientForUser>> | null = null;
  try {
    authClient = await getAuthClientForUser(userName);
    result.authClientOk = !!authClient;
  } catch (err) {
    result.authClientOk = false;
    result.authClientError = (err as Error)?.message ?? String(err);
    res.json(result);
    return;
  }

  if (authClient) {
    try {
      const tokenResp = await authClient.getAccessToken();
      result.accessTokenOk = !!tokenResp?.token;
      result.accessTokenPrefix = tokenResp?.token ? tokenResp.token.slice(0, 20) + "…" : null;
    } catch (err) {
      result.accessTokenOk = false;
      result.accessTokenError = (err as Error)?.message ?? String(err);
    }
  }

  try {
    const events = await fetchTodayEvents(userName);
    result.eventsNull = events === null;
    result.eventCount = events?.length ?? 0;
    result.events = events?.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      startIso: e.startIso,
      hasLocation: !!(e.location || e.description),
      allDay: e.allDay,
    })) ?? [];
  } catch (err) {
    result.fetchEventsError = (err as Error)?.message ?? String(err);
  }

  try {
    const tokens = await getExpoTokens(userName);
    result.expoTokenCount = tokens.length;
    result.expoTokenTails = tokens.map((t) => "…" + t.slice(-20));
  } catch (err) {
    result.expoTokenError = (err as Error)?.message ?? String(err);
  }

  logger.info(result, "[CalendarDebug] Full diagnostic result");
  res.json(result);
});

// POST /api/push/test-medication — send a test medication push to the authenticated user
router.post("/push/test-medication", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const result = await sendFcmNotification({
      userName,
      notificationType: "medication",
      title: "Time for your medications 💊",
      body: "Good morning — have you taken your medications?",
    });
    logger.info({ userName, ...result }, "[FCM Push] Test medication push sent");
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "[FCM Push] Test medication push failed");
    res.status(500).json({ error: "Failed to send test push" });
  }
});

// POST /api/push/test-bill — send a test bill push using the authenticated user's first upcoming bill
router.post("/push/test-bill", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  const { getUpcomingBills, computeNextDueDate, buildBillReminderMessage } = await import("../bills/billManager.js");
  const { getProfile } = await import("../onboarding/onboardingManager.js");
  try {
    const upcoming = await getUpcomingBills(90, userName);
    if (!upcoming.length) {
      res.status(404).json({ error: "No upcoming active bills found" });
      return;
    }

    const bill = upcoming[0];
    const nextDueDate = computeNextDueDate(bill);
    const profile = await getProfile(userName);
    const displayName = profile?.name ?? userName;

    const dueDateISO = nextDueDate.toISOString().split("T")[0];
    const daysUntil = bill.daysUntilDue ?? 0;
    const amountLabel = bill.amount ? ` · $${bill.amount}` : "";

    const result = await sendFcmNotification({
      userName,
      notificationType: "bill",
      title: `${bill.name}${amountLabel} due ${daysUntil === 0 ? "today" : `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`}`,
      body: buildBillReminderMessage(bill, displayName),
      data: {
        billId: String(bill.id),
        billName: bill.name,
        amount: bill.amount ?? "",
        dueDateISO,
      },
    });
    logger.info({ userName, ...result }, "[FCM Push] Test bill push sent");
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "[FCM Push] Test bill push failed");
    res.status(500).json({ error: "Failed to send test bill push" });
  }
});

// POST /api/push/test-departure — send a test departure FCM push to the authenticated user
router.post("/push/test-departure", async (req, res) => {
  const userName = await authenticate(req, res);
  if (!userName) return;
  try {
    const result = await sendFcmNotification({
      userName,
      notificationType: "departure",
      title: "🚗 Test Departure",
      body: "Tap to open Google Maps",
      data: {
        action: "open_url",
        url: "https://www.google.com/maps/dir/?api=1&destination=Test+Destination&travelmode=driving",
        mapsDeepLink: "https://maps.google.com/?daddr=Test+Destination&dirflg=d",
        destination: "Test Destination",
      },
    });
    logger.info({ userName, ...result }, "[FCM Push] Test departure push sent");
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "[FCM Push] Test departure push failed");
    res.status(500).json({ error: "Failed to send test departure push" });
  }
});

export default router;
