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
}

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({ loading: true, authenticated: false });

  const signOut = useCallback(async () => {
    const token = localStorage.getItem(SESSION_KEY);
    if (token) {
      fetch(`${BASE}/api/auth/session/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("winston_user_name");
    setAuthTokenGetter(null);
    setAuthState({ loading: false, authenticated: false });
  }, []);

  const setAuthenticated = useCallback((token: string, userName: string, email?: string) => {
    localStorage.setItem(SESSION_KEY, token);
    localStorage.setItem("winston_user_name", userName);
    setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
    setAuthState({ loading: false, authenticated: true, userName, email, token });
  }, []);

  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) {
      setAuthState({ loading: false, authenticated: false });
      return;
    }

    fetch(`${BASE}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<{ authenticated: boolean; userName?: string; email?: string }>)
      .then((data) => {
        if (data.authenticated && data.userName) {
          setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
          setAuthState({
            loading: false,
            authenticated: true,
            userName: data.userName,
            email: data.email,
            token,
          });
        } else {
          localStorage.removeItem(SESSION_KEY);
          setAuthTokenGetter(null);
          setAuthState({ loading: false, authenticated: false });
        }
      })
      .catch(() => {
        // Network error — keep authenticated if token exists (offline-friendly)
        setAuthTokenGetter(() => localStorage.getItem(SESSION_KEY));
        setAuthState({ loading: false, authenticated: true, userName: "David", token });
      });
  }, []);

  return { authState, signOut, setAuthenticated };
}
