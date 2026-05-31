import "server-only";

import { planMeetsMinimum, type PlanTier } from "./plan";
import { getUserPlan } from "./gating";

/**
 * Feature-key registry for plan-gated AI / export behaviour.
 *
 * Keys are stable strings so the analyze / rebalance / export routes can ask
 * "can this user use X?" without knowing the plan-tier policy. Adding a new
 * gated feature means: add a key here + a minimum-plan entry + a call site.
 *
 * The keys are intentionally broader than just "AI" — they cover any
 * monetisable capability (4K export, brand presets, priority rendering)
 * so we have ONE place that defines what each plan unlocks.
 */
export type AiFeatureKey =
  | "basic-analysis"        // Section classification, deterministic events + CV
  | "advanced-balancing"    // Gemini gap-fill (analyze phase C)
  | "ai-labeling"           // Gemini moment labeling (analyze phase E)
  | "ai-rebalance"          // Re-running balance under denser pacing presets
  | "cinematic-presets"     // Creator-tier builtin presets
  | "export-styles"         // Future export style variants (placeholder)
  | "priority-rendering"    // Future priority queue (placeholder)
  | "4k-export"             // 4K resolution in the export panel
  | "brand-presets";        // Future brand-kit feature (placeholder)

export const AI_FEATURE_MIN_PLAN: Record<AiFeatureKey, PlanTier> = {
  "basic-analysis": "free",
  "advanced-balancing": "creator",
  "ai-labeling": "creator",
  "ai-rebalance": "creator",
  "cinematic-presets": "creator",
  "export-styles": "creator",
  "priority-rendering": "pro",
  "4k-export": "pro",
  "brand-presets": "pro",
};

/** True when the user's plan meets the minimum tier for the given feature. */
export async function canUseAiFeature(
  uid: string,
  key: AiFeatureKey
): Promise<boolean> {
  const plan = await getUserPlan(uid);
  return planMeetsMinimum(plan, AI_FEATURE_MIN_PLAN[key]);
}

/** Synchronous version when the caller already knows the plan. */
export function canUseAiFeatureForPlan(
  plan: PlanTier,
  key: AiFeatureKey
): boolean {
  return planMeetsMinimum(plan, AI_FEATURE_MIN_PLAN[key]);
}
