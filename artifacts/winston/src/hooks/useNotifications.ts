import { useState, useEffect, useCallback, useRef } from "react";

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export interface UseNotificationsResult {
  permission: NotificationPermission;
  isSubscribed: boolean;
  isLoading: boolean;
  requestPermission: () => Promise<boolean>;
  resubscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

const BASE = (import.meta.env.BASE_URL as string) ?? "/";

// ── Logging helpers ───────────────────────────────────────────────────────────
const LOG = (...args: unknown[]) => console.log("[PUSH]", ...args);
const ERR = (...args: unknown[]) => console.error("[PUSH ERROR]", ...args);
const STEP = (n: number, msg: string, extra?: unknown) =>
  console.log(`[PUSH STEP ${n}]`, msg, ...(extra !== undefined ? [extra] : []));

// ── Support check ─────────────────────────────────────────────────────────────
export function isNotificationsSupported(): boolean {
  const sw = "serviceWorker" in navigator;
  const pm = "PushManager" in window;
  const notif = "Notification" in window;
  LOG(`Support check — serviceWorker:${sw} PushManager:${pm} Notification:${notif}`);
  return sw && pm && notif;
}

// ── Device ID ─────────────────────────────────────────────────────────────────
// Stable per-device identifier stored in localStorage.
// Prefix is derived from the UA so it's human-readable in Supabase rows.
function buildUaLabel(): string {
  const ua = navigator.userAgent;
  if (/Pixel 9/i.test(ua)) return "pixel9";
  if (/Pixel 8/i.test(ua)) return "pixel8";
  if (/Pixel 7/i.test(ua)) return "pixel7";
  if (/Pixel/i.test(ua)) return "pixel";
  if (/SM-/i.test(ua)) return "samsung";
  if (/iPhone/i.test(ua)) return "iphone";
  if (/iPad/i.test(ua)) return "ipad";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "device";
}

function getOrCreateDeviceId(): string {
  const key = "winston_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    const label = buildUaLabel();
    const rand = Math.random().toString(36).slice(2, 8);
    id = `${label}_${Date.now()}_${rand}`;
    localStorage.setItem(key, id);
    LOG("Generated new device ID:", id, "UA:", navigator.userAgent.slice(0, 80));
  }
  return id;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

function getSessionToken(): string | null {
  return localStorage.getItem("winston_session_token");
}

function getUserName(): string {
  return localStorage.getItem("winston_user_name") ?? "David";
}

export function sendTokenToServiceWorker(token: string | null): void {
  if (!token) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "SET_TOKEN", token });
}

// ── VAPID key fetch ───────────────────────────────────────────────────────────
async function fetchVapidKey(): Promise<string | null> {
  STEP(4, "Fetching VAPID public key from server…");
  try {
    const res = await fetch(`${BASE}api/push/vapid-public-key`);
    STEP(4, `VAPID key response — HTTP ${res.status}`);
    if (!res.ok) { ERR("VAPID key fetch failed:", res.status); return null; }
    const { publicKey } = await res.json() as { publicKey?: string };
    if (!publicKey) { ERR("VAPID key response missing publicKey field"); return null; }
    STEP(4, "VAPID key received:", publicKey.slice(0, 20) + "…");
    return publicKey;
  } catch (e) {
    ERR("VAPID key fetch threw:", e);
    return null;
  }
}

// ── Send subscription to server ───────────────────────────────────────────────
async function sendSubscriptionToServer(sub: PushSubscription): Promise<void> {
  STEP(6, "Sending subscription to server…");
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) {
    ERR("STEP 6 FAIL — Missing subscription keys. p256dh:", !!p256dh, "auth:", !!auth);
    throw new Error("Missing subscription keys (p256dh/auth)");
  }

  const token = getSessionToken();
  const userName = getUserName();
  const deviceId = getOrCreateDeviceId();

  const payload = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(p256dh),
      auth: arrayBufferToBase64(auth),
    },
    userName,
    deviceId,
  };

  STEP(6, "POST /api/push/subscribe", {
    endpointTail: sub.endpoint.slice(-40),
    userName,
    deviceId,
    hasToken: !!token,
  });

  const res = await fetch(`${BASE}api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  STEP(6, `Server response — HTTP ${res.status}`);

  let data: { success?: boolean; error?: string; id?: number; action?: string } = {};
  try {
    data = await res.json() as typeof data;
    STEP(6, "Server response body:", data);
  } catch (jsonErr) {
    ERR("STEP 6 — Could not parse server JSON response:", jsonErr);
    throw new Error(`Server returned HTTP ${res.status} with non-JSON body`);
  }

  if (!res.ok) {
    ERR("STEP 6 FAIL — Server error:", data.error ?? `HTTP ${res.status}`);
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  STEP(6, `✅ Subscription saved to Supabase — action:${data.action ?? "upsert"} id:${data.id ?? "?"}  device:${deviceId}`);
}

async function deleteSubscriptionFromServer(endpoint: string): Promise<void> {
  LOG("DELETE /api/push/subscribe — endpoint tail:", endpoint.slice(-40));
  await fetch(`${BASE}api/push/subscribe`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  LOG("Subscription removed from server.");
}

// ── Core subscription flow ────────────────────────────────────────────────────
// This is the single source of truth for the entire subscription process.
// Every step is numbered and logged explicitly.

async function doSubscribe(
  setIsSubscribed: (v: boolean) => void,
  setPermission: (v: NotificationPermission) => void,
  forceRenew = false
): Promise<boolean> {
  const deviceId = getOrCreateDeviceId();
  LOG("========== START PUSH SUBSCRIPTION FLOW ==========");
  LOG("Device ID:", deviceId);
  LOG("User agent:", navigator.userAgent);
  LOG("forceRenew:", forceRenew);

  // STEP 1 — Check browser support
  STEP(1, "Checking browser support…");
  const swOk = "serviceWorker" in navigator;
  const pmOk = "PushManager" in window;
  const notifOk = "Notification" in window;
  STEP(1, `serviceWorker:${swOk}  PushManager:${pmOk}  Notification:${notifOk}`);
  if (!swOk || !pmOk || !notifOk) {
    ERR("STEP 1 FAIL — Browser does not support push notifications");
    return false;
  }

  // STEP 2 — Register service worker
  STEP(2, "Registering service worker…");
  let reg: ServiceWorkerRegistration;
  const swUrl = `${BASE}sw.js`;
  STEP(2, "SW URL:", swUrl, "| scope: /");
  try {
    // Always register — the browser deduplicates if already registered
    reg = await navigator.serviceWorker.register(swUrl, { scope: "/" });
    STEP(2, "Service worker registered — state:", reg.active?.state ?? "no active worker yet");
  } catch (swErr) {
    ERR("STEP 2 FAIL — Service worker registration threw:", swErr);
    return false;
  }

  // Wait for SW to be active (critical on Android Chrome first install)
  STEP(2, "Waiting for service worker to become active…");
  try {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SW ready timeout")), 15_000)),
    ]);
    STEP(2, "Service worker active — scope:", reg.scope);
  } catch (readyErr) {
    ERR("STEP 2 FAIL — SW ready timed out or errored:", readyErr);
    return false;
  }

  // Re-fetch reg after ready (it may have been updated)
  try {
    const freshReg = await navigator.serviceWorker.getRegistration("/");
    if (freshReg) reg = freshReg;
  } catch { /* ignore */ }

  // STEP 3 — Check notification permission
  STEP(3, "Checking notification permission…");
  const currentPerm = Notification.permission;
  STEP(3, "Current permission:", currentPerm);

  if (currentPerm === "denied") {
    STEP(3, "Permission DENIED — user must reset in browser settings");
    setPermission("denied");
    return false;
  }

  if (currentPerm !== "granted") {
    STEP(3, "Permission not yet granted — requesting…");
    let result: NotificationPermission;
    try {
      result = (await Notification.requestPermission()) as NotificationPermission;
    } catch (permErr) {
      ERR("STEP 3 FAIL — requestPermission threw:", permErr);
      return false;
    }
    STEP(3, "Permission request result:", result);
    setPermission(result);
    if (result !== "granted") {
      STEP(3, "Permission not granted — aborting flow");
      return false;
    }
  } else {
    setPermission("granted");
  }

  // STEP 4 — Get VAPID public key (early, before subscribe call)
  const vapidPublicKey = await fetchVapidKey();
  if (!vapidPublicKey) {
    ERR("STEP 4 FAIL — No VAPID key available — push notifications not configured on server");
    return false;
  }

  // STEP 5 — Check for existing subscription
  STEP(5, "Checking for existing push subscription via pushManager.getSubscription()…");
  let existingSub: PushSubscription | null = null;
  try {
    existingSub = await reg.pushManager.getSubscription();
  } catch (getSubErr) {
    ERR("STEP 5 FAIL — getSubscription threw:", getSubErr);
  }
  STEP(5, "Existing subscription:", existingSub ? `endpoint tail: …${existingSub.endpoint.slice(-40)}` : "null (none found)");

  if (forceRenew && existingSub) {
    STEP(5, "forceRenew=true — unsubscribing existing subscription first…");
    try {
      await existingSub.unsubscribe();
      STEP(5, "Existing subscription unsubscribed");
    } catch (unsubErr) {
      ERR("STEP 5 — unsubscribe of existing failed (continuing):", unsubErr);
    }
    existingSub = null;
  }

  if (existingSub && !forceRenew) {
    STEP(5, "Existing subscription found — re-sending to server to ensure Supabase row exists…");
    try {
      await sendSubscriptionToServer(existingSub);
      setIsSubscribed(true);
      LOG("========== PUSH FLOW COMPLETE (existing sub re-registered) ✅ ==========");
      return true;
    } catch (resendErr) {
      ERR("STEP 5 — Re-send of existing subscription failed:", resendErr);
      STEP(5, "Will try unsubscribing and creating a fresh subscription…");
      try { await existingSub.unsubscribe(); } catch { /* ignore */ }
      existingSub = null;
    }
  }

  // STEP 5b — Create new subscription
  STEP(5, "Creating new push subscription via pushManager.subscribe()…");
  STEP(5, "applicationServerKey (first 20 chars):", vapidPublicKey.slice(0, 20) + "…");
  let newSub: PushSubscription;
  try {
    newSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    STEP(5, "✅ pushManager.subscribe() succeeded — endpoint tail:", newSub.endpoint.slice(-40));
  } catch (subErr) {
    ERR("STEP 5 FAIL — pushManager.subscribe() threw:", subErr);
    ERR("  This usually means: FCM blocked, VAPID key mismatch, or SW not active");
    ERR("  Error name:", (subErr as Error).name);
    ERR("  Error message:", (subErr as Error).message);
    return false;
  }

  // STEP 6 — Save to server
  try {
    await sendSubscriptionToServer(newSub);
  } catch (saveErr) {
    ERR("STEP 6 FAIL — Could not save subscription to server:", saveErr);
    return false;
  }

  setIsSubscribed(true);
  LOG("========== PUSH FLOW COMPLETE ✅ ==========", "device:", deviceId);
  return true;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useNotifications(): UseNotificationsResult {
  const supported = isNotificationsSupported();

  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? (Notification.permission as NotificationPermission) : "unsupported"
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // On EVERY mount: relay token to SW and auto-register if permission already granted.
  useEffect(() => {
    if (!supported) {
      LOG("Mount check: push notifications not supported on this browser/device — skipping");
      return;
    }

    LOG("Mount check: starting — device:", getOrCreateDeviceId());
    LOG("Mount check: UA:", navigator.userAgent.slice(0, 100));
    LOG("Mount check: permission at mount:", Notification.permission);

    // Relay auth token to service worker (for push notification auth)
    const token = getSessionToken();
    sendTokenToServiceWorker(token);
    LOG("Mount check: session token relayed to SW:", token ? "yes" : "no token yet");

    void (async () => {
      if (!mountedRef.current) return;

      // Wait for SW to be ready before checking subscription
      let reg: ServiceWorkerRegistration | undefined;
      try {
        reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
        ]);
        LOG("Mount check: SW is ready — scope:", reg.scope);
      } catch (e) {
        ERR("Mount check: SW ready timed out:", e);
        return;
      }

      if (!mountedRef.current) return;

      // Check for existing subscription
      let existingSub: PushSubscription | null = null;
      try {
        existingSub = await reg.pushManager.getSubscription();
      } catch (e) {
        ERR("Mount check: getSubscription threw:", e);
      }

      LOG("Mount check: existing subscription:", existingSub ? `…${existingSub.endpoint.slice(-40)}` : "null");

      if (!mountedRef.current) return;

      if (existingSub) {
        // Permission is implicitly granted if a subscription exists
        if (mountedRef.current) {
          setIsSubscribed(true);
          setPermission("granted");
        }
        // Always re-register on every page load — ensures Supabase row exists for this device
        LOG("Mount check: re-sending existing subscription to server…");
        try {
          await sendSubscriptionToServer(existingSub);
          LOG("Mount check: ✅ subscription refreshed in Supabase");
        } catch (e) {
          ERR("Mount check: silent re-registration failed (non-fatal):", e);
        }
      } else if (Notification.permission === "granted") {
        // Permission granted but no subscription — create one automatically
        LOG("Mount check: permission=granted but NO subscription — auto-subscribing…");
        if (mountedRef.current) setIsLoading(true);
        try {
          const ok = await doSubscribe(setIsSubscribed, setPermission, false);
          LOG("Mount check: auto-subscribe result:", ok ? "✅ success" : "❌ failed");
        } catch (e) {
          ERR("Mount check: auto-subscribe threw:", e);
        } finally {
          if (mountedRef.current) setIsLoading(false);
        }
      } else {
        LOG("Mount check: permission =", Notification.permission, "— waiting for user to grant");
        if (mountedRef.current) setPermission(Notification.permission as NotificationPermission);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!supported) { LOG("requestPermission: not supported"); return false; }
    LOG("requestPermission: triggered by user action");
    setIsLoading(true);
    try {
      return await doSubscribe(setIsSubscribed, setPermission, false);
    } catch (err) {
      ERR("requestPermission failed:", err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [supported]);

  const resubscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) { LOG("resubscribe: not supported"); return false; }
    LOG("resubscribe: force-renewing subscription — device:", getOrCreateDeviceId());
    setIsLoading(true);
    try {
      return await doSubscribe(setIsSubscribed, setPermission, true);
    } catch (err) {
      ERR("resubscribe failed:", err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!supported) return;
    LOG("unsubscribe: removing push subscription");
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deleteSubscriptionFromServer(sub.endpoint);
        await sub.unsubscribe();
        setIsSubscribed(false);
        LOG("Unsubscribed successfully — device:", getOrCreateDeviceId());
      } else {
        LOG("unsubscribe: no subscription to remove");
      }
    } catch (err) {
      ERR("Unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [supported]);

  return { permission, isSubscribed, isLoading, requestPermission, resubscribe, unsubscribe };
}
