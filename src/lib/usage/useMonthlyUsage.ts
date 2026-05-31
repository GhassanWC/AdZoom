"use client";

import * as React from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useStoragePlan } from "./useStoragePlan";
import type { MonthlyUsage } from "@/lib/firebase/schema";
import type { PlanTier } from "./plan";

// EXPORT_LIMITS lives in the server-only gating.ts; we duplicate it here as
// a small client-side mirror. Keep these in sync if you change the caps.
const CLIENT_EXPORT_LIMITS: Record<PlanTier, number> = {
  free: 5,
  creator: 300,
  pro: Number.POSITIVE_INFINITY,
};

export interface MonthlyUsageState {
  /** Exports used this month. 0 until the listener resolves. */
  used: number;
  /** Plan cap; Infinity for Pro. */
  limit: number;
  /** Remaining = max(0, limit - used). Infinity for Pro. */
  remaining: number;
  /** Current plan tier (mirror of useStoragePlan). */
  plan: PlanTier;
  loading: boolean;
}

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Live monthly usage counter. Subscribes to
 * `users/{uid}/usage/{YYYY-MM}` so the export panel can render
 * "3 of 5 exports this month" without a manual refresh after each export.
 *
 * Rules let owners read this; writes happen server-side via the
 * export-permit endpoint.
 */
export function useMonthlyUsage(): MonthlyUsageState {
  const { user } = useAuth();
  const { plan } = useStoragePlan();
  const uid = user?.uid ?? null;

  const [used, setUsed] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!uid) {
      setUsed(0);
      setLoaded(false);
      return;
    }
    const { db } = getFirebase();
    const ref = doc(db, "users", uid, "usage", currentMonthKey());
    return onSnapshot(
      ref,
      (snap) => {
        const data = snap.exists() ? (snap.data() as MonthlyUsage) : null;
        setUsed(data?.exportCount ?? 0);
        setLoaded(true);
      },
      () => setLoaded(true)
    );
  }, [uid]);

  const limit = CLIENT_EXPORT_LIMITS[plan.tier];
  const remaining = Number.isFinite(limit) ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;

  return {
    used,
    limit,
    remaining,
    plan: plan.tier,
    loading: !!uid && !loaded,
  };
}
