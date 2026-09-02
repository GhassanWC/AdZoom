/**
 * Edit-acceptance telemetry — the editorial engine's feedback loop.
 *
 * Outcomes are DERIVED BY DIFFING, not by instrumenting every editor action:
 * the analyze terminal write snapshots what was generated; export persists the
 * final moments; comparing the two per AI-generated id yields
 * kept / modified / disabled / deleted, plus user-added.
 *
 * PRIVACY CONTRACT (same as the Smart Clips events, and pinned by
 * tests/editorial-telemetry.test.ts): payloads carry COUNTS AND ENUMS ONLY.
 * Never a transcript word, a label, a hook line, a reason sentence, or any
 * user-authored text.
 *
 * Wiring per the approved phases: types + `edits_generated` land in Phase 1;
 * the export-time `edits_outcome` diff + `director_pushback` wiring in Phase 2;
 * dashboards in Phase 4.
 *
 * Pure. No I/O.
 */
import type { DetectedMoment } from "@/lib/firebase/schema";
import type { ContentProfile } from "./context";
import { dominantMode } from "./context";
import {
  categoryForEffectType,
  type EditCategoryId,
  type ResolvedEditorialPolicy,
} from "./policy";

/** Coarse confidence buckets — enums, never raw floats, in payloads. */
export type ConfidenceBucket = "lt50" | "b50to70" | "b70to90" | "gte90" | "none";

export function confidenceBucket(score: number | undefined): ConfidenceBucket {
  if (typeof score !== "number" || !Number.isFinite(score)) return "none";
  if (score >= 0.9) return "gte90";
  if (score >= 0.7) return "b70to90";
  if (score >= 0.5) return "b50to70";
  return "lt50";
}

/** What ultimately happened to one AI-generated edit. */
export type EditOutcome = "kept" | "modified" | "disabled" | "deleted";

export interface EditOutcomeCounts {
  generated: number;
  kept: number;
  modified: number;
  disabled: number;
  deleted: number;
}

export interface EditOutcomesResult {
  byType: Partial<Record<EditCategoryId, EditOutcomeCounts>>;
  /** Confidence-bucket → outcome counts, across all types. */
  byConfidence: Partial<Record<ConfidenceBucket, Partial<Record<EditOutcome, number>>>>;
  /** Edits the user added by hand (source "user") present in the final set. */
  userAdded: number;
  totals: EditOutcomeCounts;
}

const isAi = (m: DetectedMoment) =>
  m.source !== "user" && m.provenance !== "user";

/**
 * Diff a generation snapshot against a later timeline (typically export-time).
 *
 * Known, accepted limitation (stated in the approved design): outcomes are
 * attributed against THE GIVEN generation only — carry-over moments from older
 * runs are excluded rather than misattributed.
 */
export function computeEditOutcomes(
  generated: DetectedMoment[],
  final: DetectedMoment[]
): EditOutcomesResult {
  const byType: EditOutcomesResult["byType"] = {};
  const byConfidence: EditOutcomesResult["byConfidence"] = {};
  const totals: EditOutcomeCounts = {
    generated: 0,
    kept: 0,
    modified: 0,
    disabled: 0,
    deleted: 0,
  };
  const finalById = new Map(final.map((m) => [m.id, m]));

  const bump = (
    category: EditCategoryId,
    bucket: ConfidenceBucket,
    outcome: EditOutcome
  ) => {
    const t = (byType[category] ??= {
      generated: 0,
      kept: 0,
      modified: 0,
      disabled: 0,
      deleted: 0,
    });
    t.generated += 1;
    t[outcome] += 1;
    totals.generated += 1;
    totals[outcome] += 1;
    const c = (byConfidence[bucket] ??= {});
    c[outcome] = (c[outcome] ?? 0) + 1;
  };

  for (const g of generated) {
    if (!isAi(g)) continue;
    const category = categoryForEffectType(g.effectType);
    const bucket = confidenceBucket(g.confidenceScore);
    const now = finalById.get(g.id);
    if (!now) {
      bump(category, bucket, "deleted");
      continue;
    }
    if (now.enabled === false && g.enabled !== false) {
      bump(category, bucket, "disabled");
      continue;
    }
    const moved =
      Math.abs(now.startTime - g.startTime) > 0.05 ||
      Math.abs(now.endTime - g.endTime) > 0.05;
    if (now.edited === true || now.source === "user" || moved) {
      bump(category, bucket, "modified");
      continue;
    }
    bump(category, bucket, "kept");
  }

  const generatedIds = new Set(generated.map((m) => m.id));
  return {
    byType,
    byConfidence,
    userAdded: final.filter(
      (m) => (m.source === "user" || m.provenance === "user") && !generatedIds.has(m.id)
    ).length,
    totals,
  };
}

// ── The `edits_generated` payload (Phase 1, recorded at analyze finalize) ───

export interface EditsGeneratedMetadata {
  templateId: string;
  templateVersion: number;
  policyMode: "classic" | "enforce";
  intent: string;
  dominantMode: string;
  outputTarget: string;
  /** Per-category generated counts on the final timeline. */
  countsByType: Partial<Record<EditCategoryId, number>>;
  /** Per-bucket generated counts (all types). */
  confidenceHistogram: Partial<Record<ConfidenceBucket, number>>;
  /** How many candidates each gate family removed this run. */
  gateDrops: { selection: number; composition: number };
  totalGenerated: number;
  durationBucket: "lte60" | "lte300" | "lte900" | "gt900";
}

export function buildEditsGeneratedMetadata(input: {
  policy: ResolvedEditorialPolicy;
  profile: ContentProfile;
  finalMoments: DetectedMoment[];
  selectionDropped: number;
  compositionDisabled: number;
  durationSeconds: number;
}): EditsGeneratedMetadata {
  const countsByType: Partial<Record<EditCategoryId, number>> = {};
  const confidenceHistogram: Partial<Record<ConfidenceBucket, number>> = {};
  let totalGenerated = 0;
  for (const m of input.finalMoments) {
    if (!isAi(m)) continue;
    totalGenerated += 1;
    const category = categoryForEffectType(m.effectType);
    countsByType[category] = (countsByType[category] ?? 0) + 1;
    const bucket = confidenceBucket(m.confidenceScore);
    confidenceHistogram[bucket] = (confidenceHistogram[bucket] ?? 0) + 1;
  }
  const d = input.durationSeconds;
  return {
    templateId: input.policy.templateId,
    templateVersion: input.policy.templateVersion,
    policyMode: input.policy.mode,
    intent: input.profile.primaryIntent,
    dominantMode: dominantMode(input.profile),
    outputTarget: input.profile.outputTarget,
    countsByType,
    confidenceHistogram,
    gateDrops: {
      selection: Math.max(0, input.selectionDropped),
      composition: Math.max(0, input.compositionDisabled),
    },
    totalGenerated,
    durationBucket: d <= 60 ? "lte60" : d <= 300 ? "lte300" : d <= 900 ? "lte900" : "gt900",
  };
}
