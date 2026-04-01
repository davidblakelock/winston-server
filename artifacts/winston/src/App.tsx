import { useState, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Chat from "@/pages/Chat";
import Onboarding from "@/pages/Onboarding";
import OliviaArchive from "@/pages/OliviaArchive";
import SignIn from "@/pages/SignIn";
import AuthVerify from "@/pages/AuthVerify";
import { useAuth } from "@/hooks/useAuth";

const queryClient = new QueryClient();
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Loading spinner ───────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 rounded-full bg-indigo-900 border border-indigo-700 flex items-center justify-center">
          <span className="text-sm font-semibold text-indigo-300">EP</span>
        </div>
        <div className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <div
              key={delay}
              className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Onboarding + Chat shell ───────────────────────────────────────────────────

function AppShell() {
  const [onboardingStatus, setOnboardingStatus] = useState<
    "loading" | "new" | "returning"
  >("loading");

  useEffect(() => {
    const token = localStorage.getItem("winston_session_token");
    fetch(`${API}/api/onboarding/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json() as Promise<{ isNewUser: boolean }>)
      .then((data) => {
        setOnboardingStatus(data.isNewUser ? "new" : "returning");
      })
      .catch(() => {
        setOnboardingStatus("returning");
      });
  }, []);

  if (onboardingStatus === "loading") return <LoadingScreen />;

  if (onboardingStatus === "new") {
    return <Onboarding onComplete={() => setOnboardingStatus("returning")} />;
  }

  return (
    <Switch>
      <Route path="/" component={Chat} />
      <Route component={NotFound} />
    </Switch>
  );
}

// ── Auth error banner ─────────────────────────────────────────────────────────

function AuthErrorBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        top: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(248,113,113,0.15)",
        border: "1px solid rgba(248,113,113,0.3)",
        borderRadius: "10px",
        padding: "12px 20px",
        color: "#fca5a5",
        fontSize: "0.875rem",
        zIndex: 9999,
        display: "flex",
        gap: "12px",
        alignItems: "center",
      }}
    >
      <span>Sign-in was unsuccessful. Please try again.</span>
      <button
        onClick={onDismiss}
        style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontSize: "1rem" }}
      >
        ✕
      </button>
    </div>
  );
}

// ── Root with auth routing ────────────────────────────────────────────────────

function AppWithAuth() {
  const { authState, setAuthenticated } = useAuth();
  const [location, navigate] = useLocation();
  const [authError, setAuthError] = useState(false);

  // ── Handle Google OAuth redirect: token arrives as URL query param ──────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    const urlName = params.get("name");
    const urlAuthError = params.get("auth");

    if (urlAuthError === "error") {
      setAuthError(true);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (urlToken && urlName) {
      // Consume token from URL, save to auth state
      setAuthenticated(urlToken, decodeURIComponent(urlName));
      // Clean the URL — strip query params
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [setAuthenticated]);

  // Olivia archive — always public
  if (location === "/olivia") {
    return <OliviaArchive />;
  }

  // Legacy magic-link verification route
  if (location.startsWith("/auth/verify")) {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    const token = params.get("token") ?? "";
    return (
      <AuthVerify
        token={token}
        onAuthenticated={(t, name) => { setAuthenticated(t, name); navigate("/"); }}
        onFailed={() => navigate("/")}
      />
    );
  }

  // Loading auth state
  if (authState.loading) return <LoadingScreen />;

  // Not authenticated — show sign in
  if (!authState.authenticated) {
    return (
      <>
        {authError && <AuthErrorBanner onDismiss={() => setAuthError(false)} />}
        <SignIn onAuthenticated={(t, name) => { setAuthenticated(t, name); navigate("/"); }} />
      </>
    );
  }

  // Authenticated — main app
  return <AppShell />;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppWithAuth />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
