/**
 * Timeline LANE model — the single source of truth for which `effectType` lives
 * in which timeline lane, how lanes are grouped, and which lanes are visible for
 * a given moment set.
 *
 * Replaces the old single "Overlays" lane: every edit type now has its OWN lane
 * (Captions, Hook text, Text overlays, Callouts, CTA, Transitions, Smart crop,
 * Blur) grouped under collapsible sections. This module is framework-neutral
 * (type-only imports) so it's unit-testable and shared by the timeline renderer.
 *
 * Backward compatibility: routing is purely by `effectType`, so old projects
 * whose overlays were stored in the unified model load straight into the correct
 * new lanes — no migration, no schema change.
 */
import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import { EFFECT_TO_LAYER, layerForEffectType } from "@/lib/timeline/layers";
import type { TimelineLayerId } from "@/lib/timeline/layers";

/** Collapsible lane groups (product spec §4). */
export type LaneGroupId = "camera" | "pacing" | "overlays" | "canvas";

export interface LaneGroupDef {
  id: LaneGroupId;
  label: string;
}

/** Ordered groups — top-to-bottom on the timeline. */
export const LANE_GROUPS: readonly LaneGroupDef[] = [
  { id: "camera", label: "Camera" },
  { id: "pacing", label: "Pacing" },
  { id: "overlays", label: "Visual overlays" },
  { id: "canvas", label: "Canvas" },
] as const;

/**
 * One lane per user-facing edit type. A lane IS a layer — same ids, because the
 * layer visibility a user toggles is persisted per lane. The type lives in
 * `@/lib/timeline/layers` (which the render gate and the export-job builder also
 * import; neither may depend on a component module), and `LaneId` stays as the
 * name the timeline code reads best.
 */
export type LaneId = TimelineLayerId;

export interface LaneDef {
  id: LaneId;
  group: LaneGroupId;
  /**
   * Human-readable lane name. NOT drawn anywhere — the left label column is
   * gone. It survives as the track row's `aria-label` (screen readers still need
   * to know which lane they are in) and as a stable name for tests.
   */
  label: string;
  /** effectTypes routed into this lane. */
  effectTypes: readonly EffectType[];
  /**
   * Core lanes (camera / cut / speed) ALWAYS show — even empty — with a
   * "Run this layer" affordance. Overlay lanes appear only when they have ≥1
   * moment (empty overlay types are reachable from the toolbar's Add menu).
   */
  core?: boolean;
  /** The analysis engine layer this lane maps to (for the Run affordance). */
  engineLayer?: "camera" | "cut" | "speed";
}

/**
 * Every EffectType → its lane. ONE mapping, shared with the render gate — if the
 * timeline drew an edit in a lane the gate assigned to a different layer, hiding
 * that layer would hide a lane the user wasn't looking at. Re-exported under the
 * lane vocabulary; `@/lib/timeline/layers` owns it.
 */
export const EFFECT_TO_LANE: Record<EffectType, LaneId> = EFFECT_TO_LAYER;

/** The lane a moment belongs to (by effectType). Unknown/legacy → camera. */
export const laneForEffectType: (t: EffectType | undefined) => LaneId =
  layerForEffectType;

/** Ordered lane definitions. Order within a group is top-to-bottom. */
export const LANE_DEFS: readonly LaneDef[] = [
  {
    id: "camera",
    group: "camera",
    label: "Zooms & focus",
    effectTypes: ["zoom", "click-highlight", "cursor-focus"],
    core: true,
    engineLayer: "camera",
  },
  { id: "cut", group: "pacing", label: "Cuts", effectTypes: ["cut"], core: true, engineLayer: "cut" },
  { id: "speed", group: "pacing", label: "Speed", effectTypes: ["speed-up"], core: true, engineLayer: "speed" },
  { id: "transition", group: "pacing", label: "Transitions", effectTypes: ["transition"] },
  { id: "captions", group: "overlays", label: "Captions", effectTypes: ["captions"] },
  { id: "hook-text", group: "overlays", label: "Hook text", effectTypes: ["hook-text"] },
  { id: "text-overlay", group: "overlays", label: "Text overlays", effectTypes: ["text-overlay"] },
  { id: "callout", group: "overlays", label: "Callouts", effectTypes: ["callout"] },
  { id: "branding-cta", group: "overlays", label: "CTA / End card", effectTypes: ["branding-cta"] },
  { id: "blur-redaction", group: "overlays", label: "Blur / Redaction", effectTypes: ["blur-redaction"] },
  { id: "smart-crop", group: "canvas", label: "Smart crop / Canvas", effectTypes: ["smart-crop", "crop"] },
] as const;

/** Lane def by id (for quick lookup). */
export const LANE_BY_ID: Record<LaneId, LaneDef> = Object.fromEntries(
  LANE_DEFS.map((l) => [l.id, l])
) as Record<LaneId, LaneDef>;

export interface PlannedLane {
  def: LaneDef;
  moments: DetectedMoment[];
  count: number;
}

export interface PlannedGroup {
  def: LaneGroupDef;
  lanes: PlannedLane[];
  /** Total moments across the group's lanes. */
  count: number;
}

/**
 * Plan the visible, grouped lanes for a moment set.
 *   • Core lanes (camera / cut / speed) always appear (even empty).
 *   • Overlay lanes appear only when they hold ≥1 moment — so the timeline
 *     never shows a wall of empty rows; empty overlay types live in the Add menu.
 *   • A group with no visible lanes is dropped entirely.
 * Pure → unit-testable and the single input the renderer maps over.
 */
export function planTimelineLanes(moments: DetectedMoment[]): PlannedGroup[] {
  const byLane = new Map<LaneId, DetectedMoment[]>();
  for (const m of moments) {
    const id = laneForEffectType(m.effectType);
    const arr = byLane.get(id);
    if (arr) arr.push(m);
    else byLane.set(id, [m]);
  }

  const out: PlannedGroup[] = [];
  for (const g of LANE_GROUPS) {
    const lanes: PlannedLane[] = [];
    for (const def of LANE_DEFS) {
      if (def.group !== g.id) continue;
      const ms = byLane.get(def.id) ?? [];
      if (def.core || ms.length > 0) {
        lanes.push({ def, moments: ms, count: ms.length });
      }
    }
    if (lanes.length > 0) {
      out.push({ def: g, lanes, count: lanes.reduce((n, l) => n + l.count, 0) });
    }
  }
  return out;
}
