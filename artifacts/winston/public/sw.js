// Emma Peel — Winston AI Companion Service Worker

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle incoming push messages
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Emma Peel", body: event.data ? event.data.text() : "New message from Emma Peel" };
  }

  const scope = self.registration.scope.replace(/\/$/, "");

  const title = data.title || "Emma Peel";
  const options = {
    body: data.body || "Tap to open Winston.",
    icon: data.icon || `${scope}/icon-192.png`,
    badge: data.badge || `${scope}/badge-72.png`,
    tag: data.tag || "winston",
    data: { url: data.url || scope + "/" },
    requireInteraction: data.requireInteraction || false,
    silent: data.silent || false,
    vibrate: [200, 100, 200],
    actions: [
      { action: "open", title: "Open Winston" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const scope = self.registration.scope.replace(/\/$/, "");
  const targetUrl = event.notification.data?.url || scope + "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // IMPORTANT: Only consider windows that belong to THIS app's origin.
        // Without this filter, the browser may focus a Gmail or other tab
        // and navigate it to the Winston URL instead of opening Winston.
        let appOrigin;
        try {
          appOrigin = new URL(scope).origin;
        } catch {
          appOrigin = null;
        }

        const winstonClients = appOrigin
          ? clientList.filter((client) => {
              try {
                return new URL(client.url).origin === appOrigin;
              } catch {
                return false;
              }
            })
          : [];

        if (winstonClients.length > 0) {
          const client = winstonClients[0];
          // Navigate to the target URL (deep link for reminders/morning)
          if ("navigate" in client) {
            return client.navigate(targetUrl).then((c) => c && c.focus());
          }
          // Fallback: post a message so the app can handle navigation itself
          client.postMessage({ type: "NOTIFICATION_CLICK", url: targetUrl });
          return client.focus();
        }

        // No existing Winston window — open a new one
        return self.clients.openWindow(targetUrl);
      })
  );
});

// Handle push subscription change (re-subscribe if expired)
self.addEventListener("pushsubscriptionchange", (event) => {
  const scope = self.registration.scope.replace(/\/$/, "");
  event.waitUntil(
    self.registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
      })
      .then((newSub) => {
        const token = self._winstonToken || null;
        return fetch(`${scope}/api/push/subscribe`, {
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

// Allow the app to store the session token in the service worker
// so pushsubscriptionchange can re-subscribe with auth
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
});
