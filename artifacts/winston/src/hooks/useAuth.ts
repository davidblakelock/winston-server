import { useState, useEffect, useCallback } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const SESSION_KEY = "winston_session_token";

export interface AuthState {
  loading: boolean;
  authenticated: boolean;
  userName?: string;
  email?: string;
  token?: string;
  picture?: string;
  fullName?: string;
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
    setAuthTokenGetter(null);
    setAuthState({ loading: false, authenticated: false });
    console.log("[AUTH] useAuth.signOut — complete, auth state cleared");
  }, []);

  const setAuthenticated = useCallback((token: string, userName: string, email?: string) => {
    console.log("[AUTH] useAuth.setAuthenticated — persisting session:", {
      userName,
      email: email ?? "(not provided)",
      tokenPrefix: token.slice(0, 8) + "…",
    });
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem("winston_user_name", userName);
    setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
    setAuthState({ loading: false, authenticated: true, userName, email, token });
    console.log("[AUTH] useAuth.setAuthenticated — auth state set, userName:", userName);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    const storedName = localStorage.getItem("winston_user_name");

    console.log("[AUTH] useAuth — initial session check:", {
      hasStoredToken: !!token,
      tokenPrefix: token ? token.slice(0, 8) + "…" : null,
      storedUserName: storedName,
    });

    if (!token) {
      console.log("[AUTH] useAuth — no stored token, user is not authenticated");
      setAuthState({ loading: false, authenticated: false });
      return;
    }

    console.log("[AUTH] useAuth — validating token against /api/auth/session");
    fetch(`${BASE}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        console.log("[AUTH] useAuth — /api/auth/session HTTP status:", r.status);
        return r.json() as Promise<{ authenticated: boolean; userName?: string; email?: string; picture?: string | null; fullName?: string | null }>;
      })
      .then((data) => {
        console.log("[AUTH] useAuth — /api/auth/session response:", {
          authenticated: data.authenticated,
          userName: data.userName ?? null,
          email: data.email ?? null,
        });

        if (data.authenticated && data.userName) {
          setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
          setAuthState({
            loading: false,
            authenticated: true,
            userName: data.userName,
            email: data.email,
            token,
            picture: data.picture ?? undefined,
            fullName: data.fullName ?? undefined,
          });
          console.log("[AUTH] useAuth — session valid, authenticated as:", data.userName);
        } else {
          console.warn("[AUTH] useAuth — session invalid or userName missing, clearing auth state");
          localStorage.removeItem(SESSION_KEY);
          setAuthTokenGetter(null);
          setAuthState({ loading: false, authenticated: false });
        }
      })
      .catch((err) => {
        // Network error — keep authenticated if token exists (offline-friendly)
        const fallbackName = storedName ?? "(unknown — no stored name)";
        console.error("[AUTH] useAuth — /api/auth/session fetch error:", err);
        console.warn("[AUTH] useAuth — network error fallback, using stored name:", fallbackName);
        setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
        setAuthState({ loading: false, authenticated: true, userName: storedName ?? undefined, token });
      });
  }, []);

  return { authState, signOut, setAuthenticated };
}
