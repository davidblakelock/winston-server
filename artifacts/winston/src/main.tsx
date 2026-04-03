import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL ?? "/";
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: "/" })
      .then((reg) => {
        console.log("Service Worker Active — scope:", reg.scope);
        // Forward the session token to the SW so it can re-subscribe on expiry
        const token = localStorage.getItem("winston_session_token");
        if (token && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "SET_TOKEN", token });
        }
      })
      .catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
