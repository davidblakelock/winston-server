// Winston AI Companion Service Worker
const WINSTON_URL = "https://winston-companion--davidblakelock.replit.app/";

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
// Used to pass reminder context to the app when it opens fresh from a notification tap.
// The app reads this on load and speaks the reminder even if URL params are unavailable.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("winston-sw", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("pending", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function storePendingReminder(reminderText, reminderId) {
  return openDb().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.objectStore("pending").put({ key: "reminder", reminderText, reminderId });
      tx.oncomplete = resolve;
      tx.onerror    = reject;
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // claim() takes control of all open clients immediately so this service
  // worker handles fetches/pushes without waiting for a page reload.
  // update() checks the server for a newer sw.js and installs it if found —
  // this ensures the latest version is always active after each deployment.
  event.waitUntil(
    self.clients.claim().then(() => self.registration.update())
  );
});

// ── Push event ────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  console.log("[SW] push event fired — service worker woke up", new Date().toISOString());

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
    console.log("[SW] push payload parsed:", JSON.stringify(data));
  } catch {
    data = { body: event.data ? event.data.text() : "Tap to open Winston." };
    console.log("[SW] push payload was not JSON, using raw text:", data.body);
  }

  const title        = data.title || "Winston";
  const reminderText = data.body  || "";
  // Full URL with ?notification=reminder&text=... query params for the tap target
  const targetUrl = data.url || WINSTON_URL;

  const options = {
    body: reminderText || "Tap to open Winston.",
    icon:  WINSTON_URL + "icon-192.png",
    badge: WINSTON_URL + "badge-72.png",
    tag:   data.tag || "winston",
    data: {
      url:          targetUrl,     // absolute URL including reminder query params
      reminderText: reminderText,  // plain reminder text for postMessage / IDB
      reminderId:   data.reminderId ?? null,
    },
    requireInteraction: true,
    vibrate: [200, 100, 200],
    actions: [
      { action: "open",    title: "Open Winston"  },
      { action: "snooze",  title: "Snooze 10 min" },
      { action: "dismiss", title: "Dismiss"        },
    ],
  };

  console.log("[SW] calling showNotification:", title, "—", reminderText || "(no body)");

  // event.waitUntil keeps the service worker alive until the promise resolves.
  // Without this the browser may kill the worker before showNotification completes.
  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => console.log("[SW] showNotification resolved — notification displayed"))
      .catch((err) => console.error("[SW] showNotification failed:", err))
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  // Step 1: always close the notification immediately
  event.notification.close();

  const action       = event.action; // "open" | "snooze" | "dismiss" | "" (body tap)
  const targetUrl    = event.notification.data?.url          || WINSTON_URL;
  const reminderText = event.notification.data?.reminderText || "";
  const reminderId   = event.notification.data?.reminderId   ?? null;

  // ── Dismiss ────────────────────────────────────────────────────────────────
  if (action === "dismiss") return;

  // ── Snooze ─────────────────────────────────────────────────────────────────
  if (action === "snooze") {
    if (reminderId != null) {
      event.waitUntil(
        fetch(WINSTON_URL + "api/reminders/" + reminderId + "/snooze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minutes: 10 }),
        }).catch(() => {})
      );
    }
    return;
  }

  // ── Open (action === "open") or body tap (action === "") ───────────────────
  // CRITICAL: clients.openWindow MUST be inside event.waitUntil or it will be
  // blocked by the browser. Everything is chained inside the single waitUntil.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Find any open Winston tab using includes() — matches regardless of
        // trailing slashes, query params, or path variations.
        const existing = clientList.find(
          (c) => c.url.includes("winston-companion--davidblakelock.replit.app")
        );

        if (existing) {
          // App is already open — focus it, then deliver the reminder via postMessage.
          // Chat.tsx listens for NOTIFICATION_CLICK and calls speakReply immediately.
          return existing.focus().then(() => {
            existing.postMessage({ type: "NOTIFICATION_CLICK", url: targetUrl });
          }).catch(() => {
            // focus() rejected (some Android Chrome versions block it when the
            // page is not in the foreground) — store in IDB and open a fresh window.
            return storePendingReminder(reminderText, reminderId)
              .catch(() => {})
              .then(() => self.clients.openWindow(WINSTON_URL));
          });
        }

        // App is not open at all — store reminder in IndexedDB first so the app
        // can speak it on load even without URL params, then open the window.
        return storePendingReminder(reminderText, reminderId)
          .catch(() => {})
          .then(() => self.clients.openWindow(WINSTON_URL));
      })
  );
});

// ── Token relay ───────────────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
});

// ── Push subscription change ──────────────────────────────────────────────────
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
      })
      .then((newSub) => {
        const token = self._winstonToken || null;
        return fetch(WINSTON_URL + "api/push/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            endpoint: newSub.endpoint,
            keys: {
              p256dh: btoa(String.fromCharCode(...new Uint8Array(newSub.getKey("p256dh")))),
              auth: btoa(String.fromCharCode(...new Uint8Array(newSub.getKey("auth")))),
            },
          }),
        });
      })
      .catch(() => {})
  );
});
