import { useState, useEffect, useCallback } from "react";
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
          <span className="text-sm font-semibold text-indigo-300">W</span>
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
// AppShell always fetches /api/onboarding/status as the authoritative routing
// decision — never trusts the isNewUser hint from the sign-in response.

interface AppShellProps {
  onSignOut: () => void;
}

interface ProfileInfo {
  companionName: string | null;
}

function AppShell({ onSignOut }: AppShellProps) {
  const [onboardingStatus, setOnboardingStatus] = useState<
    "loading" | "new" | "returning"
  >("loading");
  const [profile, setProfile] = useState<ProfileInfo | null>(null);

  useEffect(() => {
    // ALWAYS fetch /api/onboarding/status — it is the authoritative source of truth.
    // Never trust the isNewUser hint from the OAuth/magic-link response for routing.
    const token = localStorage.getItem("winston_session_token");
    if (!token) {
      setOnboardingStatus("new");
      return;
    }

    fetch(`${API}/api/onboarding/status`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then((r) => {
        if (r.status === 401) return { isNewUser: true, profile: null } as { isNewUser: boolean; profile: { companionName: string | null } | null };
        return r.json() as Promise<{ isNewUser: boolean; profile: { companionName: string | null } | null }>;
      })
      .then((data) => {
        if (data.profile?.companionName) {
          setProfile({ companionName: data.profile.companionName });
        }
        setOnboardingStatus(data.isNewUser ? "new" : "returning");
      })
      .catch(() => {
        setOnboardingStatus("returning");
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (onboardingStatus === "loading") return <LoadingScreen />;

  if (onboardingStatus === "new") {
    return <Onboarding onComplete={(companionName?: string) => {
      if (companionName) setProfile({ companionName });
      setOnboardingStatus("returning");
    }} />;
  }

  return (
    <Switch>
      <Route path="/">{() => <Chat onSignOut={onSignOut} companionName={profile?.companionName ?? null} />}</Route>
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
  const { authState, setAuthenticated, signOut } = useAuth();
  const [location, navigate] = useLocation();
  const [authError, setAuthError] = useState(false);

  // ── Sign out handler ──────────────────────────────────────────────────────
  const handleSignOut = useCallback(async () => {
    // Clear React Query cache so the next user always starts fresh
    queryClient.clear();
    await signOut();
  }, [signOut]);

  // ── Handle Google OAuth redirect: token + name arrive as URL params ───────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    const urlName  = params.get("name");
    const urlAuthError = params.get("auth");

    if (urlAuthError === "error") {
      setAuthError(true);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (urlToken && urlName) {
      // Clear any cached data from the previous session
      queryClient.clear();
      setAuthenticated(urlToken, decodeURIComponent(urlName));
      // Clean URL — remove query params so the token isn't visible or bookmarked
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [setAuthenticated]);

  // Olivia archive — always public
  if (location === "/olivia") {
    return <OliviaArchive />;
  }

  // Magic-link verification route
  if (location.startsWith("/auth/verify")) {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    const token = params.get("token") ?? "";
    return (
      <AuthVerify
        token={token}
        onAuthenticated={(t, name) => {
          queryClient.clear();
          setAuthenticated(t, name);
          navigate("/");
        }}
        onFailed={() => navigate("/")}
      />
    );
  }

  // Loading auth state (validating existing session token)
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

  // Authenticated — AppShell always fetches /api/onboarding/status as ground truth
  return <AppShell onSignOut={handleSignOut} />;
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
