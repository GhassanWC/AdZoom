/**
 * Analysis engine ↔ timeline layer model — the single source of truth for which
 * `effectType`s belong to which user-facing engine, AI-vs-user classification,
 * and the carry-over computation that decides what survives a (re)analysis.
 *
 * This module is intentionally FRAMEWORK-NEUTRAL: it imports no React and no
 * Firebase runtime, only TYPES from the schema. That lets it be shared by the
 * client (dialog, timeline, editor context) AND the Node analyze route without
 * pulling a `"use client"` bundle onto the server.
 */
import type { DetectedMoment, EffectType } from "../firebase/schema";
import { CHUNK_SIZE_S, type ChunkMode } from "./chunk-config";

/**
 * Engine / timeline layers. `camera`, `cut`, `speed` are the PRIMARY
 * user-facing layers. `crop` is retained (non-primary, demoted) only so any
 * pre-existing crop moments still classify and are preserved across analyses —
 * crop is never offered in the dialog and the crop engine is no longer run.
 */
export type EngineLayer = "camera" | "cut" | "speed" | "crop";

/** The layers offered as primary toggles + timeline tracks. */
export const PRIMARY_LAYERS = ["camera", "cut", "speed"] as const;

/** How a (re)analysis treats edits that already exist on the timeline. */
export type ExistingEditMode = "keep" | "replace-selected" | "clear-all";

/**
 * What the user chose in the "Analysis options" dialog. Threaded through
 * `startAnalyze` → orchestrator → per-chunk engines → finalize route.
 */
export interface AnalysisOptions {
  /** Zoom / click-highlight / cursor-focus moments. */
  generateCameraEdits: boolean;
  /** Cut sections — removed dead / idle / loading / pause ranges. */
  generateCut: boolean;
  /** Speed-up sections. */
  generateSpeed: boolean;
  existingEditMode: ExistingEditMode;
  /** Analysis-granularity preset (or "custom"). */
  chunkMode: ChunkMode;
  /** Resolved chunk length in seconds — clamped [5,60]; authoritative for the orchestrator. */
  chunkSizeSeconds: number;
  /** Target chunk count — set only in custom "by count" mode (informational). */
  chunkCount?: number;
}

/** The persisted subset (the 3 toggles only — the mode is never remembered). */
export type AnalysisEnginePrefs = Pick<
  AnalysisOptions,
  "generateCameraEdits" | "generateCut" | "generateSpeed"
>;

/** First-time default: every engine on, the recommended non-destructive mode. */
export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  generateCameraEdits: true,
  generateCut: true,
  generateSpeed: true,
  existingEditMode: "replace-selected",
  chunkMode: "balanced",
  chunkSizeSeconds: CHUNK_SIZE_S,
};

/** Map an effectType to its engine layer (mirrors the timeline track split). */
export function layerForEffectType(t: EffectType): EngineLayer {
  if (t === "cut") return "cut";
  if (t === "crop") return "crop";
  if (t === "speed-up") return "speed";
  return "camera"; // zoom | click-highlight | cursor-focus
}

export function layerForMoment(m: DetectedMoment): EngineLayer {
  return layerForEffectType(m.effectType);
}

/**
 * A moment is "user-made" when the user authored or edited it directly. Both
 * the coarse `source` and the finer `provenance` are checked so an older doc
 * (which may carry only one) is classified correctly.
 */
export function isUserMoment(m: DetectedMoment): boolean {
  return m.source === "user" || m.provenance === "user";
}

export function isAiMoment(m: DetectedMoment): boolean {
  return !isUserMoment(m);
}

/** The layers the user asked to (re)generate this run. */
export function enabledLayers(opts: AnalysisOptions): Set<EngineLayer> {
  const s = new Set<EngineLayer>();
  if (opts.generateCameraEdits) s.add("camera");
  if (opts.generateCut) s.add("cut");
  if (opts.generateSpeed) s.add("speed");
  return s;
}

/** The primary layers the user turned off this run. */
export function disabledLayers(opts: AnalysisOptions): EngineLayer[] {
  const enabled = enabledLayers(opts);
  return PRIMARY_LAYERS.filter((l) => !enabled.has(l));
}

/** Layers that currently hold ≥1 AI-generated moment. */
export function aiLayersPresent(moments: DetectedMoment[]): Set<EngineLayer> {
  const s = new Set<EngineLayer>();
  for (const m of moments) if (isAiMoment(m)) s.add(layerForMoment(m));
  return s;
}

/**
 * Should this layer's engine actually RUN this analysis?
 *  - disabled layer → never.
 *  - "keep" mode → only when the layer has no AI edits yet ("add missing").
 *  - otherwise → yes (its old AI edits were already cleared by the carry-over).
 */
export function shouldRunLayer(
  layer: EngineLayer,
  opts: AnalysisOptions,
  existingAiLayers: Set<EngineLayer>
): boolean {
  if (!enabledLayers(opts).has(layer)) return false;
  if (opts.existingEditMode === "keep") return !existingAiLayers.has(layer);
  return true;
}

/**
 * The set of existing moments to PRESERVE before a fresh run — used to seed the
 * timeline reset (instead of clearing to `[]`). The selected engines then
 * append their fresh output on top.
 *
 *  - clear-all:        keep only user moments (drop every AI layer).
 *  - replace-selected: keep user moments + AI moments of NON-enabled layers
 *                      (enabled layers' AI edits are dropped → regenerated).
 *  - keep:             keep ALL moments (engines only fill empty layers).
 */
export function computeCarryOver(
  current: DetectedMoment[],
  opts: AnalysisOptions
): DetectedMoment[] {
  const enabled = enabledLayers(opts);
  switch (opts.existingEditMode) {
    case "clear-all":
      return current.filter(isUserMoment);
    case "replace-selected":
      return current.filter(
        (m) => isUserMoment(m) || !enabled.has(layerForMoment(m))
      );
    case "keep":
    default:
      return current.slice();
  }
}
