// Emma Peel — Winston AI Companion Service Worker
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
  event.waitUntil(self.clients.claim());
});

// ── Push event ────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "Tap to open Winston." };
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

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  // Always close the notification first
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
  // Both should open / focus Winston and deliver the reminder to the app.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Check if Winston is already open
        const existing = clientList.find((c) => c.url.startsWith(WINSTON_URL));

        if (existing) {
          // App is open — bring it to the foreground, then deliver the reminder
          // by posting NOTIFICATION_CLICK with the full URL (including ?text= params).
          // Chat.tsx listens for this message and calls speakReply immediately.
          return existing.focus()
            .then(() => {
              existing.postMessage({
                type: "NOTIFICATION_CLICK",
                url:  targetUrl,
              });
            })
            .catch(() => {
              // focus() failed (some browsers block it) — try opening a new window instead
              return storePendingReminder(reminderText, reminderId)
                .catch(() => {})
                .then(() => self.clients.openWindow(targetUrl));
            });
        }

        // App is not open — store reminder in IndexedDB before opening so the
        // app can speak it even if URL params are stripped or unavailable.
        return storePendingReminder(reminderText, reminderId)
          .catch(() => {})
          .then(() => self.clients.openWindow(targetUrl));
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
