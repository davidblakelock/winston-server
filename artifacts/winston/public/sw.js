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
  const targetUrl = data.url || WINSTON_URL;

  const options = {
    body: reminderText || "Tap to open Winston.",
    icon:  WINSTON_URL + "icon-192.png",
    badge: WINSTON_URL + "badge-72.png",
    tag:   data.tag || "winston",
    data: {
      url:          targetUrl,
      reminderText: reminderText,
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

  event.waitUntil(
    self.registration.showNotification(title, options)
      .then(() => console.log("[SW] showNotification resolved — notification displayed"))
      .catch((err) => console.error("[SW] showNotification failed:", err))
  );
});

// ── Notification click ────────────────────────────────────────────────────────
// Bug 3 fix: explicit async/await with try/catch so failures don't silently drop.
// On Android Chrome, focus() can be blocked — we always fall back to openWindow.
self.addEventListener("notificationclick", (event) => {
  // Step 1: always close the notification immediately
  event.notification.close();

  const action       = event.action;
  const targetUrl    = event.notification.data?.url          || WINSTON_URL;
  const reminderText = event.notification.data?.reminderText || "";
  const reminderId   = event.notification.data?.reminderId   ?? null;

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
      clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    } catch (err) {
      console.warn("[SW] matchAll failed:", err);
    }

    const existing = clientList.find(
      (c) => c.url.includes("winston-companion--davidblakelock.replit.app")
    );

    if (existing) {
      console.log("[SW] existing Winston tab found — focusing and posting message");
      // Step 3: focus the existing tab
      try {
        await existing.focus();
        // Step 4: post message so the app can speak the reminder immediately
        existing.postMessage({ type: "NOTIFICATION_CLICK", url: targetUrl });
        console.log("[SW] focus + postMessage succeeded");
        return;
      } catch (focusErr) {
        // focus() can fail on Android Chrome when tab is in background
        // Fall through to openWindow
        console.warn("[SW] focus() failed — falling back to openWindow:", focusErr);
      }
    }

    // Step 5: no existing tab or focus failed — store reminder and open a fresh window
    console.log("[SW] opening new window:", WINSTON_URL);
    try {
      await storePendingReminder(reminderText, reminderId);
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
  console.warn("[SW] unknown action:", JSON.stringify(action), "— treating as open");
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
