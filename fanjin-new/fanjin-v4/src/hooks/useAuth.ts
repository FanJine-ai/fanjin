import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "@/types";
import { clearAuth, readAuth, writeAuth } from "@/lib/auth-storage";
import { api } from "@/lib/api";

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(() => readAuth());
  const [loading, setLoading] = useState(false);

  const sync = useCallback(() => {
    setUser(readAuth());
  }, []);

  useEffect(() => {
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [sync]);

  useEffect(() => {
    const current = readAuth();
    if (!current?.userId || !current.apiKey) return;
    void api.refreshUser()
      .then((next) => {
        if (next) {
          setUser(next);
          return;
        }
        clearAuth();
        setUser(null);
      })
      .catch((error: any) => {
        const status = Number(error?.status || 0);
        if (status === 401 || status === 404) {
          clearAuth();
          setUser(null);
        }
      });
  }, []);

  const refresh = useCallback(async () => {
    if (!readAuth()) return null;
    setLoading(true);
    try {
      const next = await api.refreshUser();
      setUser(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setUser(null);
  }, []);

  const update = useCallback((patch: Partial<AuthUser>) => {
    const current = readAuth();
    if (!current) return;
    const next = { ...current, ...patch };
    writeAuth(next);
    setUser(next);
  }, []);

  return {
    user,
    loading,
    isLoggedIn: Boolean(user),
    refresh,
    logout,
    update,
  };
}
