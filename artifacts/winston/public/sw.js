// Web push notifications have been retired.
// This script self-unregisters so any browser that previously installed
// the old service worker is automatically cleaned up.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", async () => {
  // Unsubscribe any existing push subscription first so no stale
  // server-side endpoints remain active for this device.
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (_) {}

  // Self-unregister this service worker.
  await self.registration.unregister();
});
