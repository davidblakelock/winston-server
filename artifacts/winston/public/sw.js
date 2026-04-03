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
        // Find any existing Winston window (same origin)
        let appOrigin = null;
        try { appOrigin = new URL(scope).origin; } catch {}

        const winstonClient = appOrigin
          ? clientList.find((c) => {
              try { return new URL(c.url).origin === appOrigin; } catch { return false; }
            })
          : null;

        if (winstonClient) {
          // App is already open — bring it to the foreground.
          // Do NOT use client.navigate() — it silently fails on Safari/iOS and
          // many Chrome environments, leaving the user with no visible response.
          // focus() reliably brings the existing window/tab to the front.
          return winstonClient.focus().catch(() => {
            // focus() failed (e.g. permission denied) — open a fresh window instead
            return self.clients.openWindow(targetUrl);
          });
        }

        // No existing Winston window — open a new one.
        // openWindow() is the most reliable cross-browser way to show the app.
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
