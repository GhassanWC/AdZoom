"use client";

import { useStoragePlan } from "./useStoragePlan";
import { useMonthlyUsage } from "./useMonthlyUsage";
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

/**
 * Live cloud-export minutes for the current user — the meter the export panel
 * shows ("X / 150 minutes left"). Reads `users/{uid}/usage/{YYYY-MM}` (the same
 * doc the browser export count lives on) via `useMonthlyUsage` and derives
 * remaining minutes from the shared `cloud-minutes` helpers, so the client and
 * server agree.
 */
export function useCloudMinutes(): CloudMinutesState {
  const { plan } = useStoragePlan();
  const { usage, loading } = useMonthlyUsage();

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
    loading,
    monthlyExportsUsed,
    monthlyExportLimit,
    monthlyExportsRemaining,
    freeLimitReached: isFree && monthlyExportsUsed >= FREE_MONTHLY_CLOUD_EXPORTS,
  };
}
