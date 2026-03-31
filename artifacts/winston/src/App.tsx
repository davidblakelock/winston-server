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
    fetch(`${API}/api/onboarding/status`)
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

// ── Root with auth routing ────────────────────────────────────────────────────

function AppWithAuth() {
  const { authState, setAuthenticated } = useAuth();
  const [location, navigate] = useLocation();

  function handleAuthenticated(token: string, userName: string) {
    setAuthenticated(token, userName);
    navigate("/");
  }

  function handleAuthFailed() {
    navigate("/");
  }

  // Olivia archive — always public, its own password protection
  if (location === "/olivia") {
    return <OliviaArchive />;
  }

  // Magic link verification
  if (location.startsWith("/auth/verify")) {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    const token = params.get("token") ?? "";
    return (
      <AuthVerify
        token={token}
        onAuthenticated={handleAuthenticated}
        onFailed={handleAuthFailed}
      />
    );
  }

  // Loading auth state
  if (authState.loading) return <LoadingScreen />;

  // Not authenticated — show sign in
  if (!authState.authenticated) {
    return <SignIn onAuthenticated={handleAuthenticated} />;
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
