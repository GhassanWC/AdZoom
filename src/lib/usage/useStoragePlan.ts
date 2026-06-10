"use client";

import * as React from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import {
  PLAN_DEFS,
  normalizePlan,
  type PlanDef,
  type PlanTier,
} from "./plan";

export interface StoragePlanState {
  /** Resolved plan definition (defaults to Free until the user doc loads). */
  plan: PlanDef;
  /** Bytes used across the user's projects. */
  usedBytes: number;
  /** Bytes available on the current plan. */
  limitBytes: number;
  /** 0..1 — used / limit, clamped. */
  fraction: number;
  /** Number of projects counted toward the storage tally. */
  projectCount: number;
  /** True while still loading either the user doc or the project list. */
  loading: boolean;
}

/**
 * Just the plan tier — a lightweight `users/{uid}` listener with NO project
 * subscription. Used by upload / recording / analyze gating where we only need
 * the tier, not storage usage, so those flows don't drag in a full project
 * scan. `loading` is true only while signed in and the first snapshot is
 * pending; callers should avoid blocking the user until it resolves.
 */
export function usePlanTier(): { tier: PlanTier; loading: boolean } {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [tier, setTier] = React.useState<PlanTier>("free");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!uid) {
      setTier("free");
      setLoaded(false);
      return;
    }
    setLoaded(false);
    const { db } = getFirebase();
    const ref = doc(db, "users", uid);
    return onSnapshot(
      ref,
      (snap) => {
        setTier(normalizePlan(snap.data()?.plan));
        setLoaded(true);
      },
      () => setLoaded(true)
    );
  }, [uid]);

  return { tier, loading: !!uid && !loaded };
}

/**
 * Live storage + plan stats for the sidebar widget.
 *
 * Two subscriptions:
 *   - `users/{uid}` for the plan tier
 *   - `users/{uid}/projects` for the file-size sum
 *
 * Both update in real time. If the user isn't signed in yet we just hand back
 * a Free-tier shape with zero usage so the widget can still render.
 */
export function useStoragePlan(): StoragePlanState {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [planTier, setPlanTier] = React.useState<PlanTier>("free");
  const [usedBytes, setUsedBytes] = React.useState(0);
  const [projectCount, setProjectCount] = React.useState(0);
  const [userLoaded, setUserLoaded] = React.useState(false);
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);

  // Plan tier — read from the user doc, default to free if absent.
  React.useEffect(() => {
    if (!uid) {
      setPlanTier("free");
      setUserLoaded(false);
      return;
    }
    const { db } = getFirebase();
    const ref = doc(db, "users", uid);
    return onSnapshot(
      ref,
      (snap) => {
        setPlanTier(normalizePlan(snap.data()?.plan));
        setUserLoaded(true);
      },
      () => setUserLoaded(true)
    );
  }, [uid]);

  // Storage usage — sum of every project's `fileSize`.
  React.useEffect(() => {
    if (!uid) {
      setUsedBytes(0);
      setProjectCount(0);
      setProjectsLoaded(false);
      return;
    }
    return subscribeProjects(uid, (projects) => {
      const total = projects.reduce(
        (sum, p) => sum + (typeof p.fileSize === "number" ? p.fileSize : 0),
        0
      );
      setUsedBytes(total);
      setProjectCount(projects.length);
      setProjectsLoaded(true);
    });
  }, [uid]);

  const plan = PLAN_DEFS[planTier];
  const limitBytes = plan.storageBytes;
  const fraction = limitBytes > 0 ? Math.min(1, usedBytes / limitBytes) : 0;

  return {
    plan,
    usedBytes,
    limitBytes,
    fraction,
    projectCount,
    loading: !!uid && (!userLoaded || !projectsLoaded),
  };
}
