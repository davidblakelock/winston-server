import { useState, FormEvent } from "react";
import { useLocation } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SignInProps {
  onAuthenticated: (token: string, userName: string) => void;
}

type EmailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "sent"; emailSent: boolean }
  | { kind: "link"; url: string }
  | { kind: "error"; message: string };

export default function SignIn({ onAuthenticated: _onAuthenticated }: SignInProps) {
  const [email, setEmail] = useState("");
  const [emailState, setEmailState] = useState<EmailState>({ kind: "idle" });
  const [showEmail, setShowEmail] = useState(false);
  const [, navigate] = useLocation();

  function handleGoogleSignIn() {
    window.location.href = `${BASE}/api/auth/google?signin=1`;
  }

  function handleDemoClick() {
    navigate("/demo");
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setEmailState({ kind: "loading" });
    try {
      const res = await fetch(`${BASE}/api/auth/magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        setEmailState({ kind: "error", message: "Something went wrong. Please try again." });
        return;
      }
      const data = (await res.json()) as { sent: boolean; emailSent?: boolean; magicLinkUrl?: string };

      if (data.emailSent) {
        setEmailState({ kind: "sent", emailSent: true });
      } else if (data.magicLinkUrl) {
        setEmailState({ kind: "link", url: data.magicLinkUrl });
      } else {
        setEmailState({ kind: "error", message: "Could not generate a sign-in link." });
      }
    } catch {
      setEmailState({ kind: "error", message: "Network error. Please try again." });
    }
  }

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
        position: "relative",
      }}
    >
      <div style={{ width: "100%", maxWidth: "440px", textAlign: "center" }}>

        {/* Logo */}
        <div
          style={{
            width: "68px",
            height: "68px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "24px",
            boxShadow: "0 0 40px rgba(79,70,229,0.45), 0 0 80px rgba(79,70,229,0.15)",
          }}
        >
          <span style={{ color: "white", fontWeight: "700", fontSize: "22px", letterSpacing: "0.05em" }}>
            W
          </span>
        </div>

        {/* Wordmark */}
        <h1 style={{ color: "#ece9ff", fontSize: "2.1rem", fontWeight: "600", margin: "0 0 10px", letterSpacing: "-0.03em" }}>
          Winston
        </h1>

        {/* Tagline */}
        <p style={{ color: "#6b6b90", fontSize: "1rem", margin: "0 0 44px", lineHeight: "1.5" }}>
          Your personal companion is waiting.
        </p>

        {/* ── Two main CTA buttons ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "14px",
            marginBottom: "28px",
          }}
        >
          {/* Sign In with Google */}
          <button
            onClick={handleGoogleSignIn}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              padding: "20px 16px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: "16px",
              color: "#d4d0f0",
              fontSize: "0.88rem",
              fontWeight: "500",
              cursor: "pointer",
              transition: "all 0.18s ease",
              lineHeight: "1.3",
              minHeight: "110px",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "rgba(79,70,229,0.1)";
              el.style.borderColor = "rgba(79,70,229,0.45)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "rgba(255,255,255,0.04)";
              el.style.borderColor = "rgba(255,255,255,0.12)";
            }}
          >
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
              <path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107" />
              <path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00" />
              <path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50" />
              <path d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2" />
            </svg>
            <span>Sign in<br /><span style={{ color: "#a5a0cc", fontWeight: "400", fontSize: "0.8rem" }}>with Google</span></span>
          </button>

          {/* See the demo — warm amber glow */}
          <button
            onClick={handleDemoClick}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              padding: "20px 16px",
              background: "linear-gradient(145deg, rgba(217,119,6,0.14) 0%, rgba(180,83,9,0.1) 100%)",
              border: "1px solid rgba(217,119,6,0.35)",
              borderRadius: "16px",
              color: "#fbbf24",
              fontSize: "0.88rem",
              fontWeight: "500",
              cursor: "pointer",
              transition: "all 0.18s ease",
              lineHeight: "1.3",
              minHeight: "110px",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "linear-gradient(145deg, rgba(217,119,6,0.22) 0%, rgba(180,83,9,0.16) 100%)";
              el.style.borderColor = "rgba(217,119,6,0.6)";
              el.style.boxShadow = "0 0 24px rgba(217,119,6,0.18)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = "linear-gradient(145deg, rgba(217,119,6,0.14) 0%, rgba(180,83,9,0.1) 100%)";
              el.style.borderColor = "rgba(217,119,6,0.35)";
              el.style.boxShadow = "none";
            }}
          >
            {/* Play/sparkle icon */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" fill="rgba(251,191,36,0.18)" />
            </svg>
            <span style={{ color: "#fcd34d" }}>See it in action<br /><span style={{ color: "#d97706", fontWeight: "400", fontSize: "0.8rem" }}>No sign-in needed</span></span>
          </button>
        </div>

        {/* ── Email sign-in (secondary, collapsible) ── */}
        {emailState.kind === "sent" ? (
          <div
            style={{
              background: "rgba(79,70,229,0.08)",
              border: "1px solid rgba(79,70,229,0.3)",
              borderRadius: "14px",
              padding: "24px 20px",
              textAlign: "center",
              marginBottom: "20px",
            }}
          >
            <p style={{ color: "#a5b4fc", fontWeight: "600", margin: "0 0 8px", fontSize: "1rem" }}>
              Check your inbox
            </p>
            <p style={{ color: "#6b6b90", fontSize: "0.9rem", margin: 0, lineHeight: 1.5 }}>
              We sent a sign-in link to <strong style={{ color: "#c4c0ff" }}>{email}</strong>.
              Click it to continue.
            </p>
          </div>
        ) : emailState.kind === "link" ? (
          <div
            style={{
              background: "rgba(79,70,229,0.08)",
              border: "1px solid rgba(79,70,229,0.3)",
              borderRadius: "14px",
              padding: "24px 20px",
              textAlign: "center",
              marginBottom: "20px",
            }}
          >
            <p style={{ color: "#a5b4fc", fontWeight: "600", margin: "0 0 12px", fontSize: "1rem" }}>
              Your sign-in link is ready
            </p>
            <a
              href={emailState.url}
              style={{
                display: "inline-block",
                padding: "11px 24px",
                background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
                borderRadius: "10px",
                color: "white",
                fontWeight: "600",
                fontSize: "0.9rem",
                textDecoration: "none",
              }}
            >
              Sign in to Winston →
            </a>
          </div>
        ) : showEmail ? (
          <form onSubmit={handleEmailSubmit} style={{ marginBottom: "20px" }}>
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              style={{
                width: "100%",
                padding: "13px 16px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "12px",
                color: "#e8e4ff",
                fontSize: "0.95rem",
                outline: "none",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(79,70,229,0.6)"; e.currentTarget.style.background = "rgba(79,70,229,0.06)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
            />
            {emailState.kind === "error" && (
              <p style={{ color: "#f87171", fontSize: "0.83rem", margin: "8px 0 0", textAlign: "left" }}>
                {emailState.message}
              </p>
            )}
            <button
              type="submit"
              disabled={emailState.kind === "loading"}
              style={{
                width: "100%",
                padding: "13px 20px",
                background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
                border: "none",
                borderRadius: "12px",
                color: "white",
                fontSize: "0.95rem",
                fontWeight: "600",
                cursor: "pointer",
                marginTop: "12px",
                opacity: emailState.kind === "loading" ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {emailState.kind === "loading" ? "Sending…" : "Continue with Email"}
            </button>
          </form>
        ) : null}

        {/* Sign in with email link */}
        {emailState.kind === "idle" || emailState.kind === "error" ? (
          <button
            onClick={() => setShowEmail((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "#3e3e6a",
              fontSize: "0.78rem",
              cursor: "pointer",
              padding: "4px 8px",
              fontFamily: "inherit",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#6b6b90"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#3e3e6a"; }}
          >
            {showEmail ? "Hide email sign-in" : "Sign in with email instead"}
          </button>
        ) : null}

        <p style={{ color: "#22223a", fontSize: "0.70rem", marginTop: "28px", lineHeight: "1.5" }}>
          Private &amp; invitation-only
        </p>
      </div>
    </div>
  );
}
