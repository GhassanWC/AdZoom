import "server-only";

import { getAdmin } from "@/lib/firebase/admin";
import {
  normalizePlan,
  planMeetsMinimum,
  type PlanTier,
} from "./plan";
import { getMonthlyUsage } from "./usage";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";

/**
 * Plan-based gating helpers.
 *
 * Source of truth: `users/{uid}.plan` (mirrored from the LS webhook). All
 * helpers are server-only — they call `getAdmin()`. The client mirrors the
 * same tier via the existing `useStoragePlan()` hook for UI display, but
 * the authoritative checks happen here.
 *
 * Monthly export limits live in `EXPORT_LIMITS`. The Free cap (5/mo) is the
 * "$0 trial" funnel; both paid tiers are uncapped — the marketing copy
 * promises "Unlimited exports" starting at the $19 Pro tier.
 * Adjust by editing the constant.
 */

/** Monthly export caps per plan tier. Both paid tiers are uncapped. */
export const EXPORT_LIMITS: Record<PlanTier, number> = {
  free: 5,
  creator: Number.POSITIVE_INFINITY,
  pro: Number.POSITIVE_INFINITY,
};

export async function getUserPlan(uid: string): Promise<PlanTier> {
  if (!uid) return "free";
  const { db } = getAdmin();
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return "free";
  const raw = (snap.data() as { plan?: unknown } | undefined)?.plan;
  return normalizePlan(raw);
}

/** Thrown when a gated operation is invoked without the required plan. */
export class PlanRequiredError extends Error {
  constructor(
    public readonly required: PlanTier,
    public readonly actual: PlanTier
  ) {
    super(`Plan required: ${required} (current: ${actual})`);
    this.name = "PlanRequiredError";
  }
}

/** Thrown when the user has hit their monthly export cap. */
export class ExportLimitError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly plan: PlanTier
  ) {
    super(`Export limit reached: ${used}/${limit} on ${plan}`);
    this.name = "ExportLimitError";
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
 * Whether the user is allowed to start an export RIGHT NOW. Considers both
 * the plan tier and the current month's count. Returns false when the user
 * is at or above their monthly cap; the caller (export-permit endpoint)
 * should respond with a 429.
 */
export async function canExport(uid: string): Promise<boolean> {
  const plan = await getUserPlan(uid);
  const usage = await getMonthlyUsage(uid);
  return usage.exportCount < EXPORT_LIMITS[plan];
}

/**
 * How many exports the user has left this month, plus context.
 * `limit === Infinity` for Pro — UI should render "Unlimited" for that case.
 */
export async function getRemainingExports(uid: string): Promise<{
  used: number;
  limit: number;
  remaining: number;
  plan: PlanTier;
}> {
  const plan = await getUserPlan(uid);
  const usage = await getMonthlyUsage(uid);
  const limit = EXPORT_LIMITS[plan];
  const remaining = Number.isFinite(limit)
    ? Math.max(0, limit - usage.exportCount)
    : Number.POSITIVE_INFINITY;
  return { used: usage.exportCount, limit, remaining, plan };
}

/**
 * Whether the user can export at the requested resolution. 1080p is
 * available on any plan; 4K requires a paid plan (Pro $19 and above).
 */
export async function canExportResolution(
  uid: string,
  res: "1080p" | "4K"
): Promise<boolean> {
  if (res === "1080p") return true;
  return planMeetsMinimum(await getUserPlan(uid), "pro");
}

/**
 * Whether the user can export at the requested frame rate. 30fps is available
 * on any plan; 60fps requires a paid plan (Pro $19 and above) — matching the
 * 4K gate above.
 */
export async function canExportFps(
  uid: string,
  fps: 30 | 60
): Promise<boolean> {
  if (fps === 30) return true;
  return planMeetsMinimum(await getUserPlan(uid), "pro");
}

/**
 * Whether the user can apply the named preset.
 *
 * Looks up the preset in `BUILTIN_PRESETS_BY_ID`; if found and it carries
 * a `requiredPlan`, the user's plan must meet that minimum. Custom presets
 * (user-authored) are NOT looked up here — they're always allowed for
 * their owner, since the owner already authored them under whatever plan
 * they were on at the time.
 */
export async function canUsePreset(
  uid: string,
  presetId: string
): Promise<boolean> {
  const preset = BUILTIN_PRESETS_BY_ID[presetId];
  if (!preset) return true; // unknown id — let the caller decide; not gated here
  if (!preset.requiredPlan) return true;
  return planMeetsMinimum(await getUserPlan(uid), preset.requiredPlan);
}
