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

function storePendingNotification(reminderText, reminderId, notificationType, companionMessage) {
  return openDb().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      const record = { key: "reminder", reminderText, reminderId };
      if (notificationType) record.notificationType = notificationType;
      if (companionMessage) record.companionMessage = companionMessage;
      tx.objectStore("pending").put(record);
      tx.oncomplete = resolve;
      tx.onerror    = reject;
    });
  });
}

// Keep old name as an alias so any other callers still work
function storePendingReminder(reminderText, reminderId) {
  return storePendingNotification(reminderText, reminderId, null, null);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // claim() takes control of all open clients immediately so this service
  // worker handles fetches/pushes without waiting for a page reload.
  // NOTE: self.registration.update() is intentionally NOT called here.
  // Calling update() in activate triggers an aggressive install→skipWaiting→
  // activate cycle on every app open on Android Chrome, which causes the
  // browser to lose the push subscription.  The browser already checks for a
  // newer sw.js on every page navigation automatically — the explicit call is
  // redundant and harmful on Android.
  event.waitUntil(self.clients.claim());
});

// ── Push event ────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  console.log("[SW] push event fired — service worker woke up", new Date().toISOString());
  console.log("[SW] RAW push payload text:", event.data ? event.data.text() : "(no event.data)");

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
    console.log("[SW] push payload parsed:", JSON.stringify(data));
  } catch {
    data = { body: event.data ? event.data.text() : "Tap to open Winston." };
    console.log("[SW] push payload was not JSON, using raw text:", data.body);
  }

  const title            = data.title || "Winston";
  const reminderText     = data.body  || "";
  const targetUrl        = data.url || WINSTON_URL;
  const notificationType = data.notificationType || null;
  const companionMessage = data.companionMessage || null;

  const options = {
    body: reminderText || "Tap to open Winston.",
    icon:  WINSTON_URL + "icon-192.png",
    badge: WINSTON_URL + "badge-72.png",
    tag:   data.tag || "winston",
    data: {
      url:              targetUrl,
      reminderText:     reminderText,
      reminderId:       data.reminderId ?? null,
      notificationType: notificationType,
      companionMessage: companionMessage,
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

  const reminderId = data.reminderId ?? null;

  // Post REMINDER_PUSH to every open Winston client so the foreground app can
  // speak the reminder immediately — bypasses SSE entirely on the receiving device.
  // spokenReminderIds guard in Chat.tsx prevents double-speak if SSE also fires.
  const notifyClients = (reminderId != null)
    ? self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clientList) => {
          const msg = { type: "REMINDER_PUSH", reminderId, reminderText };
          clientList.forEach((c) => {
            if (c.url.includes("winston-companion")) {
              console.log("[SW] posting REMINDER_PUSH to open client:", c.url, "reminderId:", reminderId);
              c.postMessage(msg);
            }
          });
        })
        .catch((err) => console.warn("[SW] matchAll for REMINDER_PUSH failed:", err))
    : Promise.resolve();

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options)
        .then(() => console.log("[SW] showNotification resolved — notification displayed"))
        .catch((err) => console.error("[SW] showNotification failed:", err)),
      notifyClients,
    ])
  );
});

// ── Notification click ────────────────────────────────────────────────────────
// Bug 3 fix: explicit async/await with try/catch so failures don't silently drop.
// On Android Chrome, focus() can be blocked — we always fall back to openWindow.
self.addEventListener("notificationclick", (event) => {
  // Step 1: always close the notification immediately
  event.notification.close();

  const action           = event.action;
  const targetUrl        = event.notification.data?.url              || WINSTON_URL;
  const reminderText     = event.notification.data?.reminderText     || "";
  const reminderId       = event.notification.data?.reminderId       ?? null;
  const notificationType = event.notification.data?.notificationType || null;
  const companionMessage = event.notification.data?.companionMessage || null;

  console.log("[SW] notificationclick — action:", JSON.stringify(action), "| url:", targetUrl);

  // ── Body tap or "open" — checked FIRST so an empty action can NEVER fall
  //    through to snooze.  On some Android Chrome builds, tapping the body
  //    can arrive with action="" which must always mean "open the app".
  if (!action || action === "" || action === "open") {
    console.log("[SW] body tap / open action — opening app");
    event.waitUntil((async () => {
    // Step 2: find any existing open Winston tab
    let clientList = [];
    try {
      // Do NOT use includeUncontrolled: true here.  navigate() and focus() both
      // throw InvalidStateError on Android Chrome when called on an uncontrolled
      // WindowClient.  Because activate() calls clients.claim(), every open
      // Winston tab is already controlled by the time any push arrives.
      // Uncontrolled tabs (opened mid-SW-install, very rare) fall through to openWindow().
      clientList = await self.clients.matchAll({ type: "window" });
    } catch (err) {
      console.warn("[SW] matchAll failed:", err);
    }

    const existing = clientList.find(
      (c) => c.url.includes("winston-companion--davidblakelock.replit.app")
    );

    if (existing) {
      console.log("[SW] existing Winston tab found — writing IDB, navigating/focusing");
      // Always write to IDB first so Chat.tsx can read the reminder/event after any open path.
      try {
        await storePendingNotification(reminderText, reminderId, notificationType, companionMessage);
      } catch { /* non-fatal */ }

      // Step 3a: try navigate() — on Android Chrome this reliably brings the tab to the
      // foreground (unlike focus() which resolves without actually foregrounding on mobile).
      let signalled = false;
      try {
        if (typeof existing.navigate === "function") {
          const navClient = await existing.navigate(targetUrl);
          const client = navClient || existing;
          await client.focus().catch(() => {});
          client.postMessage({ type: "NOTIFICATION_TAP" });
          console.log("[SW] navigate() + NOTIFICATION_TAP posted — IDB has pending data");
          signalled = true;
        }
      } catch (navErr) {
        console.warn("[SW] navigate() failed — will try focus():", navErr);
      }

      // Step 3b: fallback to focus() if navigate() was unavailable or threw.
      if (!signalled) {
        try {
          await existing.focus();
          existing.postMessage({ type: "NOTIFICATION_TAP" });
          console.log("[SW] focus() + NOTIFICATION_TAP posted — IDB has pending data");
          signalled = true;
        } catch (focusErr) {
          console.warn("[SW] focus() also failed — falling back to openWindow:", focusErr);
        }
      }

      if (signalled) return;
      // Both navigate() and focus() failed — fall through to openWindow below.
    }

    // Step 5: no existing tab or focus failed — store notification and open a fresh window.
    console.log("[SW] opening new window:", WINSTON_URL);
    try {
      await storePendingNotification(reminderText, reminderId, notificationType, companionMessage);
    } catch { /* non-fatal — IDB may fail on some devices */ }

    try {
      await self.clients.openWindow(WINSTON_URL);
      console.log("[SW] openWindow succeeded");
    } catch (openErr) {
      console.error("[SW] openWindow failed:", openErr);
    }
  })());
  return;
  }

  // ── Dismiss ─────────────────────────────────────────────────────────────────
  if (action === "dismiss") {
    console.log("[SW] dismiss action — closing notification only");
    return;
  }

  // ── Snooze ──────────────────────────────────────────────────────────────────
  if (action === "snooze") {
    console.log("[SW] snooze action — reminderId:", reminderId);
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

  // ── Unknown action — treat as open ──────────────────────────────────────────
  console.warn("[SW] unknown action:", JSON.stringify(action), "— treating as open, calling openWindow");
  event.waitUntil(
    storePendingReminder(reminderText, reminderId)
      .catch(() => {})
      .then(() => self.clients.openWindow(WINSTON_URL).catch(() => {}))
  );
});

// ── Token / device-ID relay ───────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") {
    self._winstonToken = event.data.token;
  }
  if (event.data?.type === "SET_DEVICE_ID") {
    self._winstonDeviceId = event.data.deviceId;
  }
});

// ── Push subscription change ──────────────────────────────────────────────────
// Fires when the browser auto-rotates a push subscription (e.g. FCM key refresh).
// Re-subscribes with the same VAPID key and saves the new sub to the server,
// including the device ID so the server can upsert the correct row.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
      })
      .then((newSub) => {
        const token    = self._winstonToken    || null;
        const deviceId = self._winstonDeviceId || null;
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
              auth:   btoa(String.fromCharCode(...new Uint8Array(newSub.getKey("auth")))),
            },
            ...(deviceId ? { deviceId } : {}),
          }),
        });
      })
      .catch(() => {})
  );
});
