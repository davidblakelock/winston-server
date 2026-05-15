// Winston Service Worker v3 — handles web push notifications and notification tap routing.
// Version bump forces browser to install the updated SW on next page load.

// ── Auth state ────────────────────────────────────────────────────────────────
// authToken is set by the page via postMessage when the user is logged in.
// It resets to null when the SW goes idle, so DO NOT rely on it alone for
// background action API calls. Use the native API key as the primary credential.
let authToken = null;
let deviceId = null;

// Native API key — same credential used by the background SDK.
// Accepted by authenticate() middleware → resolves to "davidblakelock".
const NATIVE_API_KEY = "winston-native-2026";

self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") authToken = event.data.token;
  if (event.data?.type === "SET_DEVICE_ID") deviceId = event.data.deviceId;
});

// Build auth headers for background API calls.
// Prefers Bearer token (set when app is open), falls back to native API key.
function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  } else {
    headers["x-api-key"] = NATIVE_API_KEY;
  }
  return headers;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── IDB helper ────────────────────────────────────────────────────────────────
// Stores the tapped notification's data so Chat.tsx can consume it on mount
// or via the NOTIFICATION_TAP message.
function writeToIDB(payload) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("winston-sw", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("pending")) {
        req.result.createObjectStore("pending");
      }
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        store.put(payload, "reminder");
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Push handler ──────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: "Winston", body: event.data?.text() ?? "" };
  }

  const title = payload.title ?? "Winston";
  const body = payload.body ?? "";

  const options = {
    body,
    icon: "/winston-icon.png",
    badge: "/winston-badge.png",
    tag: payload.tag ?? "winston",
    requireInteraction: payload.requireInteraction ?? false,
    data: {
      notificationType: payload.notificationType ?? null,
      autoSendMessage: payload.autoSendMessage ?? null,
      reminderText: payload.reminderText ?? body,
      reminderId: payload.reminderId ?? null,
      companionMessage: payload.companionMessage ?? null,
      categoryId: payload.categoryId ?? null,
      billId: null,
      billName: null,
      billAmount: null,
      // Departure: store mapsUrl directly so click handler can open Maps
      mapsUrl: payload.mapsUrl ?? payload.mapsDeepLink ?? null,
      destination: payload.destination ?? null,
    },
  };

  // Parse structured companionMessage if it's a JSON string
  if (payload.companionMessage) {
    try {
      const cm = JSON.parse(payload.companionMessage);
      options.data.billId = cm.billId ?? null;
      options.data.billName = cm.billName ?? null;
      options.data.billAmount = cm.amount ?? null;
    } catch (_) { /* plain string — leave as-is */ }
  }

  // Action buttons by category
  if (payload.categoryId === "bill-dismiss") {
    // Simple reminder — just a dismiss button, no app interaction needed
    options.actions = [{ action: "bill-done", title: "Done ✓" }];
  } else if (payload.categoryId === "bill-action") {
    options.actions = [
      { action: "mark-paid", title: "Mark Paid ✓" },
      { action: "remind-tomorrow", title: "Remind Me Tomorrow" },
    ];
  } else if (payload.categoryId === "medication-action") {
    // "Done ✓" dismisses and marks taken. "Remind in 30 min" snoozes.
    options.actions = [
      { action: "taken", title: "Done ✓" },
      { action: "remind-30m", title: "Remind in 30 min" },
    ];
  } else if (payload.categoryId === "reminder-action") {
    options.actions = [{ action: "done", title: "Done ✓" }];
  } else if (payload.categoryId === "departure-action") {
    // Departure — show Open in Maps button
    options.actions = [{ action: "open-maps", title: "Open in Maps 🗺️" }];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click handler ────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const action = event.action;

  event.waitUntil(
    (async () => {
      // ── Action button handlers (fire-and-forget API calls) ─────────────────
      const base = self.registration.scope.replace(/\/$/, "");

      // Bill dismiss — just close the notification, no app open, no API call
      if (action === "bill-done") return;

      if (action === "mark-paid" && data.billId) {
        await fetch(`${base}/api/bills/mark-paid`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ billId: data.billId, billName: data.billName, amount: data.billAmount }),
        }).catch(() => {});
        return;
      }

      if (action === "remind-tomorrow" && data.billId) {
        await fetch(`${base}/api/bills/remind-tomorrow`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ billId: data.billId, billName: data.billName, amount: data.billAmount }),
        }).catch(() => {});
        return;
      }

      // Medication: "Done ✓" → POST taken, dismiss, no app open
      if (action === "taken") {
        await fetch(`${base}/api/medications/taken`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({}),
        }).catch(() => {});
        return;
      }

      // Medication: "Remind in 30 min" → snooze, dismiss, no app open
      // "remind-1h" kept for backwards compat with cached service workers.
      if (action === "remind-30m" || action === "remind-1h") {
        await fetch(`${base}/api/medications/snooze-reminder`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ snoozeMinutes: 30 }),
        }).catch(() => {});
        return;
      }

      if (action === "done" && data.reminderId) {
        await fetch(`${base}/api/reminders/done`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ reminderId: data.reminderId }),
        }).catch(() => {});
        return;
      }

      // Departure: "Open in Maps 🗺️" action button — open Maps directly
      if (action === "open-maps") {
        const mapsUrl = data.mapsUrl ?? null;
        if (mapsUrl) {
          await self.clients.openWindow(mapsUrl);
        }
        return;
      }

      // ── Bill reminder: body tap also dismisses without opening the app ────
      if (data.notificationType === "bill-reminder") return;

      // ── Medication: body tap closes the notification — user must use action buttons ──
      // "Done ✓" marks taken. "Remind in 30 min" snoozes. Body tap = dismiss only.
      if (data.categoryId === "medication-action") return;

      // ── Departure alert: body tap opens Google Maps directly ──────────────
      // mapsUrl is stored in data.mapsUrl by the push handler above.
      if (data.notificationType === "departure") {
        const mapsUrl = data.mapsUrl ?? null;
        if (mapsUrl) {
          await self.clients.openWindow(mapsUrl);
          return;
        }
        // Fall through to app open if no mapsUrl (shouldn't happen)
      }

      // ── Main tap (no action button) — open the app ────────────────────────
      // Store payload in IDB so Chat.tsx can consume it on mount.
      await writeToIDB({
        notificationType: data.notificationType,
        autoSendMessage: data.autoSendMessage,
        reminderText: data.reminderText,
        reminderId: data.reminderId,
        companionMessage: data.companionMessage,
      }).catch(() => {});

      // Find an existing Winston window and focus it, or open a new one.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => c.url.startsWith(self.registration.scope));

      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "NOTIFICATION_TAP", data });
      } else {
        const newClient = await self.clients.openWindow("/");
        // IDB is the primary handoff for new windows (postMessage races the load).
        // Try anyway after a short delay.
        if (newClient) {
          setTimeout(() => {
            newClient.postMessage({ type: "NOTIFICATION_TAP", data });
          }, 800);
        }
      }
    })()
  );
});
