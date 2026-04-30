// Winston Service Worker — handles web push notifications and notification tap routing.

// ── Auth state ────────────────────────────────────────────────────────────────
let authToken = null;
let deviceId = null;

self.addEventListener("message", (event) => {
  if (event.data?.type === "SET_TOKEN") authToken = event.data.token;
  if (event.data?.type === "SET_DEVICE_ID") deviceId = event.data.deviceId;
});

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
  if (payload.categoryId === "bill-action") {
    options.actions = [
      { action: "mark-paid", title: "Mark Paid ✓" },
      { action: "remind-tomorrow", title: "Remind Me Tomorrow" },
    ];
  } else if (payload.categoryId === "medication-action") {
    options.actions = [
      { action: "taken", title: "Taken ✓" },
      { action: "remind-1h", title: "Remind in 1 hour" },
    ];
  } else if (payload.categoryId === "reminder-action") {
    options.actions = [{ action: "done", title: "Done ✓" }];
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

      if (action === "mark-paid" && data.billId) {
        await fetch(`${base}/api/bills/mark-paid`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ billId: data.billId, billName: data.billName, amount: data.billAmount }),
        }).catch(() => {});
        return;
      }

      if (action === "remind-tomorrow" && data.billId) {
        await fetch(`${base}/api/bills/remind-tomorrow`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ billId: data.billId, billName: data.billName, amount: data.billAmount }),
        }).catch(() => {});
        return;
      }

      if (action === "taken") {
        await fetch(`${base}/api/medications/taken`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({}),
        }).catch(() => {});
        return;
      }

      if (action === "remind-1h") {
        await fetch(`${base}/api/medications/snooze-reminder`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({}),
        }).catch(() => {});
        return;
      }

      if (action === "done" && data.reminderId) {
        await fetch(`${base}/api/reminders/done`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ reminderId: data.reminderId }),
        }).catch(() => {});
        return;
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
