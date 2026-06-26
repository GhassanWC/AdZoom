/**
 * Plan tiers, storage limits, and tier helpers.
 *
 * Tier hierarchy (free < pro < creator). Display names match the internal
 * keys 1:1, and each key binds to the like-named LS variant
 * (`pro` → PRO_VARIANT_ID, `creator` → CREATOR_VARIANT_ID):
 *   • Free   — onboarding / try-the-product. 5 GB storage.
 *   • Pro    — main paid plan (~$25/mo), "most popular". 50 GB storage.
 *              Unlimited exports, no watermark, 4K + 60fps, advanced AI
 *              editing, priority rendering, all premium presets.
 *   • Creator — team / agency plan (~$49/mo). 500 GB storage. "Everything in
 *              Pro" plus brand-kit presets, team seats, and API access.
 *
 * Note the ordering: Creator is the TOP tier (it's the $49 superset), so
 * `planRank` puts creator above pro. A user's tier is read from
 * `users/{uid}.plan`; absent = "free". The plan field is mirrored from
 * `subscriptions/{uid}.plan` by the Lemon Squeezy webhook so the client can
 * stay on a single Firestore listener.
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
  // Pro is the mid paid tier ($25); Creator is the top team tier ($49).
  pro: {
    tier: "pro",
    name: "Pro plan",
    storageBytes: 50 * GB,
    ctaLabel: "Manage",
  },
  creator: {
    tier: "creator",
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
 * Ordinal rank of a tier — `free=0 < pro=1 < creator=2`. Used by the
 * gating helpers (`requirePlan`, `canExportResolution`, etc.) so the
 * comparison is a single integer compare. Creator outranks Pro because it's
 * the $49 "Everything in Pro" superset tier.
 */
export function planRank(p: PlanTier): number {
  return p === "creator" ? 2 : p === "pro" ? 1 : 0;
}

/** True when `actual` ≥ `minimum` in the tier ordering. */
export function planMeetsMinimum(actual: PlanTier, minimum: PlanTier): boolean {
  return planRank(actual) >= planRank(minimum);
}

// ── Upload duration limits ─────────────────────────────────────────────────
// Free is capped at 3 minutes to push longer-video workloads onto the paid
// tiers; both paid tiers are uncapped. Enforced client-side at every upload
// entry point and backstopped server-side in the analyze route. All call sites
// go through `exceedsUploadDuration` so the rule lives in exactly one place.

/** Free-plan max upload duration in seconds (3 minutes). */
export const FREE_UPLOAD_MAX_DURATION_SECONDS = 180;

/** Per-tier max upload duration in seconds; `null` = no limit. */
export const UPLOAD_DURATION_LIMITS: Record<PlanTier, number | null> = {
  free: FREE_UPLOAD_MAX_DURATION_SECONDS,
  pro: null,
  creator: null,
};

/**
 * True when `plan` forbids a video of the given (known) duration. An unknown
 * duration (undefined / null / non-finite) is never blocked here — the caller
 * decides what to do when it can't measure the clip.
 */
export function exceedsUploadDuration(
  plan: PlanTier,
  durationSeconds: number | null | undefined
): boolean {
  const limit = UPLOAD_DURATION_LIMITS[plan];
  if (limit == null) return false;
  return (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > limit
  );
}

/** Exact user-facing copy shown when a Free upload exceeds the duration cap. */
export const FREE_VIDEO_DURATION_LIMIT_MESSAGE =
  "Free plan supports videos up to 3 minutes. Upgrade to upload longer videos.";

/** Stable server error code returned by the analyze route when the cap is hit. */
export const FREE_VIDEO_DURATION_LIMIT_CODE = "FREE_VIDEO_DURATION_LIMIT_EXCEEDED";

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
