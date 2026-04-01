const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignIn() {
  function handleGoogleSignIn() {
    window.location.href = `${BASE}/api/auth/google?signin=1`;
  }

  function handleDemoClick() {
    window.location.href = `${BASE}/demo`;
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
      <div style={{ width: "100%", maxWidth: "440px", textAlign: "center" }}>

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
          <span style={{ color: "white", fontWeight: "700", fontSize: "22px", letterSpacing: "0.05em" }}>W</span>
        </div>

        <h1 style={{ color: "#ece9ff", fontSize: "2.1rem", fontWeight: "600", margin: "0 0 10px", letterSpacing: "-0.03em" }}>
          Winston
        </h1>
        <p style={{ color: "#6b6b90", fontSize: "1rem", margin: "0 0 44px", lineHeight: "1.5" }}>
          Your personal companion is waiting.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "28px" }}>
          <button
            onClick={handleGoogleSignIn}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: "10px", padding: "20px 16px",
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: "16px", color: "#d4d0f0", fontSize: "0.88rem", fontWeight: "500",
              cursor: "pointer", transition: "all 0.18s ease", lineHeight: "1.3", minHeight: "110px",
            }}
            onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "rgba(79,70,229,0.1)"; el.style.borderColor = "rgba(79,70,229,0.45)"; }}
            onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "rgba(255,255,255,0.04)"; el.style.borderColor = "rgba(255,255,255,0.12)"; }}
          >
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
              <path d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" fill="#FFC107"/>
              <path d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" fill="#FF3D00"/>
              <path d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" fill="#4CAF50"/>
              <path d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" fill="#1976D2"/>
            </svg>
            <span>Sign in<br /><span style={{ color: "#a5a0cc", fontWeight: "400", fontSize: "0.8rem" }}>with Google</span></span>
          </button>

          <button
            onClick={handleDemoClick}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: "10px", padding: "20px 16px",
              background: "linear-gradient(145deg, rgba(217,119,6,0.14) 0%, rgba(180,83,9,0.1) 100%)",
              border: "1px solid rgba(217,119,6,0.35)", borderRadius: "16px", color: "#fbbf24",
              fontSize: "0.88rem", fontWeight: "500", cursor: "pointer",
              transition: "all 0.18s ease", lineHeight: "1.3", minHeight: "110px",
            }}
            onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "linear-gradient(145deg, rgba(217,119,6,0.22) 0%, rgba(180,83,9,0.16) 100%)"; el.style.borderColor = "rgba(217,119,6,0.6)"; el.style.boxShadow = "0 0 24px rgba(217,119,6,0.18)"; }}
            onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "linear-gradient(145deg, rgba(217,119,6,0.14) 0%, rgba(180,83,9,0.1) 100%)"; el.style.borderColor = "rgba(217,119,6,0.35)"; el.style.boxShadow = "none"; }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" fill="rgba(251,191,36,0.18)"/>
            </svg>
            <span style={{ color: "#fcd34d" }}>See it in action<br /><span style={{ color: "#d97706", fontWeight: "400", fontSize: "0.8rem" }}>No sign-in needed</span></span>
          </button>
        </div>

        <p style={{ color: "#22223a", fontSize: "0.70rem", marginTop: "12px" }}>
          Private &amp; invitation-only
        </p>
      </div>
    </div>
  );
}
