import { useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const btnBase: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  gap: "10px", padding: "20px 16px",
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "16px", color: "#d4d0f0", fontSize: "0.88rem", fontWeight: "500",
  cursor: "pointer", transition: "all 0.18s ease", lineHeight: "1.3", minHeight: "110px",
  width: "100%",
};

function SocialButton({
  onClick,
  icon,
  label,
  sub,
  hoverBg = "rgba(79,70,229,0.1)",
  hoverBorder = "rgba(79,70,229,0.45)",
  style = {},
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
  hoverBg?: string;
  hoverBorder?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      style={{ ...btnBase, ...style }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = hoverBg;
        el.style.borderColor = hoverBorder;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = (style.background as string) ?? "rgba(255,255,255,0.04)";
        el.style.borderColor = (style.border as string)?.replace(/^1px solid /, "") ?? "rgba(255,255,255,0.12)";
      }}
    >
      {icon}
      <span>
        {label}
        <br />
        <span style={{ color: "#a5a0cc", fontWeight: "400", fontSize: "0.8rem" }}>{sub}</span>
      </span>
    </button>
  );
}

export default function SignIn() {
  const [showEmail, setShowEmail] = useState(false);
  const [emailMode, setEmailMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState("");

  function handleGoogleSignIn() {
    window.location.href = `${BASE}/api/auth/google?signin=1`;
  }

  function handleMicrosoftSignIn() {
    window.location.href = `${BASE}/api/auth/microsoft`;
  }

  function handleAppleSignIn() {
    window.location.href = `${BASE}/api/auth/apple`;
  }

  function handleDemoClick() {
    window.location.href = `${BASE}/demo`;
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError("");
    setSubmitting(true);
    try {
      const endpoint = emailMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body: Record<string, string> = { email, password };
      if (emailMode === "register" && name) body.name = name;

      const res = await fetch(`${BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        sessionToken?: string;
        userName?: string;
        isNewUser?: boolean;
        error?: string;
      };
      if (!res.ok || !data.sessionToken) {
        setEmailError(data.error ?? "Sign-in failed. Please try again.");
        return;
      }
      // Mirror the same redirect pattern used by OAuth callbacks
      window.location.href = `/?token=${encodeURIComponent(data.sessionToken)}&name=${encodeURIComponent(data.userName ?? "")}&new=${data.isNewUser ? "1" : "0"}`;
    } catch {
      setEmailError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px",
    color: "#ece9ff", fontSize: "0.9rem", outline: "none", boxSizing: "border-box",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(160deg, #080812 0%, #0d0d1f 50%, #10102a 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        fontFamily: "'Inter', system-ui, sans-serif", padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "440px", textAlign: "center" }}>

        <div
          style={{
            width: "68px", height: "68px", borderRadius: "50%",
            background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: "24px",
            boxShadow: "0 0 40px rgba(79,70,229,0.45), 0 0 80px rgba(79,70,229,0.15)",
          }}
        >
          <span style={{ color: "white", fontWeight: "700", fontSize: "22px", letterSpacing: "0.05em" }}>W</span>
        </div>

        <h1 style={{ color: "#ece9ff", fontSize: "2.1rem", fontWeight: "600", margin: "0 0 10px", letterSpacing: "-0.03em" }}>
          Winston
        </h1>
        <p style={{ color: "#6b6b90", fontSize: "1rem", margin: "0 0 36px", lineHeight: "1.5" }}>
          Your personal companion is waiting.
        </p>

        {/* Social sign-in grid: Google | Microsoft / Apple | Demo */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
          <SocialButton
            onClick={handleGoogleSignIn}
            icon={
              <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
                <path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/>
                <path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/>
                <path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/>
                <path d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/>
              </svg>
            }
            label="Sign in"
            sub="with Google"
          />

          <SocialButton
            onClick={handleMicrosoftSignIn}
            icon={
              <svg width="24" height="24" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>
            }
            label="Sign in"
            sub="with Microsoft"
          />

          <SocialButton
            onClick={handleAppleSignIn}
            icon={
              <svg width="22" height="22" viewBox="0 0 814 1000" fill="#e8e4ff">
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.9 0 663 0 541.8c0-207.5 135.4-317.4 268.7-317.4 68.8 0 126.1 43.2 169.8 43.2 43.7 0 112.5-46.2 190.5-46.2 30.7 0 108.2 2.6 164.4 103.3zm-107.4-102.2c-22.7-26.2-57.7-45.7-92.7-45.7-3.8 0-7.7.3-11.5.9 1.9-17.3 9.6-34.6 21.1-48.9 22.7-27.3 59.4-47.4 93.1-47.4 2.6 0 5.2.1 7.8.4-1.7 17.1-9.6 34.2-17.8 47.7z"/>
              </svg>
            }
            label="Sign in"
            sub="with Apple"
          />

          <SocialButton
            onClick={handleDemoClick}
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" fill="rgba(251,191,36,0.18)"/>
              </svg>
            }
            label="See it in action"
            sub="No sign-in needed"
            style={{
              background: "linear-gradient(145deg, rgba(217,119,6,0.14) 0%, rgba(180,83,9,0.1) 100%)",
              border: "1px solid rgba(217,119,6,0.35)",
              color: "#fbbf24",
            }}
            hoverBg="linear-gradient(145deg, rgba(217,119,6,0.22) 0%, rgba(180,83,9,0.16) 100%)"
            hoverBorder="rgba(217,119,6,0.6)"
          />
        </div>

        {/* Email sign-in toggle */}
        <button
          onClick={() => setShowEmail((v) => !v)}
          style={{
            background: "none", border: "none", color: "#4f46e5", fontSize: "0.82rem",
            cursor: "pointer", marginBottom: "20px", opacity: 0.7, transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.7")}
        >
          {showEmail ? "Hide email sign-in ↑" : "Sign in with email →"}
        </button>

        {showEmail && (
          <div
            style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: "16px", padding: "24px", marginBottom: "20px", textAlign: "left",
            }}
          >
            <div style={{ display: "flex", gap: "0", marginBottom: "20px" }}>
              {(["login", "register"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => { setEmailMode(mode); setEmailError(""); }}
                  style={{
                    flex: 1, padding: "8px", background: emailMode === mode ? "rgba(79,70,229,0.25)" : "none",
                    border: "1px solid rgba(79,70,229,0.3)", color: emailMode === mode ? "#ece9ff" : "#6b6b90",
                    cursor: "pointer", fontSize: "0.84rem", fontWeight: emailMode === mode ? "600" : "400",
                    borderRadius: mode === "login" ? "8px 0 0 8px" : "0 8px 8px 0",
                    transition: "all 0.15s",
                  }}
                >
                  {mode === "login" ? "Sign In" : "Register"}
                </button>
              ))}
            </div>

            <form onSubmit={handleEmailSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {emailMode === "register" && (
                <input
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={inputStyle}
                  required
                />
              )}
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
                required
                autoComplete="email"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
                required
                minLength={8}
                autoComplete={emailMode === "login" ? "current-password" : "new-password"}
              />

              {emailError && (
                <p style={{ color: "#f87171", fontSize: "0.82rem", margin: 0 }}>{emailError}</p>
              )}

              <button
                type="submit"
                disabled={submitting}
                style={{
                  padding: "12px", background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
                  border: "none", borderRadius: "10px", color: "white", fontSize: "0.9rem",
                  fontWeight: "600", cursor: submitting ? "not-allowed" : "pointer",
                  opacity: submitting ? 0.7 : 1, transition: "opacity 0.15s",
                }}
              >
                {submitting ? "Signing in…" : emailMode === "login" ? "Sign In" : "Create Account"}
              </button>
            </form>
          </div>
        )}

        <p style={{ color: "#35354f", fontSize: "0.70rem", marginTop: "4px" }}>
          Private &amp; invitation-only
        </p>

        <p style={{ color: "#3a3a58", fontSize: "0.68rem", marginTop: "16px", lineHeight: "1.6" }}>
          By signing in you agree to our{" "}
          <a
            href="/api/terms" target="_blank" rel="noopener noreferrer"
            style={{ color: "#4f46e5", textDecoration: "none", opacity: 0.7 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
          >
            Terms of Service
          </a>
          {" "}and{" "}
          <a
            href="/api/privacy" target="_blank" rel="noopener noreferrer"
            style={{ color: "#4f46e5", textDecoration: "none", opacity: 0.7 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
          >
            Privacy Policy
          </a>
        </p>
      </div>
    </div>
  );
}
