/**
 * Export plan policy — the SINGLE source of truth for per-plan export limits,
 * quality caps, queue priority, and the global concurrency limit.
 *
 * PURE module (no `server-only`, no `getAdmin`) so the server enforcement
 * (create-job, cron promotion) AND the client UI (resolution picker, monthly
 * meter) read the exact same rules. The server is always authoritative — the UI
 * only mirrors these for display; nothing here trusts client input.
 *
 * Policy (production-safe defaults):
 *   Free    — 720p / 30fps, 2 cloud exports/month, 1 active, lowest priority.
 *   Pro     — 1080p, minutes quota, 1 active, normal priority.
 *   Creator — 1080p, minutes quota, 2 active, top priority.
 *   4K is disabled for EVERY plan for now (until 1080p is proven stable).
 *   Global — at most GLOBAL_ACTIVE_EXPORT_LIMIT (default 5) active across all
 *            users; excess requests queue (Creator → Pro → Free, FIFO).
 */
import type { PlanTier } from "@/lib/usage/plan";

export type ExportResolution = "720p" | "1080p" | "4K";

/** 4K is disabled platform-wide for now. Flip to true once 1080p is stable. */
export const FOUR_K_ENABLED = false;

/** Highest resolution each plan may export (never 4K while disabled above). */
export const MAX_EXPORT_RESOLUTION: Record<PlanTier, Exclude<ExportResolution, "4K">> = {
  free: "720p",
  pro: "1080p",
  creator: "1080p",
};

/** Highest fps each plan may export. Free is capped at 30. */
export const MAX_EXPORT_FPS: Record<PlanTier, 30 | 60> = {
  free: 30,
  pro: 60,
  creator: 60,
};

/** Free monthly CLOUD export allowance (count-based; paid plans meter minutes). */
export const FREE_MONTHLY_CLOUD_EXPORTS = 2;

/** Max concurrent active cloud exports per user. */
export const MAX_ACTIVE_EXPORTS_PER_PLAN: Record<PlanTier, number> = {
  free: 1,
  pro: 1,
  creator: 2,
};

/** Queue priority — HIGHER is served first: Creator → Pro → Free. */
export const EXPORT_PRIORITY_RANK: Record<PlanTier, number> = {
  free: 1,
  pro: 2,
  creator: 3,
};

/** Default global active-export cap when GLOBAL_ACTIVE_EXPORT_LIMIT is unset. */
export const DEFAULT_GLOBAL_ACTIVE_EXPORT_LIMIT = 5;

/** Global cap on concurrently-active cloud exports across the whole platform. */
export function globalActiveExportLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.GLOBAL_ACTIVE_EXPORT_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GLOBAL_ACTIVE_EXPORT_LIMIT;
}

const RES_RANK: Record<ExportResolution, number> = { "720p": 1, "1080p": 2, "4K": 3 };

/** True when the plan may select the resolution (never 4K while disabled). */
export function canSelectResolution(plan: PlanTier, res: ExportResolution): boolean {
  if (res === "4K" && !FOUR_K_ENABLED) return false;
  return RES_RANK[res] <= RES_RANK[MAX_EXPORT_RESOLUTION[plan]];
}

/** The resolutions a plan may pick (UI mirrors this; 4K omitted while disabled). */
export function availableResolutionsForPlan(plan: PlanTier): Exclude<ExportResolution, "4K">[] {
  const all: Exclude<ExportResolution, "4K">[] = ["720p", "1080p"];
  return all.filter((r) => RES_RANK[r] <= RES_RANK[MAX_EXPORT_RESOLUTION[plan]]);
}

/**
 * SERVER-SIDE resolution normalization — NEVER trusts the client. 4K (while
 * disabled) and anything above the plan cap is clamped down to the plan's max.
 */
export function normalizeResolution(
  plan: PlanTier,
  requested: ExportResolution | string | undefined
): Exclude<ExportResolution, "4K"> {
  const cap = MAX_EXPORT_RESOLUTION[plan];
  const req: ExportResolution =
    requested === "720p" || requested === "1080p" || requested === "4K" ? requested : "1080p";
  if (req === "4K" && !FOUR_K_ENABLED) return cap;
  return RES_RANK[req] > RES_RANK[cap] ? cap : (req as Exclude<ExportResolution, "4K">);
}

/** SERVER-SIDE fps normalization — clamp to the plan's max (Free → 30). */
export function normalizeFps(plan: PlanTier, requested: 30 | 60 | undefined): 30 | 60 {
  const cap = MAX_EXPORT_FPS[plan];
  const req: 30 | 60 = requested === 60 ? 60 : 30;
  return req > cap ? cap : req;
}

/** Existing string priority (drives Cloud Tasks queue selection). */
export function priorityLabelForPlan(plan: PlanTier): "normal" | "priority" {
  return plan === "creator" ? "priority" : "normal";
}

/** Compact preset label for the job doc / UI ("720p · 30fps"). */
export function presetLabel(resolution: string, fps: number): string {
  return `${resolution} · ${fps}fps`;
}

/** Thrown when a user hits their monthly CLOUD export count (Free = 2). */
export class MonthlyExportLimitError extends Error {
  readonly plan: PlanTier;
  readonly used: number;
  readonly limit: number;
  constructor(plan: PlanTier, used: number, limit: number) {
    super(`Monthly cloud export limit reached: ${used}/${limit} on ${plan}.`);
    this.name = "MonthlyExportLimitError";
    this.plan = plan;
    this.used = used;
    this.limit = limit;
  }
}

/** Thrown when the user already has the max concurrent active exports for their plan. */
export class ActiveExportLimitError extends Error {
  readonly plan: PlanTier;
  readonly active: number;
  readonly limit: number;
  constructor(plan: PlanTier, active: number, limit: number) {
    super(`Active export limit reached: ${active}/${limit} on ${plan}.`);
    this.name = "ActiveExportLimitError";
    this.plan = plan;
    this.active = active;
    this.limit = limit;
  }
}
