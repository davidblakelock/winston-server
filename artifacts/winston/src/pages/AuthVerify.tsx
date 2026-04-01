import { useEffect, useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AuthVerifyProps {
  token: string;
  onAuthenticated: (sessionToken: string, userName: string) => void;
  onFailed: () => void;
}

export default function AuthVerify({ token, onAuthenticated, onFailed }: AuthVerifyProps) {
  const [status, setStatus] = useState<"verifying" | "success" | "failed">("verifying");

  useEffect(() => {
    if (!token) { setStatus("failed"); return; }

    fetch(`${BASE}/api/auth/magic-link/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("invalid");
        const data = (await res.json()) as { sessionToken: string; userName: string };
        setStatus("success");
        setTimeout(() => onAuthenticated(data.sessionToken, data.userName), 600);
      })
      .catch(() => {
        setStatus("failed");
        setTimeout(onFailed, 2000);
      });
  }, [token]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(160deg, #080812 0%, #0d0d1f 50%, #10102a 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Inter', system-ui, sans-serif",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "380px" }}>
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "20px",
            boxShadow: "0 0 32px rgba(79,70,229,0.4)",
          }}
        >
          <span style={{ color: "white", fontWeight: "700", fontSize: "18px" }}>W</span>
        </div>

        {status === "verifying" && (
          <>
            <p style={{ color: "#a5b4fc", fontSize: "1.05rem", fontWeight: "500", margin: "0 0 8px" }}>
              Signing you in…
            </p>
            <p style={{ color: "#4b4b70", fontSize: "0.85rem", margin: 0 }}>Just a moment</p>
          </>
        )}

        {status === "success" && (
          <p style={{ color: "#4ade80", fontSize: "1.05rem", fontWeight: "500", margin: 0 }}>
            Signed in! Welcome back.
          </p>
        )}

        {status === "failed" && (
          <>
            <p style={{ color: "#f87171", fontSize: "1.05rem", fontWeight: "500", margin: "0 0 8px" }}>
              This link has expired or already been used.
            </p>
            <p style={{ color: "#4b4b70", fontSize: "0.85rem", margin: 0 }}>
              Redirecting you back…
            </p>
          </>
        )}
      </div>
    </div>
  );
}
