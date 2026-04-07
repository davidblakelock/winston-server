import { useState, useEffect, useCallback } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const SESSION_KEY = "winston_session_token";
const PICTURE_KEY = "winston_user_picture";

// Enforce the correct Google account — any cached session from another account
// (e.g. an old winston@... account in Chrome) is automatically cleared.
const REQUIRED_EMAIL = "davidblakelock01@gmail.com";

export interface AuthState {
  loading: boolean;
  authenticated: boolean;
  userName?: string;
  email?: string;
  token?: string;
  picture?: string;
  fullName?: string;
}

type FullProfile = {
  authenticated: boolean;
  userName?: string;
  email?: string;
  picture?: string | null;
  fullName?: string | null;
};

/** Fetch /api/auth/session and return the full profile, or null on failure. */
async function fetchSessionProfile(token: string): Promise<FullProfile | null> {
  try {
    const r = await fetch(`${BASE}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as FullProfile;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({ loading: true, authenticated: false });

  const signOut = useCallback(async () => {
    const token = localStorage.getItem(SESSION_KEY);
    console.log("[AUTH] useAuth.signOut — revoking session, tokenPrefix:", token ? token.slice(0, 8) + "…" : null);
    if (token) {
      fetch(`${BASE}/api/auth/session/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("winston_user_name");
    localStorage.removeItem("winston_companion_name");
    localStorage.removeItem(PICTURE_KEY);
    setAuthTokenGetter(null);
    setAuthState({ loading: false, authenticated: false });
    console.log("[AUTH] useAuth.signOut — complete, auth state cleared");
  }, []);

  /**
   * Call this immediately after a successful sign-in (Google OAuth redirect or
   * magic-link verification). Sets auth state right away with what we know,
   * then fetches /api/auth/session in the background to hydrate picture +
   * fullName so the avatar appears without a page reload.
   */
  const setAuthenticated = useCallback((token: string, userName: string, picture?: string) => {
    console.log("[AUTH] useAuth.setAuthenticated — persisting session:", {
      userName,
      tokenPrefix: token.slice(0, 8) + "…",
      hasPicture: !!picture,
      pictureLength: picture?.length ?? 0,
      picturePreview: picture ? picture.slice(0, 60) + "…" : null,
    });
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem("winston_user_name", userName);
    if (picture) localStorage.setItem(PICTURE_KEY, picture);
    setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));

    // Immediately mark as authenticated — include picture if we already have it
    // (e.g. from the Google OAuth redirect URL param)
    setAuthState({ loading: false, authenticated: true, userName, token, picture });
    console.log("[AUTH] useAuth.setAuthenticated — initial auth state set, userName:", userName, "hasPicture:", !!picture);

    // Background fetch: hydrate picture + fullName from the session endpoint.
    // Runs even when picture is already known, to also capture fullName.
    fetchSessionProfile(token).then((data) => {
      if (!data || !data.authenticated) return;
      const resolvedPicture = data.picture ?? picture ?? undefined;
      if (resolvedPicture) localStorage.setItem(PICTURE_KEY, resolvedPicture);
      setAuthState((prev) => ({
        ...prev,
        loading: false,
        authenticated: true,
        userName: data.userName ?? userName,
        email: data.email ?? undefined,
        token,
        picture: resolvedPicture,
        fullName: data.fullName ?? undefined,
      }));
      console.log("[AUTH] useAuth.setAuthenticated — picture/fullName hydrated from session endpoint, hasPicture:", !!(data.picture));
    });
  }, []);

  // ── Initial session validation on mount ──────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    const storedName = localStorage.getItem("winston_user_name");
    const storedPicture = localStorage.getItem(PICTURE_KEY) ?? undefined;

    console.log("[AUTH] useAuth — initial session check:", {
      hasStoredToken: !!token,
      tokenPrefix: token ? token.slice(0, 8) + "…" : null,
      storedUserName: storedName,
      hasStoredPicture: !!storedPicture,
    });

    if (!token) {
      console.log("[AUTH] useAuth — no stored token, user is not authenticated");
      setAuthState({ loading: false, authenticated: false });
      return;
    }

    console.log("[AUTH] useAuth — validating token against /api/auth/session");
    fetchSessionProfile(token).then((data) => {
      console.log("[AUTH] useAuth — /api/auth/session response:", {
        authenticated: data?.authenticated ?? false,
        userName: data?.userName ?? null,
        email: data?.email ?? null,
        hasPicture: !!(data?.picture),
        pictureLength: data?.picture?.length ?? 0,
        picturePreview: data?.picture ? data.picture.slice(0, 60) + "…" : null,
      });

      if (data && data.authenticated && data.userName) {
        // Fix 5: Enforce the correct Google account — clear any cached session
        // from a different account (e.g. old winston@... session cached in Chrome).
        if (data.email && data.email.toLowerCase() !== REQUIRED_EMAIL) {
          console.warn("[AUTH] useAuth — wrong account detected:", data.email, "— expected:", REQUIRED_EMAIL, "— clearing session");
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(PICTURE_KEY);
          localStorage.removeItem("winston_user_name");
          localStorage.removeItem("winston_companion_name");
          setAuthTokenGetter(null);
          setAuthState({ loading: false, authenticated: false });
          return;
        }
        // Persist picture to localStorage so it's available instantly next time
        const resolvedPicture = data.picture ?? storedPicture ?? undefined;
        if (resolvedPicture) localStorage.setItem(PICTURE_KEY, resolvedPicture);
        setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
        setAuthState({
          loading: false,
          authenticated: true,
          userName: data.userName,
          email: data.email ?? undefined,
          token,
          picture: resolvedPicture,
          fullName: data.fullName ?? undefined,
        });
        console.log("[AUTH] useAuth — session valid, authenticated as:", data.userName, "email:", data.email, "hasPicture:", !!resolvedPicture);
      } else {
        console.warn("[AUTH] useAuth — session invalid or userName missing, clearing auth state");
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(PICTURE_KEY);
        setAuthTokenGetter(null);
        setAuthState({ loading: false, authenticated: false });
      }
    }).catch((err) => {
      // Network error — keep authenticated if token exists (offline-friendly)
      const fallbackName = storedName ?? "(unknown — no stored name)";
      console.error("[AUTH] useAuth — /api/auth/session fetch error:", err);
      console.warn("[AUTH] useAuth — network error fallback, using stored name:", fallbackName);
      setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
      // Use stored picture as fallback during network errors
      setAuthState({ loading: false, authenticated: true, userName: storedName ?? undefined, token, picture: storedPicture });
    });
  }, []);

  return { authState, signOut, setAuthenticated };
}
