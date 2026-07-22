"use client";

/**
 * The ONE data hook for every admin page.
 *
 * Replaces the previous `useAdminApi` (single object) + `useAdminList`
 * (cursor-accumulating list) pair. Both re-implemented token fetching, param
 * serialization and error parsing, and neither was ever used with its own
 * `reload()` — so no admin page had a refresh button and every error state was
 * a dead end requiring a browser reload.
 *
 * Behaviours that matter:
 *
 * • KEEPS PREVIOUS DATA WHILE REFETCHING. Changing a filter used to null out
 *   `data`, which tore down the metric cards, charts and table and replaced the
 *   whole page with a spinner. Here `data` survives until the new response
 *   lands, and `isRefreshing` drives a subtle inline indicator instead. Only
 *   the very first load shows skeletons.
 *
 * • CANCELS SUPERSEDED REQUESTS. Each fetch carries a sequence number and a
 *   real `AbortController`; a slower earlier response can never overwrite a
 *   newer one. The old `loadMore` had no cancellation at all, so changing a
 *   filter mid-load appended rows from the previous filter onto the new list.
 *
 * • RETRIES ON EXPIRED TOKENS. A 401 triggers exactly one forced token refresh
 *   and retry, because an ID token that expires while the dashboard is open
 *   previously surfaced as a permanent error with no way back.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";

export interface AdminQueryState<T> {
  data: T | null;
  /** True only when there is nothing to show yet — drives skeletons. */
  isLoading: boolean;
  /** True while refetching with data already on screen — drives the subtle bar. */
  isRefreshing: boolean;
  error: string | null;
  /** Server signalled a Firestore index is still building. */
  indexBuilding: boolean;
  /** Manual refresh / retry. */
  refresh: () => void;
  /** Epoch-ms the currently displayed data arrived. */
  updatedAt: number | null;
}

/** Drop empty/undefined params so they never reach the query string. */
function toQueryString(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function useAdminQuery<T>(
  path: string,
  params: Record<string, string | number | undefined | null> = {}
): AdminQueryState<T> {
  const { getIdToken } = useAuth();

  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [indexBuilding, setIndexBuilding] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  const [nonce, setNonce] = React.useState(0);

  // Serializing params gives the effect a stable primitive dependency, so an
  // inline object literal at the call site cannot cause a refetch loop.
  const paramKey = JSON.stringify(params);

  // `seq` guards against out-of-order responses; `hasData` decides whether this
  // is a first load (skeletons) or a refresh (keep the current view).
  const seqRef = React.useRef(0);
  const hasDataRef = React.useRef(false);

  React.useEffect(() => {
    const seq = ++seqRef.current;
    const controller = new AbortController();

    if (hasDataRef.current) setIsRefreshing(true);
    else setIsLoading(true);

    (async () => {
      /** One attempt; `forceRefresh` re-mints the ID token for the 401 retry. */
      const attempt = async (forceRefresh: boolean): Promise<Response> => {
        const token = await getIdToken(forceRefresh);
        return fetch(`${path}${toQueryString(JSON.parse(paramKey))}`, {
          headers: { Authorization: `Bearer ${token ?? ""}` },
          cache: "no-store",
          signal: controller.signal,
        });
      };

      try {
        let res = await attempt(false);
        // An ID token that expired while the tab sat open is recoverable —
        // mint a fresh one and retry once before surfacing an error.
        if (res.status === 401) res = await attempt(true);

        const body = (await res.json().catch(() => null)) as
          | (T & { error?: string; indexBuilding?: boolean })
          | null;

        if (seq !== seqRef.current) return; // superseded by a newer request

        if (!res.ok) {
          setError(body?.error || `Request failed (${res.status})`);
          setIndexBuilding(false);
          return;
        }

        setError(null);

        // `{ indexBuilding: true }` is a SENTINEL, not a payload — the route
        // returns it INSTEAD of the page's data when a Firestore index is
        // missing (lib/admin/handler.ts). Storing it as `data` made `hasData`
        // true, so a page whose render reads e.g. `d.users.truncated` threw a
        // TypeError before `PageFrame` ever got to choose the index-building
        // view, and the whole route fell through to the error boundary. Keep it
        // out of `data`: the state flag alone drives the panel.
        const building = body?.indexBuilding === true;
        setIndexBuilding(building);
        if (building) return;

        setData((body as T) ?? null);
        hasDataRef.current = true;
        setUpdatedAt(Date.now());
      } catch (err) {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        if (seq === seqRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    })();

    return () => controller.abort();
  }, [path, paramKey, nonce, getIdToken]);

  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    isLoading: isLoading && !data,
    isRefreshing,
    error,
    indexBuilding,
    refresh,
    updatedAt,
  };
}

/**
 * Debounce a rapidly-changing value (search boxes) so each keystroke does not
 * fire a Firestore scan.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
