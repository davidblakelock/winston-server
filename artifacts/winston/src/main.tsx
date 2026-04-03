import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Register service worker on every page load so push notifications and
// notification-click handling work even if the user never opens Settings.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL ?? "/";
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then((reg) => {
        console.log("Service Worker Active — scope:", reg.scope);
        // Forward the session token to the SW so it can re-subscribe on expiry
        const token = localStorage.getItem("winston_session_token");
        if (token && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "SET_TOKEN", token });
        }
      })
      .catch((err) => {
        // SW registration failure is non-fatal — app still works without push
        console.warn("Service worker registration failed:", err);
      });

    // Listen for SW_ACTIVE message broadcast by the service worker on activate
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "SW_ACTIVE") {
        console.log("Service Worker Active — SW_ACTIVE message received");
      }
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
