import "server-only";

import { getAdmin } from "@/lib/firebase/admin";
import {
  normalizePlan,
  planMeetsMinimum,
  type PlanTier,
} from "./plan";

/**
 * Plan-based gating helpers.
 *
 * Source of truth: `users/{uid}.plan` (mirrored from the LS webhook). All
 * helpers are server-only — they call `getAdmin()`. The client should
 * either read its tier via the existing `useStoragePlan()` hook (which
 * listens on the same field) or POST to a route that uses these helpers.
 *
 * Today this PR ships ONE real gate — `canExportResolution()` for 4K.
 * The other helpers exist as no-op or stub surfaces so the call sites can
 * be wired now and the policy tightened later (per the plan's deferred
 * follow-ups: monthly export count, premium presets, AI gap-fill).
 */

export async function getUserPlan(uid: string): Promise<PlanTier> {
  if (!uid) return "free";
  const { db } = getAdmin();
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return "free";
  const raw = (snap.data() as { plan?: unknown } | undefined)?.plan;
  return normalizePlan(raw);
}

/**
 * Thrown when a gated operation is invoked without the required plan.
 * Routes catch this and return a 402 / 403 with the missing-plan hint;
 * the client surface (e.g. RealExportPanel) catches it and shows an
 * inline upgrade CTA.
 */
export class PlanRequiredError extends Error {
  constructor(
    public readonly required: PlanTier,
    public readonly actual: PlanTier
  ) {
    super(`Plan required: ${required} (current: ${actual})`);
    this.name = "PlanRequiredError";
  }
}

export async function requirePlan(
  uid: string,
  minimum: PlanTier
): Promise<PlanTier> {
  const actual = await getUserPlan(uid);
  if (!planMeetsMinimum(actual, minimum)) {
    throw new PlanRequiredError(minimum, actual);
  }
  return actual;
}

/**
 * Whether the user is allowed to start an export. Free is allowed today —
 * the 5/month cap is a deferred follow-up. The function still touches the
 * user doc so the surface is identical when the cap lands and the call
 * sites don't need to change.
 */
export async function canExport(uid: string): Promise<boolean> {
  await getUserPlan(uid);
  return true;
}

/**
 * Whether the user can export at the requested resolution.
 *
 *   • 1080p — any plan.
 *   • 4K    — requires Pro.
 *
 * This is the single real plan-gate shipping in this PR.
 */
export async function canExportResolution(
  uid: string,
  res: "1080p" | "4K"
): Promise<boolean> {
  if (res === "1080p") return true;
  return planMeetsMinimum(await getUserPlan(uid), "pro");
}

/**
 * Whether the user can apply a given preset. Today: always true.
 *
 * When premium presets land, this becomes:
 *   const preset = lookupPreset(presetId);
 *   if (!preset.requiredPlan) return true;
 *   return planMeetsMinimum(await getUserPlan(uid), preset.requiredPlan);
 */
export async function canUsePreset(
  uid: string,
  _presetId: string
): Promise<boolean> {
  await getUserPlan(uid);
  return true;
}
