// Emma Peel — Winston AI Companion Service Worker

// The scope is the full absolute URL of this app, e.g.:
// https://winston-companion--davidblakelock.replit.app/
// self.registration.scope is always an absolute URL — never a relative path.
function getAppUrl() {
  // scope ends with "/", which is the correct URL to open the app
  return self.registration.scope;
}

self.addEventListener("install", () => {
  // Take control immediately without waiting for old SW to be discarded
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim all open clients so this SW controls them right away
  event.waitUntil(
    self.clients.claim().then(() => {
      // Notify all clients that the service worker is active
      return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: "SW_ACTIVE" });
        });
      });
    })
  );
});

// Handle incoming push messages
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Emma Peel",
      body: event.data ? event.data.text() : "Tap to open Winston.",
    };
  }

  const appUrl = getAppUrl();
  const title = data.title || "Emma Peel";
  const options = {
    body: data.body || "Tap to open Winston.",
    icon: `${appUrl}icon-192.png`,
    badge: `${appUrl}badge-72.png`,
    tag: data.tag || "winston",
    // Store the full absolute app URL in notification data so the click
    // handler always has an absolute URL to pass to openWindow.
    data: {
      url: data.url || appUrl,
    },
    requireInteraction: data.requireInteraction || false,
    silent: data.silent || false,
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification clicks — open or focus the Winston app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  // Always use the full absolute HTTPS URL — never a relative path.
  // data.url is set above from getAppUrl() which is self.registration.scope,
  // guaranteed to be absolute (e.g. https://winston-companion--davidblakelock.replit.app/).
  const targetUrl = event.notification.data?.url || getAppUrl();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Look for an already-open Winston window (same origin)
        const targetOrigin = new URL(targetUrl).origin;

        for (const client of clientList) {
          try {
            if (new URL(client.url).origin === targetOrigin) {
              // App is open — bring it to the foreground
              return client.focus();
            }
          } catch {
            // invalid URL, skip
          }
        }

        // App is not open — open it with the full absolute URL
        // This is the critical call: targetUrl must be https://... not a relative path
        return self.clients.openWindow(targetUrl);
      })
  );
});

// Handle push subscription expiry — re-subscribe automatically
self.addEventListener("pushsubscriptionchange", (event) => {
  const appUrl = getAppUrl();
  event.waitUntil(
    self.registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
      })
      .then((newSub) => {
        const token = self._winstonToken || null;
        return fetch(`${appUrl}api/push/subscribe`, {
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

// Allow the app to store the session token so pushsubscriptionchange can re-subscribe with auth
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
});
