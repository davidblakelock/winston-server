import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Register service worker early so it's ready to handle push notifications
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL ?? "/";
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch(() => {
        // SW registration failure is non-fatal
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
