/**
 * Cloud-export minutes — the metered quota for server-side MP4 export.
 *
 * This module is PURE (no `getAdmin`, no `server-only`) so it can be imported
 * by the client UI (minutes meter), the server API (`/api/export/cloud`
 * gating), AND the Cloud Run worker (settling minutes on completion) — one
 * source of truth for the constants + estimate + remaining math.
 *
 * Quota model (per the product spec):
 *   • Free    — 0 cloud minutes. Cloud export is blocked; browser export only.
 *   • Pro     — 150 minutes / month, max video length 30 minutes.
 *   • Creator — 250 minutes / month, max video length 60 minutes.
 *
 * Minutes are billed on OUTPUT duration (post cuts/speed) — the deliverable —
 * not source length, and not scaled by resolution (keeps the meter intuitive).
 *
 * Accounting is double-entry on `users/{uid}/usage/{YYYY-MM}`:
 *   - `cloudMinutesReserved`  — held by in-flight jobs (reserved at enqueue).
 *   - `cloudMinutesConsumed`  — settled by successful jobs.
 *   - remaining = limit − reserved − consumed.
 * A job RESERVES its estimate when the API creates it (atomic with the job
 * write, so two concurrent requests can't both pass the check), then on a
 * terminal state the worker either SETTLES the reservation into `consumed`
 * (success) or RELEASES it (failure/cancel). This survives crashes — a stuck
 * reservation can be reconciled by a sweeper against live non-terminal jobs.
 */
import type { PlanTier } from "./plan";
import type { MonthlyUsage } from "@/lib/firebase/schema";

/** Included cloud-export minutes per plan tier, per calendar month (UTC). */
export const CLOUD_EXPORT_MINUTES: Record<PlanTier, number> = {
  free: 0,
  pro: 150,
  creator: 250,
};

/**
 * Max OUTPUT video length (seconds) a single cloud export may produce, per plan.
 * Free has no cloud export; Pro caps at 30 min, Creator at 60 min. This bounds
 * the worst-case render time (and Batch run duration) per job — separate from the
 * monthly minutes quota. `0` ⇒ no cloud export allowed.
 */
export const CLOUD_EXPORT_MAX_DURATION_SECONDS: Record<PlanTier, number> = {
  free: 0,
  pro: 30 * 60,
  creator: 60 * 60,
};

/** True when the plan includes ANY cloud-export minutes (i.e. is paid). */
export function planAllowsCloudExport(plan: PlanTier): boolean {
  return CLOUD_EXPORT_MINUTES[plan] > 0;
}

/**
 * True when a cloud export of `outputDurationSeconds` exceeds the plan's max
 * length. Paid plans only (Free is gated by `planAllowsCloudExport`); an unknown
 * duration is never blocked here.
 */
export function exceedsCloudExportDuration(
  plan: PlanTier,
  outputDurationSeconds: number | null | undefined
): boolean {
  const limit = CLOUD_EXPORT_MAX_DURATION_SECONDS[plan];
  if (!(limit > 0)) return false;
  return (
    typeof outputDurationSeconds === "number" &&
    Number.isFinite(outputDurationSeconds) &&
    outputDurationSeconds > limit
  );
}

/**
 * Estimate billable minutes for an export of the given OUTPUT duration. Whole
 * minutes, rounded UP, floor of 1 — a 10-second clip still costs a minute, a
 * 3m01s clip costs 4. Used both to gate before enqueue and to record the
 * job's `estimatedExportMinutes`.
 */
export function estimateExportMinutes(outputDurationSeconds: number): number {
  if (!Number.isFinite(outputDurationSeconds) || outputDurationSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(outputDurationSeconds / 60));
}

type CloudUsageFields = Pick<
  MonthlyUsage,
  "cloudMinutesReserved" | "cloudMinutesConsumed"
>;

/** Minutes already committed this month — reserved (in-flight) + consumed. */
export function cloudMinutesUsed(usage: CloudUsageFields | null | undefined): number {
  const reserved = Math.max(0, usage?.cloudMinutesReserved ?? 0);
  const consumed = Math.max(0, usage?.cloudMinutesConsumed ?? 0);
  return reserved + consumed;
}

/** Minutes still available this month for `plan` given current usage. */
export function cloudMinutesRemaining(
  plan: PlanTier,
  usage: CloudUsageFields | null | undefined
): number {
  return Math.max(0, CLOUD_EXPORT_MINUTES[plan] - cloudMinutesUsed(usage));
}

/**
 * Pure gate: can a job of `estimate` minutes start RIGHT NOW for `plan` given
 * `usage`? False when the plan has no cloud minutes OR the reservation would
 * exceed the remaining balance. The server runs this inside the reserve
 * transaction (re-reading usage) so concurrent requests can't both squeeze in.
 */
export function canCloudExport(
  plan: PlanTier,
  usage: CloudUsageFields | null | undefined,
  estimate: number
): boolean {
  if (!planAllowsCloudExport(plan)) return false;
  return cloudMinutesRemaining(plan, usage) >= estimate;
}

/** Thrown when a Free (or otherwise non-paid) user attempts a cloud export. */
export class CloudExportNotAllowedError extends Error {
  readonly plan: PlanTier;
  constructor(plan: PlanTier) {
    super(`Cloud export requires a paid plan (current: ${plan}).`);
    this.name = "CloudExportNotAllowedError";
    this.plan = plan;
  }
}

/** Thrown when a cloud export's output length exceeds the plan's max video length. */
export class CloudExportDurationError extends Error {
  readonly plan: PlanTier;
  readonly maxSeconds: number;
  readonly actualSeconds: number;
  constructor(plan: PlanTier, maxSeconds: number, actualSeconds: number) {
    super(
      `Cloud export length ${Math.round(actualSeconds)}s exceeds the ${plan} limit of ${maxSeconds}s.`
    );
    this.name = "CloudExportDurationError";
    this.plan = plan;
    this.maxSeconds = maxSeconds;
    this.actualSeconds = actualSeconds;
  }
}

/** Thrown when the user lacks enough remaining cloud minutes for the job. */
export class CloudMinutesError extends Error {
  readonly remaining: number;
  readonly requested: number;
  readonly plan: PlanTier;
  constructor(remaining: number, requested: number, plan: PlanTier) {
    super(
      `Not enough cloud export minutes: need ${requested}, have ${remaining} on ${plan}.`
    );
    this.name = "CloudMinutesError";
    this.remaining = remaining;
    this.requested = requested;
    this.plan = plan;
  }
}
