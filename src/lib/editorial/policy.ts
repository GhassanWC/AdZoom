/**
 * Editorial policy — the typed contract between templates and the engines.
 *
 * A `ResolvedEditorialPolicy` is the ONE object every consumer reads: the
 * balancer (floors), the AI Editor / decision engine (bars, budgets, spacing,
 * per-type statuses), the overlay generators (caps), and the composition
 * review (Gate D). It is produced once per run by `resolve.ts` from
 * matrix ∩ template ∩ signals ∩ explicit user toggles.
 *
 * The status vocabulary is the approved six-value set. "impossible" is NEVER
 * authored — no template or matrix cell may write it. It is COMPUTED by the
 * resolver when an edit's modality/evidence requirement cannot be met anywhere
 * in the video (see matrix.ts), and it always carries a reason.
 *
 * Pure types + tiny pure helpers. No I/O.
 */
import type { EffectType, Pacing } from "@/lib/firebase/schema";
import type { EditOperationCategory } from "@/lib/analysis/edit-recipe";
import type { PacingProfile } from "./constants";

/**
 * Policy vocabulary = the recipe categories PLUS the cursor-emphasis split.
 * `generateCameraEdits` historically fused punch-zoom with cursor tracking;
 * "subtle zooms yes, cursor tracking never" (a talking head) was inexpressible.
 * The split makes it a policy fact.
 */
export type EditCategoryId = EditOperationCategory | "cursor_emphasis";

/** Approved six-value status vocabulary. */
export type PolicyStatus =
  | "core" //                the category's signature edits — generate eagerly
  | "encouraged" //          generate liberally; engine keeps the best under budget
  | "allowed" //             only well-evidenced candidates survive
  | "discouraged" //         exceptional evidence only (confidence bar raised)
  | "disabled-by-default" // not generated unless the user/template turns it on
  | "impossible"; //         COMPUTED ONLY — unmeetable for this video, with a reason

/** Statuses a template/matrix may author (everything except the computed one). */
export type AuthorableStatus = Exclude<PolicyStatus, "impossible">;

/** Does this status permit generation at all? */
export function statusAllowsGeneration(status: PolicyStatus): boolean {
  return status === "core" || status === "encouraged" || status === "allowed" || status === "discouraged";
}

/** Per-edit policy — the load-bearing behavioural knobs. All optional except status. */
export interface EditPolicy {
  status: AuthorableStatus;
  /** 0..1 — conflict resolution + duration-target sacrifice order. */
  priority: number;
  /** Gate C confidence bar for this type (falls back to the decision default). */
  minConfidence?: number;
  /** Output-minute budget — a ceiling, never a target. */
  maxPerMinute?: number;
  maxTotal?: number;
  /** Same-type spacing in seconds. */
  minSpacingSec?: number;
  /** 0..1 — rides the existing per-moment intensity blend. */
  intensity?: number;
  /** Category-specific tuning (mirrors EditOperation.params). */
  params?: Record<string, unknown>;
}

/** Whole-timeline budgets — Gate D's raw material. */
export interface DensityPolicy {
  /**
   * Floor on total selected edits. DEFAULT 0 — "no edit" is a valid outcome.
   * Classic sets 3 purely to reproduce shipped behaviour.
   */
  minTotal: number;
  maxTotal: number;
  /** Rolling-window busyness cap: at most `maxInWindow` edits per `windowS`. */
  crossDensity?: { windowS: number; maxInWindow: number };
}

/** How the composition review (Gate D) behaves for this run. */
export interface CompositionPolicy {
  /**
   * "off"     → Gate D is a no-op (Classic compatibility, clarification #3).
   * "enforce" → the composition rules run with the numbers below.
   */
  mode: "off" | "enforce";
  /** Zoom-family spacing/budget (generalises the Director review's backstop). */
  zoom?: { minGapSeconds: number; maxPerOutputMinute: number };
  /** ≥N edits inside `windowS` = a cluster; keep the strongest, disable the rest. */
  cluster?: { windowS: number; maxInWindow: number };
  /**
   * Emphasis stacking: at most one emphasis edit (zoom / callout / text-overlay
   * family) active at an instant; lower `priority` is disabled.
   */
  overlapEmphasis?: boolean;
}

/** The bars the decision engine (AI Editor) reads. Classic = today's constants. */
export interface DecisionPolicy {
  minConfidence: number;
  crowdWindowS: number;
  sameTypeStreakMax: number;
  maxMoments: number;
  bucketMax: (durationS: number) => number;
  /** Overrides of the pacing-profile-derived numbers (absent = derive as today). */
  minSpacingS?: number;
  zoomCooldownS?: number;
  maxEditsOverride?: number;
  /** Per-category rules — statuses, bars, budgets, spacing. */
  perType: Partial<Record<EditCategoryId, EditPolicy>>;
  /**
   * When true, a category ABSENT from `perType` is treated as not generated
   * (recipes have always used omission-means-disabled). When false (Classic),
   * absent categories judge exactly as before this engine was policy-aware.
   */
  strictTypes: boolean;
}

export interface BalancerPolicy {
  /** Floor on the balancer's target count (Classic 3; templates default 0). */
  minTotal: number;
}

export interface OverlayPolicy {
  textOverlayMax: number;
  calloutMax: number;
  calloutMinConfidence: number;
  transitionMax: number;
}

/** The one object a run resolves. Every engine reads its slice of this. */
export interface ResolvedEditorialPolicy {
  templateId: string;
  templateVersion: number;
  /** "classic" reproduces shipped behaviour bit-for-bit; "enforce" applies the template. */
  mode: "classic" | "enforce";
  pacing?: Pacing;
  pacingProfile?: PacingProfile;
  decision: DecisionPolicy;
  balancer: BalancerPolicy;
  overlays: OverlayPolicy;
  composition: CompositionPolicy;
  density: DensityPolicy;
  /** Final per-category statuses AFTER matrix clamp + feasibility (reporting + UI). */
  statuses: Partial<Record<EditCategoryId, PolicyStatus>>;
  /** Why each category is on/off/unavailable — explainability, mirrors EditRecipePlan.reasons. */
  reasons: Record<string, string>;
}

/** Compact, Firestore-safe record of what governed a run (persisted + telemetry). */
export interface EditorialPolicyDigest {
  templateId: string;
  templateVersion: number;
  mode: "classic" | "enforce";
  statuses: Partial<Record<EditCategoryId, PolicyStatus>>;
  reasons: Record<string, string>;
}

/**
 * effectType → policy category. The camera family splits: `zoom` is punch
 * emphasis; `click-highlight` + `cursor-focus` are cursor emphasis.
 */
export function categoryForEffectType(t: EffectType): EditCategoryId {
  switch (t) {
    case "zoom":
      return "zoom";
    case "click-highlight":
    case "cursor-focus":
      return "cursor_emphasis";
    case "cut":
      return "cut";
    case "speed-up":
      return "speed";
    case "captions":
      return "captions";
    case "hook-text":
      return "hook_text";
    case "text-overlay":
      return "text_overlay";
    case "callout":
      return "callout";
    case "transition":
      return "transition";
    case "branding-cta":
      return "branding";
    case "blur-redaction":
      return "blur_redaction";
    case "smart-crop":
    case "crop":
      return "smart_crop";
    default:
      return "zoom";
  }
}

/**
 * The policy in force at output-time `tSec`.
 *
 * THE HYBRID SEAM (approved architecture §L): every gate consults policy
 * through this accessor, never by reading fields off the resolved object
 * directly. Phase 1 ignores `tSec` — one policy governs the whole video — so
 * this is the identity. When modality segments land (Phase 3+), per-segment
 * policy becomes a change INSIDE this function, not a call-site migration.
 * New code must not bypass it.
 */
export function policyAt(
  policy: ResolvedEditorialPolicy,
  _tSec: number
): ResolvedEditorialPolicy {
  return policy;
}
