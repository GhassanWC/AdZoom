"use client";

/**
 * Paginated-list fetch hook for admin list routes. Handles Bearer auth,
 * cursor accumulation ("load more"), the `indexBuilding` degraded state, and
 * exposes any extra aggregate fields the route returns alongside `rows`.
 *
 * Filters are compared by value (JSON) — changing a filter resets the list to
 * page one.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";

interface ListResponse<T> {
  rows?: T[];
  nextCursor?: string | null;
  indexBuilding?: boolean;
  [key: string]: unknown;
}

export interface AdminListState<TRow, TExtra> {
  rows: TRow[];
  extra: Partial<TExtra>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  indexBuilding: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

export function useAdminList<TRow, TExtra = Record<string, unknown>>(
  path: string,
  filters: Record<string, string | undefined> = {}
): AdminListState<TRow, TExtra> {
  const { getIdToken } = useAuth();
  const [rows, setRows] = React.useState<TRow[]>([]);
  const [extra, setExtra] = React.useState<Partial<TExtra>>({});
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [indexBuilding, setIndexBuilding] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const filtersKey = JSON.stringify(filters);

  const fetchPage = React.useCallback(
    async (cur: string | null): Promise<ListResponse<TRow>> => {
      const token = await getIdToken();
      if (!token) throw new Error("You are not signed in.");
      const parsed = JSON.parse(filtersKey) as Record<string, string | undefined>;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed)) if (v) sp.set(k, v);
      if (cur) sp.set("cursor", cur);
      const qs = sp.toString();
      const res = await fetch(`${path}${qs ? `?${qs}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      return (await res.json()) as ListResponse<TRow>;
    },
    [path, filtersKey, getIdToken]
  );

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIndexBuilding(false);
    fetchPage(null)
      .then((json) => {
        if (cancelled) return;
        setRows(json.rows ?? []);
        setCursor(json.nextCursor ?? null);
        setIndexBuilding(Boolean(json.indexBuilding));
        const { rows: _r, nextCursor: _n, indexBuilding: _i, ...rest } = json;
        void _r;
        void _n;
        void _i;
        setExtra(rest as Partial<TExtra>);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Request failed");
          setRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, nonce]);

  const loadMore = React.useCallback(() => {
    if (!cursor) return;
    setLoadingMore(true);
    fetchPage(cursor)
      .then((json) => {
        setRows((prev) => [...prev, ...(json.rows ?? [])]);
        setCursor(json.nextCursor ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Request failed"))
      .finally(() => setLoadingMore(false));
  }, [cursor, fetchPage]);

  return {
    rows,
    extra,
    loading,
    loadingMore,
    error,
    indexBuilding,
    hasMore: Boolean(cursor),
    loadMore,
    reload: () => setNonce((n) => n + 1),
  };
}
