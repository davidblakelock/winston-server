import { useState, useEffect, useCallback } from "react";

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export interface UseNotificationsResult {
  permission: NotificationPermission;
  isSubscribed: boolean;
  isLoading: boolean;
  requestPermission: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

const BASE = import.meta.env.BASE_URL ?? "/";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
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
    const res = await fetch(`${BASE}api/push/vapid-public-key`);
    if (!res.ok) return null;
    const { publicKey } = await res.json();
    return publicKey ?? null;
  } catch {
    return null;
  }
}

function getSessionToken(): string | null {
  return localStorage.getItem("winston_session_token");
}

function sendTokenToServiceWorker(token: string | null): void {
  if (!token) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "SET_TOKEN", token });
}

async function sendSubscriptionToServer(sub: PushSubscription): Promise<void> {
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) throw new Error("Missing subscription keys");

  const token = getSessionToken();
  await fetch(`${BASE}api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: arrayBufferToBase64(p256dh),
        auth: arrayBufferToBase64(auth),
      },
    }),
  });
}

async function deleteSubscriptionFromServer(endpoint: string): Promise<void> {
  await fetch(`${BASE}api/push/subscribe`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function useNotifications(): UseNotificationsResult {
  const supported = isNotificationsSupported();

  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? (Notification.permission as NotificationPermission) : "unsupported"
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Check existing subscription on mount and relay session token to SW
  useEffect(() => {
    if (!supported) return;

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(!!sub);
      });
      // Relay the session token so the SW can re-subscribe on token rotation
      sendTokenToServiceWorker(getSessionToken());
    });
  }, [supported]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setIsLoading(true);

    try {
      // 1. Register service worker if not already
      const swUrl = `${BASE}sw.js`;
      const reg = await navigator.serviceWorker.register(swUrl, { scope: BASE });
      await navigator.serviceWorker.ready;

      // 2. Request notification permission
      const result = await Notification.requestPermission();
      setPermission(result as NotificationPermission);

      if (result !== "granted") {
        setIsLoading(false);
        return false;
      }

      // 3. Get VAPID key from server
      const vapidPublicKey = await getVapidPublicKey();
      if (!vapidPublicKey) {
        setIsLoading(false);
        return false;
      }

      // 4. Subscribe to push
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      // 5. Send subscription to server
      await sendSubscriptionToServer(sub);
      setIsSubscribed(true);
      setIsLoading(false);
      return true;
    } catch (err) {
      console.error("Push subscription failed:", err);
      setIsLoading(false);
      return false;
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
      }
    } catch (err) {
      console.error("Unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [supported]);

  return { permission, isSubscribed, isLoading, requestPermission, unsubscribe };
}
