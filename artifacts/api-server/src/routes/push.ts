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
import {
  saveExpoToken,
  removeExpoToken,
  getExpoTokens,
} from "../push/pushManager.js";
import { logger } from "../lib/logger.js";
import { tryAuthenticate, NATIVE_USER, resolveUserAlias } from "../auth/middleware.js";
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
  } catch (err) {
    logger.error({ err }, "[Expo Push] Failed to save token");
    res.status(500).json({ error: "Failed to save Expo push token" });
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

// POST /api/push/test-medication — send a test medication push to the native app
// Accepts optional { token: "ExponentPushToken[...]" } to bypass the DB lookup
// (useful when testing from production where the token is already registered).
router.post("/push/test-medication", async (req, res) => {
  const { sendPushToAll, getExpoTokens } = await import("../push/pushManager.js");
  try {
    const { token: overrideToken } = req.body as { token?: string };

    const pushPayload = {
      title: "Time for your medications 💊",
      body: "Have you taken your medications?",
      categoryIdentifier: "medication-action",
      notificationType: "medication",
      tag: "medication-morning",
    };

    // Use override token if provided, otherwise pull from DB
    const dbTokens = await getExpoTokens();
    const tokens = overrideToken ? [overrideToken] : dbTokens;

    // Build the exact Expo message the server will send
    const expoMessage = tokens.map((to) => ({
      to,
      title: pushPayload.title,
      body: pushPayload.body,
      sound: "default",
      priority: "high",
      channelId: "default",
      categoryId: pushPayload.categoryIdentifier,
      data: {
        tag: pushPayload.tag,
        notificationType: pushPayload.notificationType,
        categoryIdentifier: pushPayload.categoryIdentifier,
      },
    }));

    let result: { sent: number; failed: number };
    if (overrideToken) {
      // Send directly to the override token without going through sendPushToAll
      // (which would pull DB tokens and ignore the override)
      const sendRes = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(expoMessage),
      });
      const data = (await sendRes.json()) as { data: Array<{ status: string }> };
      const sent = data.data?.filter((t) => t.status === "ok").length ?? 0;
      result = { sent, failed: (data.data?.length ?? 0) - sent };
    } else {
      result = await sendPushToAll(pushPayload);
    }

    logger.info({ result, overrideToken: overrideToken ? "…" + overrideToken.slice(-20) : null, expoMessage }, "[Expo Push] Test medication push sent");
    res.json({ ok: true, ...result, expoMessage, usingOverrideToken: !!overrideToken, dbTokenCount: dbTokens.length });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Test medication push failed");
    res.status(500).json({ error: "Failed to send test push" });
  }
});

// POST /api/push/test-bill — send a test bill-due push using the first upcoming active bill
// Accepts optional { token: "ExponentPushToken[...]" } to bypass the DB lookup.
router.post("/push/test-bill", async (req, res) => {
  const { sendPushToAll, getExpoTokens } = await import("../push/pushManager.js");
  const { getUpcomingBills, computeNextDueDate, buildBillReminderMessage } = await import("../bills/billManager.js");
  const { getProfile } = await import("../onboarding/onboardingManager.js");
  try {
    const { token: overrideToken } = req.body as { token?: string };

    const upcoming = await getUpcomingBills(90, NATIVE_USER);
    if (!upcoming.length) {
      res.status(404).json({ error: "No upcoming active bills found" });
      return;
    }

    const bill = upcoming[0];
    const nextDueDate = computeNextDueDate(bill);
    const profile = await getProfile(NATIVE_USER);
    const displayName = profile?.name ?? "David";

    const companionMessage = JSON.stringify({
      billId: bill.id,
      billName: bill.name,
      amount: bill.amount ?? "",
      dueDateISO: nextDueDate.toISOString().split("T")[0],
    });

    const pushPayload = {
      title: "Bill Due Soon",
      body: buildBillReminderMessage(bill, displayName),
      tag: `bill-${bill.id}`,
      notificationType: "bill-reminder",
      categoryIdentifier: "bill-action",
      requireInteraction: true,
      billId: bill.id,
      dueDateISO: nextDueDate.toISOString().split("T")[0],
      companionMessage,
    };

    // Use override token if provided, otherwise pull from DB
    const dbTokens = await getExpoTokens();
    const tokens = overrideToken ? [overrideToken] : dbTokens;

    // Build the exact Expo message the server will send
    const expoMessage = tokens.map((to) => ({
      to,
      title: pushPayload.title,
      body: pushPayload.body,
      sound: "default",
      priority: "high",
      channelId: "default",
      categoryId: pushPayload.categoryIdentifier,
      data: {
        tag: pushPayload.tag,
        notificationType: pushPayload.notificationType,
        categoryIdentifier: pushPayload.categoryIdentifier,
        billId: pushPayload.billId,
        dueDateISO: pushPayload.dueDateISO,
        companionMessage: pushPayload.companionMessage,
      },
    }));

    let result: { sent: number; failed: number };
    if (overrideToken) {
      const sendRes = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(expoMessage),
      });
      const data = (await sendRes.json()) as { data: Array<{ status: string }> };
      const sent = data.data?.filter((t) => t.status === "ok").length ?? 0;
      result = { sent, failed: (data.data?.length ?? 0) - sent };
    } else {
      result = await sendPushToAll(pushPayload);
    }

    logger.info({ result, overrideToken: overrideToken ? "…" + overrideToken.slice(-20) : null, expoMessage }, "[Expo Push] Test bill push sent");
    res.json({ ok: true, ...result, expoMessage, usingOverrideToken: !!overrideToken, dbTokenCount: dbTokens.length });
  } catch (err) {
    logger.error({ err }, "[Expo Push] Test bill push failed");
    res.status(500).json({ error: "Failed to send test bill push" });
  }
});

export default router;
