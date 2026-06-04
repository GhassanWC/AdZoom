/**
 * Plan tiers, storage limits, and tier helpers.
 *
 * Tier hierarchy (free < creator < pro) — note the DISPLAY names are swapped
 * relative to the internal keys (the keys are load-bearing for gating and the
 * LS variant binding, so they don't change):
 *   • Free                       — onboarding / try-the-product. 5 GB storage.
 *   • `creator` key, shown "Pro" — main paid plan (~$19/mo). 50 GB storage.
 *                                  Unlimited exports, no watermark, 4K + 60fps,
 *                                  advanced AI editing, priority rendering, all
 *                                  premium presets.
 *   • `pro` key, shown "Creator" — team / agency plan (~$49/mo). 500 GB storage.
 *                                  Everything in "Pro" plus brand-kit presets,
 *                                  team seats, and API access (the "Everything
 *                                  in Pro" marketing tier).
 *
 * A user's tier is read from `users/{uid}.plan`; absent = "free". The plan
 * field is mirrored from `subscriptions/{uid}.plan` by the Lemon Squeezy
 * webhook so the client can stay on a single Firestore listener.
 */

export type PlanTier = "free" | "creator" | "pro";

export interface PlanDef {
  tier: PlanTier;
  name: string;
  /** Bytes of storage included in the tier. */
  storageBytes: number;
  /** CTA label shown in the sidebar widget. */
  ctaLabel: string;
}

const GB = 1024 * 1024 * 1024;

export const PLAN_DEFS: Record<PlanTier, PlanDef> = {
  free: {
    tier: "free",
    name: "Free plan",
    storageBytes: 5 * GB,
    ctaLabel: "Upgrade",
  },
  creator: {
    tier: "creator",
    // Display name intentionally "Pro" — see header note on the swap.
    name: "Pro plan",
    storageBytes: 50 * GB,
    ctaLabel: "Manage",
  },
  pro: {
    tier: "pro",
    // Display name intentionally "Creator" — see header note on the swap.
    name: "Creator plan",
    storageBytes: 500 * GB,
    ctaLabel: "Manage",
  },
};

/** Coerce arbitrary input from Firestore into a known tier (default free). */
export function normalizePlan(raw: unknown): PlanTier {
  if (raw === "pro" || raw === "creator") return raw;
  return "free";
}

/**
 * Ordinal rank of a tier — `free=0 < creator=1 < pro=2`. Used by the
 * gating helpers (`requirePlan`, `canExportResolution`, etc.) so the
 * comparison is a single integer compare.
 */
export function planRank(p: PlanTier): number {
  return p === "pro" ? 2 : p === "creator" ? 1 : 0;
}

/** True when `actual` ≥ `minimum` in the tier ordering. */
export function planMeetsMinimum(actual: PlanTier, minimum: PlanTier): boolean {
  return planRank(actual) >= planRank(minimum);
}

/** Human-readable byte formatter — picks GB / MB / KB automatically. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 GB";
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  const MB = 1024 * 1024;
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;
  const KB = 1024;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

/** Color band for the storage bar — calm at first, hot near the cap. */
export function storageBand(used: number, limit: number): "ok" | "warn" | "danger" {
  if (limit <= 0) return "ok";
  const pct = used / limit;
  if (pct >= 0.95) return "danger";
  if (pct >= 0.8) return "warn";
  return "ok";
}
