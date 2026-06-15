"use client";

/**
 * Data-fetch hook for admin API routes. Attaches the caller's Firebase ID
 * token as a Bearer header (the server `requireAdmin` gate verifies it),
 * serializes query params, and exposes loading/error/reload.
 *
 * Params are compared by value (JSON) so callers can pass inline objects
 * without triggering refetch loops.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";

export interface AdminApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAdminApi<T>(
  path: string,
  params?: Record<string, string | undefined>
): AdminApiState<T> {
  const { getIdToken } = useAuth();
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  const paramsKey = JSON.stringify(params ?? {});

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getIdToken();
        if (!token) throw new Error("You are not signed in.");
        const sp = new URLSearchParams();
        const parsed = JSON.parse(paramsKey) as Record<string, string | undefined>;
        for (const [k, v] of Object.entries(parsed)) if (v) sp.set(k, v);
        const qs = sp.toString();
        const res = await fetch(`${path}${qs ? `?${qs}` : ""}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        const json = (await res.json()) as T;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Request failed");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, paramsKey, getIdToken, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}
