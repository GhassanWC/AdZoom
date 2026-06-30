"use client";

import * as React from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useStoragePlan } from "./useStoragePlan";
import type { MonthlyUsage } from "@/lib/firebase/schema";
import type { PlanTier } from "./plan";
import {
  CLOUD_EXPORT_MINUTES,
  cloudMinutesRemaining,
  cloudMinutesUsed,
  planAllowsCloudExport,
} from "./cloud-minutes";
import { FREE_MONTHLY_CLOUD_EXPORTS } from "@/lib/export/plan-policy";

export interface CloudMinutesState {
  /** Included minutes for the plan (0 for Free). */
  limit: number;
  /** Minutes committed this month (reserved in-flight + consumed). */
  used: number;
  /** Minutes still available this month. */
  remaining: number;
  /** Whether the plan includes cloud export at all (i.e. is paid). */
  allowed: boolean;
  plan: PlanTier;
  loading: boolean;
  // ── Free monthly cloud-export COUNT (Free is count-gated, not minutes) ──
  /** Cloud exports started this month (from the usage doc; live). */
  monthlyExportsUsed: number;
  /** Free monthly cloud-export allowance (Infinity for paid plans). */
  monthlyExportLimit: number;
  /** Free exports remaining this month (Infinity for paid plans). */
  monthlyExportsRemaining: number;
  /** True when a Free user has used all their monthly cloud exports. */
  freeLimitReached: boolean;
}

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Live cloud-export minutes for the current user — the meter the export panel
 * shows ("X / 150 minutes left"). Subscribes to `users/{uid}/usage/{YYYY-MM}`
 * (the same doc the browser export count lives on) and derives remaining minutes
 * from the shared `cloud-minutes` helpers, so the client and server agree.
 */
export function useCloudMinutes(): CloudMinutesState {
  const { user } = useAuth();
  const { plan } = useStoragePlan();
  const uid = user?.uid ?? null;

  const [usage, setUsage] = React.useState<MonthlyUsage | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!uid) {
      setUsage(null);
      setLoaded(false);
      return;
    }
    const { db } = getFirebase();
    const ref = doc(db, "users", uid, "usage", currentMonthKey());
    return onSnapshot(
      ref,
      (snap) => {
        setUsage(snap.exists() ? (snap.data() as MonthlyUsage) : null);
        setLoaded(true);
      },
      () => setLoaded(true)
    );
  }, [uid]);

  const tier = plan.tier;
  const monthlyExportsUsed = Math.max(0, usage?.exportsUsedThisMonth ?? 0);
  const isFree = tier === "free";
  const monthlyExportLimit = isFree ? FREE_MONTHLY_CLOUD_EXPORTS : Number.POSITIVE_INFINITY;
  const monthlyExportsRemaining = Math.max(0, monthlyExportLimit - monthlyExportsUsed);
  return {
    limit: CLOUD_EXPORT_MINUTES[tier],
    used: cloudMinutesUsed(usage),
    remaining: cloudMinutesRemaining(tier, usage),
    allowed: planAllowsCloudExport(tier),
    plan: tier,
    loading: !!uid && !loaded,
    monthlyExportsUsed,
    monthlyExportLimit,
    monthlyExportsRemaining,
    freeLimitReached: isFree && monthlyExportsUsed >= FREE_MONTHLY_CLOUD_EXPORTS,
  };
}
