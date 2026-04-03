import { useState, useEffect, useCallback } from "react";

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export interface UseNotificationsResult {
  permission: NotificationPermission;
  isSubscribed: boolean;
  isLoading: boolean;
  requestPermission: () => Promise<boolean>;
  resubscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

const BASE = import.meta.env.BASE_URL ?? "/";
const LOG = (...args: unknown[]) => console.log("[PUSH]", ...args);
const ERR = (...args: unknown[]) => console.error("[PUSH ERROR]", ...args);

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

export function isNotificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

async function getVapidPublicKey(): Promise<string | null> {
  try {
    LOG("Fetching VAPID public key from server…");
    const res = await fetch(`${BASE}api/push/vapid-public-key`);
    if (!res.ok) { ERR("VAPID key fetch failed:", res.status); return null; }
    const { publicKey } = await res.json() as { publicKey?: string };
    LOG("VAPID key received:", publicKey ? publicKey.slice(0, 20) + "…" : "null");
    return publicKey ?? null;
  } catch (e) {
    ERR("VAPID key fetch threw:", e);
    return null;
  }
}

function getSessionToken(): string | null {
  return localStorage.getItem("winston_session_token");
}

function getUserName(): string {
  return localStorage.getItem("winston_user_name") ?? "David";
}

function sendTokenToServiceWorker(token: string | null): void {
  if (!token) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "SET_TOKEN", token });
}

async function sendSubscriptionToServer(sub: PushSubscription): Promise<void> {
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) throw new Error("Missing subscription keys (p256dh/auth)");

  const token = getSessionToken();
  const userName = getUserName();

  const payload = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: arrayBufferToBase64(p256dh),
      auth: arrayBufferToBase64(auth),
    },
    userName,
  };

  LOG("Sending subscription to /api/push/subscribe…");
  LOG("  endpoint (last 30):", sub.endpoint.slice(-30));
  LOG("  userName:", userName);

  const res = await fetch(`${BASE}api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json() as { success?: boolean; error?: string; id?: number };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  LOG("✅ Subscription saved to Supabase — row id:", data.id);
}

async function deleteSubscriptionFromServer(endpoint: string): Promise<void> {
  LOG("Removing subscription from server…");
  await fetch(`${BASE}api/push/subscribe`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  LOG("Subscription removed from server.");
}

async function doSubscribe(
  setIsSubscribed: (v: boolean) => void,
  setPermission: (v: NotificationPermission) => void,
  forceRenew = false
): Promise<boolean> {
  LOG("=== Starting push subscription flow ===");
  LOG("Browser support:", isNotificationsSupported());

  // 1. Register service worker
  const swUrl = `${BASE}sw.js`;
  LOG("Registering service worker:", swUrl);
  const reg = await navigator.serviceWorker.register(swUrl, { scope: BASE });
  await navigator.serviceWorker.ready;
  LOG("Service worker ready — scope:", reg.scope);

  // 2. Check / request permission
  const currentPerm = Notification.permission;
  LOG("Current notification permission:", currentPerm);

  if (currentPerm === "denied") {
    LOG("Permission denied — user must reset in browser settings");
    setPermission("denied");
    return false;
  }

  if (currentPerm !== "granted") {
    LOG("Requesting notification permission…");
    const result = await Notification.requestPermission();
    LOG("Permission result:", result);
    setPermission(result as NotificationPermission);
    if (result !== "granted") return false;
  } else {
    setPermission("granted");
  }

  // 3. Check existing subscription
  if (!forceRenew) {
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      LOG("Existing PushManager subscription found — re-registering with server to ensure Supabase row exists");
      try {
        await sendSubscriptionToServer(existing);
        setIsSubscribed(true);
        return true;
      } catch (e) {
        LOG("Re-registration of existing subscription failed, will create new one:", e);
        await existing.unsubscribe();
      }
    } else {
      LOG("No existing PushManager subscription found — will create new one");
    }
  } else {
    LOG("Force renew — unsubscribing existing subscription first");
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
  }

  // 4. Get VAPID key
  const vapidPublicKey = await getVapidPublicKey();
  if (!vapidPublicKey) {
    ERR("No VAPID key — push notifications not configured on server");
    return false;
  }

  // 5. Create new push subscription
  LOG("Creating new push subscription with VAPID key…");
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  LOG("Push subscription created:", sub.endpoint.slice(-40));

  // 6. Save to server (→ Supabase)
  await sendSubscriptionToServer(sub);
  setIsSubscribed(true);
  LOG("=== Push subscription flow complete ✅ ===");
  return true;
}

export function useNotifications(): UseNotificationsResult {
  const supported = isNotificationsSupported();

  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? (Notification.permission as NotificationPermission) : "unsupported"
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // On mount: relay token to SW, and auto-register if already permitted
  useEffect(() => {
    if (!supported) return;

    navigator.serviceWorker.ready.then((reg) => {
      // Relay session token to service worker for auth
      sendTokenToServiceWorker(getSessionToken());

      reg.pushManager.getSubscription().then(async (sub) => {
        if (sub) {
          LOG("Mount check: PushManager subscription exists — ensuring Supabase row is current");
          setIsSubscribed(true);
          // Silently re-register to make sure the Supabase row exists
          try {
            await sendSubscriptionToServer(sub);
          } catch (e) {
            LOG("Silent re-registration failed (non-fatal):", e);
          }
        } else if (Notification.permission === "granted") {
          LOG("Mount check: permission=granted but no subscription — auto-subscribing");
          setIsLoading(true);
          try {
            await doSubscribe(setIsSubscribed, setPermission, false);
          } catch (e) {
            ERR("Auto-subscribe on mount failed:", e);
          } finally {
            setIsLoading(false);
          }
        } else {
          LOG("Mount check: permission =", Notification.permission, "| no subscription");
        }
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
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

  // resubscribe: force-renews the subscription — useful for the Re-enable button
  const resubscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setIsLoading(true);
    LOG("=== Re-enable Notifications triggered ===");
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
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deleteSubscriptionFromServer(sub.endpoint);
        await sub.unsubscribe();
        setIsSubscribed(false);
        LOG("Unsubscribed successfully");
      }
    } catch (err) {
      ERR("Unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [supported]);

  return { permission, isSubscribed, isLoading, requestPermission, resubscribe, unsubscribe };
}
