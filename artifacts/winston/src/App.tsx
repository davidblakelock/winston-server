import { useState, useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Chat from "@/pages/Chat";
import Onboarding from "@/pages/Onboarding";

const queryClient = new QueryClient();

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

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
        // On error, skip onboarding and go straight to chat (safe default)
        setOnboardingStatus("returning");
      });
  }, []);

  if (onboardingStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-indigo-900 border border-indigo-700 flex items-center justify-center">
            <span className="text-sm font-semibold text-indigo-300">EP</span>
          </div>
          <div className="flex gap-1">
            <div
              className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <div
              className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            />
            <div
              className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (onboardingStatus === "new") {
    return (
      <Onboarding
        onComplete={() => setOnboardingStatus("returning")}
      />
    );
  }

  return (
    <Switch>
      <Route path="/" component={Chat} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppShell />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
