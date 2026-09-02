/**
 * resolveEditorialPolicy — matrix ∩ template ∩ signals ∩ explicit user toggles
 * → the ONE `ResolvedEditorialPolicy` object every engine reads for a run.
 *
 * Layering (outermost wins), per the approved architecture:
 *
 *   ContentProfile (what the video IS — never mutated here)
 *     → Template (how this style edits)
 *       → [Director brief deltas — Phase 2: the brief is a RUN-LEVEL request
 *          ("make it a punchy LinkedIn promo") and tightens policy within the
 *          template's bounds; it NEVER rewrites the profile (clarification #1).
 *          Phase 1 resolves without it; the Director stage still runs after
 *          the engines exactly as before.]
 *         → explicit user toggles from the Analyze dialog (outermost)
 *
 * Classic templates resolve to `mode: "classic"`: every engine then uses the
 * pre-Editorial-Engine constants verbatim and Gate D is a no-op — shipped
 * behaviour, bit for bit (clarification #3). Enforce templates carry their own
 * numbers.
 *
 * "impossible" is COMPUTED here (matrix.ts modality/evidence requirements),
 * never authored: the resolver reports "unavailable: …" with the reason, and
 * the category simply does not generate for this video.
 *
 * Pure. No I/O.
 */
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";
import { DEFAULT_RECIPES } from "@/lib/analysis/edit-recipe";
import {
  CLASSIC_BALANCER,
  CLASSIC_DECISION,
  CLASSIC_OVERLAYS,
} from "./constants";
import type { ContentProfile } from "./context";
import { evidenceFromSignals, unavailableReason } from "./matrix";
import {
  statusAllowsGeneration,
  type DecisionPolicy,
  type EditCategoryId,
  type EditPolicy,
  type EditorialPolicyDigest,
  type PolicyStatus,
  type ResolvedEditorialPolicy,
} from "./policy";
import type { EditingTemplate } from "./templates";

/** Explicit per-category user overrides (from the Analyze dialog toggles). */
export type PolicyOverrides = Partial<Record<EditCategoryId, boolean>>;

/**
 * Map the dialog's toggle set onto policy categories. One camera toggle has
 * always governed both zoom and cursor emphasis; the SPLIT is expressed by the
 * template (Clean Professional allows zoom while omitting cursor_emphasis),
 * not by inventing a new toggle in Phase 1.
 */
export function overridesFromToggles(toggles: {
  generateCameraEdits?: boolean;
  generateCut?: boolean;
  generateSpeed?: boolean;
  generateCaptions?: boolean;
  generateHookText?: boolean;
  generateTextOverlays?: boolean;
  generateSmartCrop?: boolean;
  generateCallouts?: boolean;
  generateTransitions?: boolean;
  generateCta?: boolean;
}): PolicyOverrides {
  const out: PolicyOverrides = {};
  const set = (cats: EditCategoryId[], v: boolean | undefined) => {
    if (v === undefined) return;
    for (const c of cats) out[c] = v;
  };
  set(["zoom", "cursor_emphasis"], toggles.generateCameraEdits);
  set(["cut"], toggles.generateCut);
  set(["speed"], toggles.generateSpeed);
  set(["captions"], toggles.generateCaptions);
  set(["hook_text"], toggles.generateHookText);
  set(["text_overlay"], toggles.generateTextOverlays);
  set(["smart_crop"], toggles.generateSmartCrop);
  set(["callout"], toggles.generateCallouts);
  set(["transition"], toggles.generateTransitions);
  set(["branding"], toggles.generateCta);
  return out;
}

export interface ResolvePolicyInput {
  profile: ContentProfile;
  template: EditingTemplate;
  signals: RecipeSignals;
  overrides?: PolicyOverrides;
}

const ALL_CATEGORIES: EditCategoryId[] = [
  "cut",
  "zoom",
  "cursor_emphasis",
  "speed",
  "captions",
  "smart_crop",
  "text_overlay",
  "hook_text",
  "transition",
  "silence_removal",
  "audio_cleanup",
  "freeze_frame",
  "blur_redaction",
  "branding",
  "callout",
  "music",
  "broll_overlay",
];

/** Classic decision defaults — exactly the AI Editor's shipped bars. */
export function classicDecisionPolicy(): DecisionPolicy {
  return {
    minConfidence: CLASSIC_DECISION.minConfidence,
    crowdWindowS: CLASSIC_DECISION.crowdWindowS,
    sameTypeStreakMax: CLASSIC_DECISION.sameTypeStreakMax,
    maxMoments: CLASSIC_DECISION.maxMoments,
    bucketMax: CLASSIC_DECISION.bucketMax,
    perType: {},
    strictTypes: false,
  };
}

export function resolveEditorialPolicy(
  input: ResolvePolicyInput
): ResolvedEditorialPolicy {
  const { profile, template, signals } = input;
  const overrides = input.overrides ?? {};
  const evidence = evidenceFromSignals(signals);
  const reasons: Record<string, string> = {};
  const statuses: Partial<Record<EditCategoryId, PolicyStatus>> = {};

  const isClassic = !template.spec;

  // ── Per-category statuses (matrix clamp + template + overrides) ───────────
  const specEdits: Partial<Record<EditCategoryId, EditPolicy>> =
    template.spec?.edits ?? {};
  const classicRecipe = template.classicFor
    ? DEFAULT_RECIPES[template.classicFor]
    : undefined;

  for (const category of ALL_CATEGORIES) {
    // 1. Gate A — the computed "impossible". Physical requirements first;
    //    nothing below can resurrect an unmeetable category.
    const unavailable = unavailableReason(category, profile, evidence);
    if (unavailable) {
      statuses[category] = "impossible";
      reasons[category] = unavailable;
      continue;
    }

    // 2. The template's stance. Classic reports the recipe's presence
    //    (omission-means-disabled, as recipes always worked); enforce
    //    templates state theirs explicitly, with omission = disabled.
    let status: PolicyStatus;
    if (isClassic) {
      // REPORTING ONLY in classic mode — enforcement stays exactly where it
      // has always been (toggles + the recipe's own enabledCategories check).
      // The route must NOT derive the overlay allow-map from classic statuses;
      // see `overlayAllowFromPolicy`.
      const present =
        category === "cursor_emphasis"
          ? classicRecipe?.operations.some((o) => o.category === "zoom") ?? true
          : category === "branding"
            ? classicRecipe?.operations.some(
                (o) =>
                  o.category === "branding" ||
                  (o.category === "text_overlay" && o.params?.kind === "cta")
              ) ?? true
            : classicRecipe?.operations.some((o) => o.category === category) ?? true;
      status = present ? "allowed" : "disabled-by-default";
      reasons[category] = present
        ? `part of the ${classicRecipe?.name ?? "Classic"} recipe`
        : `not part of the ${classicRecipe?.name ?? "Classic"} recipe`;
    } else {
      const policy = specEdits[category];
      status = policy?.status ?? "disabled-by-default";
      reasons[category] = policy
        ? `${template.name}: ${status}`
        : `${template.name} does not use this edit`;
    }

    // 3. Explicit user toggles — the outermost layer. `false` always wins;
    //    `true` re-opens a template-omitted category at Classic defaults (the
    //    user's explicit ask outranks the template's taste, never the matrix).
    const override = overrides[category];
    if (override === false) {
      status = "disabled-by-default";
      reasons[category] = "turned off in the analysis options";
    } else if (override === true && !statusAllowsGeneration(status)) {
      status = "allowed";
      reasons[category] = "explicitly enabled in the analysis options";
    }

    statuses[category] = status;
  }

  // ── Assemble the per-engine slices ────────────────────────────────────────
  if (isClassic) {
    return {
      templateId: template.id,
      templateVersion: template.version,
      mode: "classic",
      decision: classicDecisionPolicy(),
      balancer: { minTotal: CLASSIC_BALANCER.minMoments },
      overlays: { ...CLASSIC_OVERLAYS },
      composition: { mode: "off" },
      density: { minTotal: CLASSIC_BALANCER.minMoments, maxTotal: CLASSIC_BALANCER.maxMoments },
      statuses,
      reasons,
    };
  }

  const spec = template.spec!;
  const perType: Partial<Record<EditCategoryId, EditPolicy>> = {};
  for (const category of ALL_CATEGORIES) {
    const s = statuses[category];
    const specPolicy = specEdits[category];
    if (s === "impossible" || s === "disabled-by-default") continue;
    perType[category] =
      specPolicy ??
      // Re-opened by an explicit user toggle: Classic-equivalent behaviour.
      ({ status: "allowed", priority: 0.5 } satisfies EditPolicy);
  }

  return {
    templateId: template.id,
    templateVersion: template.version,
    mode: "enforce",
    pacing: spec.pacing,
    decision: {
      ...classicDecisionPolicy(),
      maxEditsOverride: spec.density.maxTotal,
      perType,
      strictTypes: true,
    },
    balancer: { minTotal: spec.density.minTotal },
    overlays: { ...CLASSIC_OVERLAYS, ...(spec.overlays ?? {}) },
    composition: { mode: "enforce", ...spec.composition },
    density: spec.density,
    statuses,
    reasons,
  };
}

/**
 * The overlay categories this policy FORBIDS generating — merged (ANDed) into
 * the route's existing toggle-driven allow map. Classic mode forbids NOTHING
 * here: its enforcement stays exactly the shipped toggles-plus-recipe path, so
 * a Classic run is bit-identical to the pre-policy pipeline. Enforce templates
 * restrict on top of the user's toggles; they never widen them.
 */
export function overlayAllowFromPolicy(
  policy: ResolvedEditorialPolicy
): Partial<Record<"hook_text" | "text_overlay" | "smart_crop" | "callout" | "transition" | "branding", boolean>> {
  if (policy.mode === "classic") return {};
  const out: Partial<
    Record<"hook_text" | "text_overlay" | "smart_crop" | "callout" | "transition" | "branding", boolean>
  > = {};
  const forbid = (c: EditCategoryId & keyof typeof out) => {
    if (!statusAllowsGeneration(policy.statuses[c] ?? "disabled-by-default")) {
      out[c] = false;
    }
  };
  forbid("hook_text");
  forbid("text_overlay");
  forbid("smart_crop");
  forbid("callout");
  forbid("transition");
  forbid("branding");
  return out;
}

/** Firestore-safe record of what governed a run. */
export function policyDigest(policy: ResolvedEditorialPolicy): EditorialPolicyDigest {
  return {
    templateId: policy.templateId,
    templateVersion: policy.templateVersion,
    mode: policy.mode,
    statuses: policy.statuses,
    reasons: policy.reasons,
  };
}
