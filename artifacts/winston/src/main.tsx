import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#0a0a0a",
      color: "#fff",
      fontFamily: "'Inter', system-ui, sans-serif",
      textAlign: "center",
      gap: "12px",
      userSelect: "none",
    }}
  >
    <div
      style={{
        width: 64,
        height: 64,
        borderRadius: "50%",
        background: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
        marginBottom: 8,
      }}
    />
    <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
      Winston
    </h1>
    <p style={{ color: "#6b7280", fontSize: "0.95rem", margin: 0 }}>
      Available on the native app only.
    </p>
  </div>
);
