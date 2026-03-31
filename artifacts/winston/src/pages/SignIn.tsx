import { useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_KEY = "winston_session_token";

interface SignInProps {
  onAuthenticated: (token: string, userName: string) => void;
}

type Stage =
  | { type: "email" }
  | { type: "link_ready"; magicLinkUrl: string; emailSent: boolean }
  | { type: "verifying" }
  | { type: "error"; message: string };

export default function SignIn({ onAuthenticated }: SignInProps) {
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>({ type: "email" });
  const [loading, setLoading] = useState(false);

  async function handleRequestLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || loading) return;
    setLoading(true);

    try {
      const res = await fetch(`${BASE}/api/auth/magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const data = (await res.json()) as {
        sent: boolean;
        magicLinkUrl?: string;
        emailSent?: boolean;
      };

      if (data.sent && data.magicLinkUrl) {
        setStage({
          type: "link_ready",
          magicLinkUrl: data.magicLinkUrl,
          emailSent: data.emailSent ?? false,
        });
      } else {
        setStage({
          type: "error",
          message: "Something went wrong. Please try again.",
        });
      }
    } catch {
      setStage({
        type: "error",
        message: "Could not connect to Winston. Check your connection.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyLink(token: string) {
    setStage({ type: "verifying" });

    try {
      const res = await fetch(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        setStage({
          type: "error",
          message: "That link has expired or was already used. Request a new one.",
        });
        return;
      }

      const data = (await res.json()) as {
        sessionToken: string;
        userName: string;
      };

      localStorage.setItem(SESSION_KEY, data.sessionToken);
      onAuthenticated(data.sessionToken, data.userName);
    } catch {
      setStage({
        type: "error",
        message: "Verification failed. Please try again.",
      });
    }
  }

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
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
        }}
      >
        {/* Logo mark */}
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "20px",
              boxShadow: "0 0 30px rgba(79,70,229,0.4)",
            }}
          >
            <span style={{ color: "white", fontWeight: "700", fontSize: "18px", letterSpacing: "0.05em" }}>
              EP
            </span>
          </div>
          <h1
            style={{
              color: "#e8e4ff",
              fontSize: "1.6rem",
              fontWeight: "600",
              margin: "0 0 8px",
              letterSpacing: "-0.02em",
            }}
          >
            Welcome back, David.
          </h1>
          <p style={{ color: "#6b6b8a", fontSize: "0.9rem", margin: 0, lineHeight: "1.5" }}>
            Sign in to continue your conversation with Emma Peel.
          </p>
        </div>

        {/* Card */}
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "16px",
            padding: "32px",
            backdropFilter: "blur(10px)",
          }}
        >
          {stage.type === "email" && (
            <form onSubmit={handleRequestLink}>
              <label
                htmlFor="email"
                style={{
                  display: "block",
                  color: "#9d9db8",
                  fontSize: "0.78rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  marginBottom: "8px",
                }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                autoFocus
                autoComplete="email"
                required
                style={{
                  width: "100%",
                  padding: "13px 16px",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: "8px",
                  color: "#e8e4ff",
                  fontSize: "1rem",
                  outline: "none",
                  boxSizing: "border-box",
                  marginBottom: "20px",
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(79,70,229,0.6)")}
                onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
              />
              <button
                type="submit"
                disabled={loading || !email.trim()}
                style={{
                  width: "100%",
                  padding: "13px",
                  background: loading || !email.trim()
                    ? "rgba(79,70,229,0.4)"
                    : "linear-gradient(135deg, #4f46e5, #7c3aed)",
                  border: "none",
                  borderRadius: "8px",
                  color: "white",
                  fontSize: "0.95rem",
                  fontWeight: "500",
                  cursor: loading || !email.trim() ? "default" : "pointer",
                  transition: "opacity 0.15s",
                  letterSpacing: "0.01em",
                }}
              >
                {loading ? "Preparing your link…" : "Send sign-in link →"}
              </button>
              <p style={{ textAlign: "center", color: "#4a4a6a", fontSize: "0.78rem", marginTop: "16px", marginBottom: 0 }}>
                No password needed. We'll send you a one-tap sign-in link.
              </p>
            </form>
          )}

          {stage.type === "link_ready" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "2rem", marginBottom: "16px" }}>{stage.emailSent ? "✉️" : "🔗"}</div>
              {stage.emailSent ? (
                <>
                  <p style={{ color: "#a8a8c8", fontSize: "0.95rem", lineHeight: "1.6", marginBottom: "8px" }}>
                    A sign-in link has been sent to
                  </p>
                  <p style={{ color: "#e8e4ff", fontWeight: 600, fontSize: "0.95rem", marginBottom: "20px" }}>
                    {email}
                  </p>
                  <p style={{ color: "#6b6b8a", fontSize: "0.85rem", lineHeight: "1.5", marginBottom: "24px" }}>
                    Check your email and tap the link — or sign in on this device right now:
                  </p>
                </>
              ) : (
                <>
                  <p style={{ color: "#a8a8c8", fontSize: "0.95rem", lineHeight: "1.6", marginBottom: "8px" }}>
                    Your sign-in link is ready.
                  </p>
                  <p style={{ color: "#6b6b8a", fontSize: "0.85rem", lineHeight: "1.5", marginBottom: "24px" }}>
                    Sign in on this device below, or copy the link to open Winston on another device.
                  </p>
                </>
              )}

              {/* One-tap sign in button */}
              <button
                onClick={() => {
                  const url = new URL(stage.magicLinkUrl);
                  const token = url.searchParams.get("token");
                  if (token) handleVerifyLink(token);
                }}
                style={{
                  width: "100%",
                  padding: "14px",
                  background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
                  border: "none",
                  borderRadius: "8px",
                  color: "white",
                  fontSize: "1rem",
                  fontWeight: "600",
                  cursor: "pointer",
                  marginBottom: "16px",
                  boxShadow: "0 4px 20px rgba(79,70,229,0.4)",
                }}
              >
                Sign in now →
              </button>

              {/* Copy link for other devices */}
              <details style={{ textAlign: "left" }}>
                <summary
                  style={{
                    color: "#4a4a6a",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                    textAlign: "center",
                    listStyle: "none",
                    marginBottom: "8px",
                  }}
                >
                  Sign in on another device ↓
                </summary>
                <div
                  style={{
                    background: "rgba(0,0,0,0.3)",
                    borderRadius: "6px",
                    padding: "10px 12px",
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginTop: "8px",
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      color: "#6b6bf8",
                      fontSize: "0.7rem",
                      wordBreak: "break-all",
                      fontFamily: "monospace",
                    }}
                  >
                    {stage.magicLinkUrl}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(stage.magicLinkUrl).catch(() => {});
                    }}
                    style={{
                      flexShrink: 0,
                      padding: "4px 10px",
                      background: "rgba(79,70,229,0.3)",
                      border: "1px solid rgba(79,70,229,0.5)",
                      borderRadius: "4px",
                      color: "#a8a8ff",
                      fontSize: "0.72rem",
                      cursor: "pointer",
                    }}
                  >
                    Copy
                  </button>
                </div>
              </details>

              <button
                onClick={() => setStage({ type: "email" })}
                style={{
                  background: "none",
                  border: "none",
                  color: "#4a4a6a",
                  fontSize: "0.78rem",
                  cursor: "pointer",
                  marginTop: "16px",
                  display: "block",
                  width: "100%",
                  textAlign: "center",
                }}
              >
                ← Use a different email
              </button>
            </div>
          )}

          {stage.type === "verifying" && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  border: "3px solid rgba(79,70,229,0.3)",
                  borderTopColor: "#4f46e5",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                  margin: "0 auto 16px",
                }}
              />
              <p style={{ color: "#9d9db8", fontSize: "0.9rem" }}>
                Signing you in…
              </p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {stage.type === "error" && (
            <div style={{ textAlign: "center" }}>
              <p style={{ color: "#f87171", fontSize: "0.9rem", marginBottom: "20px" }}>
                {stage.message}
              </p>
              <button
                onClick={() => setStage({ type: "email" })}
                style={{
                  padding: "10px 24px",
                  background: "rgba(79,70,229,0.2)",
                  border: "1px solid rgba(79,70,229,0.4)",
                  borderRadius: "6px",
                  color: "#a8a8ff",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p style={{ textAlign: "center", color: "#2a2a4a", fontSize: "0.72rem", marginTop: "24px" }}>
          Winston is a private companion. Access is by invitation only.
        </p>
      </div>
    </div>
  );
}
