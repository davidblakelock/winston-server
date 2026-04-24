import { useState, useEffect, useCallback } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Chat from "@/pages/Chat";
import Onboarding from "@/pages/Onboarding";
import OliviaArchive from "@/pages/OliviaArchive";
import Lists from "@/pages/Lists";
import SignIn from "@/pages/SignIn";
import Demo from "@/pages/Demo";
import { useAuth } from "@/hooks/useAuth";
import Home from "@/pages/Home";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

const queryClient = new QueryClient();
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── In-app browser detection & banner ────────────────────────────────────────

const WINSTON_URL = "https://winston-companion--davidblakelock.replit.app/";
const ANDROID_CHROME_INTENT = `intent://${WINSTON_URL.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`;

function detectInAppBrowser(): { detected: boolean; isAndroid: boolean; appName: string } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isAndroid = /Android/i.test(ua);
  // Known in-app browser markers
  const markers: { pattern: RegExp; name: string }[] = [
    { pattern: /FBAN|FBAV|FB_IAB|FBIOS/i, name: "Facebook" },
    { pattern: /Instagram/i, name: "Instagram" },
    { pattern: /Twitter|twttr/i, name: "Twitter / X" },
    { pattern: /LinkedInApp/i, name: "LinkedIn" },
    { pattern: /MicroMessenger/i, name: "WeChat" },
    { pattern: /musical_ly|TikTok/i, name: "TikTok" },
    { pattern: /Snapchat/i, name: "Snapchat" },
    // Gmail / Google App WebView
    { pattern: /GSA\//i, name: "Gmail" },
    // Generic Android WebView (wv flag, or WebView without Chrome/Firefox/Samsung)
    { pattern: /wv\)|; wv;/i, name: "in-app browser" },
  ];
  // If it looks like a real browser, don't flag it
  const isSafariNative = /Safari\//.test(ua) && !/Chrome\/|CriOS\/|FxiOS\//.test(ua) && !/FBAN|FBAV|Instagram|Twitter|GSA|LinkedInApp|wv\)/i.test(ua);
  const isChrome = /Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua) && !/wv\)|; wv;/i.test(ua);
  const isFirefox = /Firefox\/|FxiOS\//.test(ua);
  if (isSafariNative || isChrome || isFirefox) return { detected: false, isAndroid, appName: "" };

  for (const { pattern, name } of markers) {
    if (pattern.test(ua)) return { detected: true, isAndroid, appName: name };
  }
  return { detected: false, isAndroid, appName: "" };
}

function InAppBrowserBanner() {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("iab-banner-dismissed") === "1");
  const { detected, isAndroid, appName } = detectInAppBrowser();

  if (!detected || dismissed) return null;

  const handleDismiss = () => {
    sessionStorage.setItem("iab-banner-dismissed", "1");
    setDismissed(true);
  };

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] px-4 py-3 text-sm shadow-xl"
      style={{
        background: "linear-gradient(90deg, #92400e 0%, #78350f 60%, #92400e 100%)",
        borderBottom: "1px solid rgba(217,119,6,0.5)",
      }}
    >
      <div className="max-w-lg mx-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-amber-50 leading-snug">
              For the best experience, open Winston in Chrome
            </p>
            <p className="text-amber-200/80 text-xs mt-0.5 leading-relaxed">
              {appName ? `You're currently in the ${appName} browser. ` : ""}
              {isAndroid
                ? 'Tap the three-dot menu (⋮) and select "Open in Chrome".'
                : 'Tap the share icon and select "Open in Safari" or "Open in Chrome".'}
            </p>
          </div>
          <button
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="flex-shrink-0 text-amber-200/60 hover:text-amber-100 transition-colors text-lg leading-none mt-0.5"
          >
            ✕
          </button>
        </div>
        {isAndroid && (
          <a
            href={ANDROID_CHROME_INTENT}
            className="mt-2.5 w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2 font-semibold text-sm text-white transition-colors"
            style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(217,119,6,0.5)" }}
          >
            <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#4285F4"/>
              <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" fill="white"/>
              <path d="M12 8h8.9A10 10 0 0 0 3.6 6.3L7.7 13" stroke="#EA4335" strokeWidth="2" fill="none"/>
              <path d="M12 8a4 4 0 0 1 3.46 2H20.9" stroke="#FBBC05" strokeWidth="2" fill="none"/>
            </svg>
            Open in Chrome
          </a>
        )}
      </div>
    </div>
  );
}

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
  userPicture?: string;
  userName?: string;
  userFullName?: string;
}

interface ProfileInfo {
  companionName: string | null;
  voiceId: string | null;
  photoUrl: string | null;
  avatarBase64: string | null;
}

function AppShell({ onSignOut, userPicture, userName, userFullName }: AppShellProps) {
  const [onboardingStatus, setOnboardingStatus] = useState<
    "loading" | "new" | "returning"
  >("loading");
  const [profile, setProfile] = useState<ProfileInfo | null>(null);

  useEffect(() => {
    // ALWAYS fetch /api/onboarding/status — it is the authoritative source of truth.
    // Never trust the isNewUser hint from the OAuth/magic-link response for routing.
    const token = localStorage.getItem("winston_session_token");
    const storedName = localStorage.getItem("winston_user_name");

    console.log("[AUTH] AppShell — checking stored session:", {
      hasToken: !!token,
      tokenPrefix: token ? token.slice(0, 8) + "…" : null,
      storedUserName: storedName,
    });

    if (!token) {
      console.log("[AUTH] AppShell — no session token in localStorage, routing to onboarding/new user");
      setOnboardingStatus("new");
      return;
    }

    console.log("[AUTH] AppShell — fetching /api/onboarding/status to determine routing");
    fetch(`${API}/api/onboarding/status`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then((r) => {
        console.log("[AUTH] AppShell — /api/onboarding/status HTTP status:", r.status);
        if (r.status === 401) {
          console.warn("[AUTH] AppShell — 401 from /api/onboarding/status, treating as new user");
          return { isNewUser: true, profile: null } as { isNewUser: boolean; profile: { companionName: string | null; voiceId?: string | null; photoUrl?: string | null; avatarBase64?: string | null } | null };
        }
        return r.json() as Promise<{ isNewUser: boolean; profile: { companionName: string | null; voiceId?: string | null; photoUrl?: string | null; avatarBase64?: string | null } | null }>;
      })
      .then((data) => {
        console.log("[AUTH] AppShell — /api/onboarding/status response:", {
          isNewUser: data.isNewUser,
          hasProfile: !!data.profile,
          companionName: data.profile?.companionName ?? null,
        });
        if (data.profile) {
          setProfile({
            companionName: data.profile.companionName ?? null,
            voiceId: data.profile.voiceId ?? null,
            photoUrl: data.profile.photoUrl ?? null,
            avatarBase64: data.profile.avatarBase64 ?? null,
          });
          if (data.profile.companionName) localStorage.setItem("winston_companion_name", data.profile.companionName);
          if (data.profile.voiceId) localStorage.setItem("winston_voice_id", data.profile.voiceId);
        }
        const routing = data.isNewUser ? "new" : "returning";
        console.log("[AUTH] AppShell — routing decision:", routing);
        setOnboardingStatus(routing);
      })
      .catch((err) => {
        console.error("[AUTH] AppShell — /api/onboarding/status fetch failed:", err);
        setOnboardingStatus("returning");
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (onboardingStatus === "loading") return <LoadingScreen />;

  if (onboardingStatus === "new") {
    return <Onboarding onComplete={(companionName?: string) => {
      if (companionName) setProfile({ companionName, voiceId: null, photoUrl: null, avatarBase64: null });
      setOnboardingStatus("returning");
    }} />;
  }

  return (
    <Switch>
      <Route path="/lists">{() => <Lists />}</Route>
      <Route path="/">{() => <Chat onSignOut={onSignOut} companionName={profile?.companionName ?? null} voiceId={profile?.voiceId ?? null} photoUrl={profile?.photoUrl ?? null} avatarBase64={profile?.avatarBase64 ?? null} userPicture={userPicture} userName={userName} userFullName={userFullName} />}</Route>
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

  // ── Global notification tap handler ──────────────────────────────────────
  // When the service worker posts NOTIFICATION_TAP (user tapped a push notification),
  // always navigate to '/' regardless of which page the app is currently showing.
  // The pending reminder/message is stored in IDB by the service worker and
  // read by Chat.tsx once it mounts at '/'.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== "NOTIFICATION_TAP") return;
      console.log("[APP] NOTIFICATION_TAP received — forcing navigation to /");
      navigate("/");
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [navigate]);

  // ── Handle Google OAuth redirect: token + name arrive as URL params ───────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    const urlName  = params.get("name");
    const urlAuthError = params.get("auth");
    const urlIsNew = params.get("new"); // "1" = new user, "0" = returning

    console.log("[AUTH] App.tsx — URL params on load:", {
      hasToken: !!urlToken,
      hasName: !!urlName,
      isNew: urlIsNew,
      authError: urlAuthError,
      tokenPrefix: urlToken ? urlToken.slice(0, 8) + "…" : null,
    });

    if (urlAuthError === "error") {
      console.warn("[AUTH] App.tsx — Google OAuth returned auth=error");
      setAuthError(true);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (urlToken) {
      // We have a session token from Google OAuth redirect — process it
      const decodedName = urlName ? decodeURIComponent(urlName) : (localStorage.getItem("winston_user_name") ?? "");
      const isNewUser = urlIsNew === "1";
      const rawPicture = params.get("picture");
      const urlPicture = rawPicture ? decodeURIComponent(rawPicture) : undefined;

      console.log("[AUTH] App.tsx — Google sign-in token received:", {
        userName: decodedName,
        hasUrlName: !!urlName,
        isNewUser,
        hasPicture: !!urlPicture,
        pictureLength: urlPicture?.length ?? 0,
        tokenPrefix: urlToken.slice(0, 8) + "…",
      });

      if (isNewUser) {
        // ── NEW USER: wipe ALL local + session storage before loading any profile ──
        console.log("[AUTH] App.tsx — NEW USER detected — clearing ALL localStorage and sessionStorage");
        localStorage.clear();
        sessionStorage.clear();
      } else {
        console.log("[AUTH] App.tsx — RETURNING user — preserving storage, only clearing React Query cache");
      }

      // Always clear React Query cache on any Google sign-in
      queryClient.clear();

      console.log("[AUTH] App.tsx — calling setAuthenticated with new token");
      setAuthenticated(urlToken, decodedName, urlPicture);

      // Clean URL — remove query params so the token isn't visible or bookmarked
      window.history.replaceState({}, "", window.location.pathname);
      console.log("[AUTH] App.tsx — URL cleaned, auth flow complete");
    }
  }, [setAuthenticated]);

  // Olivia archive — always public
  if (location === "/olivia") {
    return <OliviaArchive />;
  }

  // Demo — always public, no sign-in required
  if (location === "/demo") {
    return <Demo />;
  }

  // Loading auth state (validating existing session token)
  if (authState.loading) return <LoadingScreen />;

  // Not authenticated — show sign in (Google OAuth only)
  if (!authState.authenticated) {
    return (
      <>
        {authError && <AuthErrorBanner onDismiss={() => setAuthError(false)} />}
        <SignIn />
      </>
    );
  }

  // Authenticated — AppShell always fetches /api/onboarding/status as ground truth
  return <AppShell onSignOut={handleSignOut} userPicture={authState.picture} userName={authState.userName} userFullName={authState.fullName} />;
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <InAppBrowserBanner />
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Switch>
            <Route path="/demo">{() => <Demo />}</Route>
            <Route path="/home">{() => <Home />}</Route>
            <Route path="/privacy">{() => <Privacy />}</Route>
            <Route path="/terms">{() => <Terms />}</Route>
            <Route>{() => <AppWithAuth />}</Route>
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
