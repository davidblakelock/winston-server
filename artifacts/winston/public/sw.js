// Emma Peel — Winston AI Companion Service Worker
// The exact published app URL — used as the authoritative base for all navigation
const WINSTON_URL = "https://winston-companion--davidblakelock.replit.app/";

self.addEventListener("install", () => {
  // Activate immediately without waiting for old SW to retire
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of all open clients right away
  event.waitUntil(self.clients.claim());
});

// ── Push event ────────────────────────────────────────────────────────────────
// Show a rich notification with three action buttons.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "Tap to open Winston." };
  }

  const title = data.title || "Winston";
  // Use the URL from the push payload (includes ?notification=reminder&text=... query params)
  // so that tapping the notification delivers the reminder context to the app.
  // Fall back to the bare WINSTON_URL if the server didn't include one.
  const targetUrl = data.url || WINSTON_URL;

  const options = {
    body: data.body || "Tap to open Winston.",
    icon: WINSTON_URL + "icon-192.png",
    badge: WINSTON_URL + "badge-72.png",
    tag: data.tag || "winston",
    // Store the full URL and reminder ID for the notificationclick handler
    data: {
      url: targetUrl,
      reminderId: data.reminderId ?? null,
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
  event.notification.close();

  const action     = event.action;            // "open" | "snooze" | "dismiss" | ""
  const targetUrl  = event.notification.data?.url        || WINSTON_URL;
  const reminderId = event.notification.data?.reminderId ?? null;

  // Dismiss — nothing more to do
  if (action === "dismiss") return;

  // Snooze — push reminder back 10 minutes via the API, no navigation needed
  if (action === "snooze" && reminderId != null) {
    event.waitUntil(
      fetch(WINSTON_URL + "api/reminders/" + reminderId + "/snooze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: 10 }),
      }).catch(() => {})
    );
    return;
  }

  // Open (or default tap) — focus existing Winston window or open a new one.
  // targetUrl is always an absolute https:// URL (set from push payload above).
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(WINSTON_URL)) {
            // Winston is already open — bring it to the foreground
            return client.focus();
          }
        }
        // Winston is not open — open it with the full absolute URL
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── Token relay ───────────────────────────────────────────────────────────────
// The app posts the session token so the SW can authenticate re-subscription requests
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
});

// ── Push subscription change ──────────────────────────────────────────────────
// Re-subscribe automatically if the push subscription expires
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
