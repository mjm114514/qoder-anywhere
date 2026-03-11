import { useState, useEffect, useCallback } from "react";
import type { AuthStatus } from "@lgtm-anywhere/shared";

export function useAuth(): {
  auth: AuthStatus;
  verify: (code: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
} {
  const [auth, setAuth] = useState<AuthStatus>({ state: "loading" });

  useEffect(() => {
    // Check if already authenticated
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => res.json())
      .then((data: { authenticated: boolean }) => {
        if (data.authenticated) {
          // Check if auth is even enabled
          return fetch("/api/auth/status", { credentials: "include" })
            .then((r) => r.json())
            .then((status: { authEnabled: boolean }) => {
              if (!status.authEnabled) {
                setAuth({ state: "disabled" });
              } else {
                setAuth({ state: "authenticated" });
              }
            });
        } else {
          setAuth({ state: "unauthenticated" });
        }
      })
      .catch(() => {
        setAuth({ state: "unauthenticated" });
      });
  }, []);

  const verify = useCallback(
    async (token: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
        };
        if (data.ok) {
          setAuth({ state: "authenticated" });
          return { ok: true };
        }
        return { ok: false, error: data.error ?? "Invalid token" };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setAuth({ state: "unauthenticated" });
  }, []);

  return { auth, verify, logout };
}
