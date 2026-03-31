const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface SignInProps {
  onAuthenticated: (token: string, userName: string) => void;
}

export default function SignIn({ onAuthenticated: _onAuthenticated }: SignInProps) {
  function handleGoogleSignIn() {
    window.location.href = `${BASE}/api/auth/google?signin=1`;
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
      }}
    >
      <div style={{ width: "100%", maxWidth: "380px", textAlign: "center" }}>
        {/* Logo */}
        <div
          style={{
            width: "64px",
            height: "64px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "28px",
            boxShadow: "0 0 40px rgba(79,70,229,0.45), 0 0 80px rgba(79,70,229,0.15)",
          }}
        >
          <span
            style={{
              color: "white",
              fontWeight: "700",
              fontSize: "20px",
              letterSpacing: "0.05em",
            }}
          >
            EP
          </span>
        </div>

        {/* Wordmark */}
        <h1
          style={{
            color: "#ece9ff",
            fontSize: "2rem",
            fontWeight: "600",
            margin: "0 0 10px",
            letterSpacing: "-0.03em",
          }}
        >
          Winston
        </h1>

        {/* Tagline */}
        <p
          style={{
            color: "#6b6b90",
            fontSize: "1rem",
            margin: "0 0 48px",
            lineHeight: "1.5",
          }}
        >
          Your personal companion is waiting.
        </p>

        {/* Google Sign-In Button */}
        <button
          onClick={handleGoogleSignIn}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            padding: "14px 20px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "12px",
            color: "#e8e4ff",
            fontSize: "0.95rem",
            fontWeight: "500",
            cursor: "pointer",
            transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
            letterSpacing: "0.01em",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.09)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(79,70,229,0.5)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 0 20px rgba(79,70,229,0.15)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.12)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
          }}
        >
          {/* Google G logo */}
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
            <path
              d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
              fill="#FFC107"
            />
            <path
              d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
              fill="#FF3D00"
            />
            <path
              d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
              fill="#4CAF50"
            />
            <path
              d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
              fill="#1976D2"
            />
          </svg>
          Continue with Google
        </button>

        <p
          style={{
            color: "#2e2e50",
            fontSize: "0.72rem",
            marginTop: "32px",
            lineHeight: "1.5",
          }}
        >
          Private &amp; invitation-only
        </p>
      </div>
    </div>
  );
}
