"use client";

import * as React from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeSubscription } from "@/lib/firebase/subscriptions";
import { usePlanTier } from "./useStoragePlan";
import type { PlanTier } from "./plan";
import {
  type CaptionUsageDoc,
  CAPTION_PLAN_LIMITS,
  captionAllowanceSeconds,
  captionRemainingSeconds,
  resolveCaptionPeriod,
} from "./caption-quota";

export interface CaptionUsageState {
  plan: PlanTier;
  /** Allowance for the current billing period, in seconds. */
  allowanceSeconds: number;
  /** Finalized + in-flight usage, in seconds. */
  usedSeconds: number;
  reservedSeconds: number;
  /** max(0, allowance − used − reserved). */
  remainingSeconds: number;
  /** Whole minutes for display ("42 of 150 caption minutes used"). */
  allowanceMinutes: number;
  usedMinutes: number;
  remainingMinutes: number;
  /** Plan's per-video source cap, in seconds. */
  maxVideoSeconds: number;
  /**
   * End of the CURRENT allowance window, epoch ms — i.e. when these minutes
   * refill. Paid plans anchor to the subscription renewal, Free to the UTC
   * calendar month, so the billing page has to read it from here rather than
   * assume "the 1st".
   */
  periodEndMs: number;
  loading: boolean;
}

/**
 * Live auto-caption minutes for the current user — DISPLAY ONLY (the server
 * re-reads plan + ledger inside its reserve transaction and never trusts the
 * client). Subscribes to `users/{uid}/captionUsage/{periodId}` where the
 * period is resolved with the same shared pure helper the server uses (paid
 * plans anchor to the subscription's `renewsAt`; Free uses the UTC calendar
 * month), so client and server read the same doc.
 */
export function useCaptionUsage(): CaptionUsageState {
  const { user } = useAuth();
  const { tier } = usePlanTier();
  const uid = user?.uid ?? null;

  // Subscription anchor (renewsAt) — null until loaded / for Free users.
  const [renewsAt, setRenewsAt] = React.useState<number | null>(null);
  const [subLoaded, setSubLoaded] = React.useState(false);
  React.useEffect(() => {
    if (!uid) {
      setRenewsAt(null);
      setSubLoaded(false);
      return;
    }
    return subscribeSubscription(uid, (sub) => {
      const v = sub?.renewsAt;
      setRenewsAt(typeof v === "number" && Number.isFinite(v) ? v : null);
      setSubLoaded(true);
    });
  }, [uid]);

  const period = React.useMemo(
    () => resolveCaptionPeriod({ plan: tier, renewsAtMs: renewsAt, nowMs: Date.now() }),
    [tier, renewsAt]
  );

  const [usage, setUsage] = React.useState<CaptionUsageDoc | null>(null);
  const [usageLoaded, setUsageLoaded] = React.useState(false);
  React.useEffect(() => {
    if (!uid) {
      setUsage(null);
      setUsageLoaded(false);
      return;
    }
    setUsageLoaded(false);
    const { db } = getFirebase();
    const ref = doc(db, "users", uid, "captionUsage", period.periodId);
    return onSnapshot(
      ref,
      (snap) => {
        setUsage(snap.exists() ? (snap.data() as CaptionUsageDoc) : null);
        setUsageLoaded(true);
      },
      () => setUsageLoaded(true)
    );
  }, [uid, period.periodId]);

  // Missing doc = an untouched period (old accounts initialize safely at zero).
  // The live plan's allowance wins when higher (mid-cycle upgrade shows
  // immediately), mirroring the server's applyPlanChange.
  const allowanceSeconds = Math.max(usage?.allowanceSeconds ?? 0, captionAllowanceSeconds(tier));
  const usedSeconds = Math.max(0, usage?.usedSeconds ?? 0);
  const reservedSeconds = Math.max(0, usage?.reservedSeconds ?? 0);
  const remainingSeconds = captionRemainingSeconds({ allowanceSeconds, usedSeconds, reservedSeconds });

  return {
    plan: tier,
    allowanceSeconds,
    usedSeconds,
    reservedSeconds,
    remainingSeconds,
    allowanceMinutes: Math.round(allowanceSeconds / 60),
    usedMinutes: Math.round((usedSeconds + reservedSeconds) / 60),
    remainingMinutes: Math.floor(remainingSeconds / 60),
    maxVideoSeconds: CAPTION_PLAN_LIMITS[tier].maxCaptionVideoSeconds,
    periodEndMs: period.endMs,
    loading: !!uid && (!subLoaded || !usageLoaded),
  };
}
