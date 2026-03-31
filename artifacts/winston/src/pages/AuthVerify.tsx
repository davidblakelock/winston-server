import { useEffect, useState } from "react";
import { SESSION_KEY } from "../hooks/useAuth";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AuthVerifyProps {
  token: string;
  onAuthenticated: (token: string, userName: string) => void;
  onFailed: () => void;
}

export default function AuthVerify({ token, onAuthenticated, onFailed }: AuthVerifyProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("No token found in link.");
      return;
    }

    fetch(`${BASE}/api/auth/magic-link/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("expired");
        return r.json() as Promise<{ sessionToken: string; userName: string }>;
      })
      .then((data) => {
        localStorage.setItem(SESSION_KEY, data.sessionToken);
        onAuthenticated(data.sessionToken, data.userName);
      })
      .catch(() => {
        setError("This sign-in link has expired or was already used.");
        setTimeout(onFailed, 3000);
      });
  }, [token, onAuthenticated, onFailed]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0d0d1a 0%, #0f0f1e 60%, #12122a 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Inter', system-ui, sans-serif",
        color: "#e8e4ff",
        gap: "20px",
      }}
    >
      {error ? (
        <>
          <p style={{ color: "#f87171", fontSize: "1rem" }}>{error}</p>
          <p style={{ color: "#6b6b8a", fontSize: "0.85rem" }}>
            Redirecting you back to sign in…
          </p>
        </>
      ) : (
        <>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 30px rgba(79,70,229,0.5)",
            }}
          >
            <span style={{ color: "white", fontWeight: "700", fontSize: "16px" }}>EP</span>
          </div>
          <p style={{ color: "#9d9db8", fontSize: "0.95rem" }}>
            Signing you in…
          </p>
          <style>{`
            @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
          `}</style>
          <div style={{ display: "flex", gap: "6px" }}>
            {[0, 150, 300].map((delay) => (
              <div
                key={delay}
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#4f46e5",
                  animation: `pulse 1.2s ease-in-out ${delay}ms infinite`,
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
