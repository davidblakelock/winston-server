// Emma Peel — Winston AI Companion Service Worker
// Published app URL — always use this absolute URL for openWindow/focus checks
const WINSTON_URL = "https://winston-companion--davidblakelock.replit.app/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "Tap to open Winston." };
  }

  const title = data.title || "Winston";
  const options = {
    body: data.body || "Tap to open Winston.",
    icon: WINSTON_URL + "icon-192.png",
    badge: WINSTON_URL + "icon-192.png",
    tag: data.tag || "winston",
    data: {
      url: WINSTON_URL,
      reminderText: data.body || "",
    },
    requireInteraction: true,
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Check if Winston is already open
        for (const client of clientList) {
          if (client.url.startsWith(WINSTON_URL)) {
            return client.focus();
          }
        }
        // Winston is not open — open it with the exact absolute URL
        return self.clients.openWindow(WINSTON_URL);
      })
  );
});

// Allow the app to store the session token for re-subscription on expiry
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
});

// Re-subscribe if the push subscription expires
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
