"use client";

import * as React from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/AuthProvider";
import type { MonthlyUsage } from "@/lib/firebase/schema";

/** "YYYY-MM" in UTC — the same key the server writes under (lib/usage/usage.ts). */
export function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthlyUsageState {
  /** Null until it loads, and for a month with no exports yet. */
  usage: MonthlyUsage | null;
  loading: boolean;
}

/**
 * This month's export counters — ONE document listener on
 * `users/{uid}/usage/{YYYY-MM}`, and nothing else.
 *
 * Split out of `useCloudMinutes` so a caller that only wants "how many exports
 * this month" (the dashboard) doesn't inherit that hook's plan lookup, which
 * drags a full project subscription along with it.
 */
export function useMonthlyUsage(): MonthlyUsageState {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  /**
   * TAGGED with the account it belongs to, and written only from the snapshot
   * callback. Nothing is cleared synchronously when `uid` changes — "is this
   * still the current user's usage?" is answered by comparing the tag, so one
   * account's counters can never be rendered under another's name.
   */
  const [state, setState] = React.useState<{
    uid: string | null;
    usage: MonthlyUsage | null;
  }>({ uid: null, usage: null });

  React.useEffect(() => {
    if (!uid) return;
    const { db } = getFirebase();
    const ref = doc(db, "users", uid, "usage", currentMonthKey());
    return onSnapshot(
      ref,
      (snap) => {
        setState({ uid, usage: snap.exists() ? (snap.data() as MonthlyUsage) : null });
      },
      // A read failure resolves the loading state without discarding a value
      // that already arrived for this account.
      () => setState((prev) => ({ uid, usage: prev.uid === uid ? prev.usage : null }))
    );
  }, [uid]);

  const current = uid !== null && state.uid === uid;
  return { usage: current ? state.usage : null, loading: !!uid && !current };
}
