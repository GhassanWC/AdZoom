/**
 * TIMELINE LAYERS — the effectType → layer mapping, and the render-time gate
 * that hides a whole layer.
 *
 * Framevo has TWO independent visibility axes, and keeping them independent is
 * the whole point of this module:
 *
 *   1. PER-EDIT   `DetectedMoment.enabled`   — hide this one edit.
 *   2. PER-LAYER  `ProjectDoc.timelineLayers` — hide every edit in this lane.
 *
 * An edit renders only when BOTH are open. They never write to each other: a
 * layer toggle does not touch a single moment, so hiding a layer and re-showing
 * it restores its edits EXACTLY as they were — including the ones the user had
 * individually hidden, which stay hidden. (A bulk `enabled: false` sweep across
 * the lane would destroy that: re-enabling would resurrect them.)
 *
 * `visibleMoments` is the gate. It DROPS layer-hidden moments from the array
 * before it reaches any renderer, so every downstream selector — camera, the
 * cut/speed timeline map, the overlay passes, the ffmpeg audio graph — simply
 * never sees them. That's why hiding the Cuts layer gives the footage back and
 * hiding Speed plays at 1×: not special-cased anywhere, just absent input.
 *
 * Pure + type-only imports: shared by the preview, the browser exporter, the
 * export-job builder and the timeline UI.
 */
import type {
  DetectedMoment,
  EffectType,
  LayerVisibility,
  TimelineLayerId,
} from "@/lib/firebase/schema";

export type { LayerVisibility, TimelineLayerId };

/**
 * Every EffectType → its layer. STATIC + exhaustive (a new EffectType without a
 * layer is a compile error), which is what guarantees old docs route correctly.
 * `crop` (legacy reframe) rides the Canvas layer with smart-crop — both are
 * framing edits.
 */
export const EFFECT_TO_LAYER: Record<EffectType, TimelineLayerId> = {
  zoom: "camera",
  "click-highlight": "camera",
  "cursor-focus": "camera",
  cut: "cut",
  "speed-up": "speed",
  crop: "smart-crop",
  captions: "captions",
  "hook-text": "hook-text",
  "text-overlay": "text-overlay",
  "smart-crop": "smart-crop",
  callout: "callout",
  "blur-redaction": "blur-redaction",
  transition: "transition",
  "branding-cta": "branding-cta",
};

/** Every layer id, in timeline order. */
export const TIMELINE_LAYER_IDS: readonly TimelineLayerId[] = [
  "camera",
  "cut",
  "speed",
  "transition",
  "captions",
  "hook-text",
  "text-overlay",
  "callout",
  "branding-cta",
  "blur-redaction",
  "smart-crop",
] as const;

/** The layer an edit belongs to (by effectType). Unknown/legacy → camera. */
export function layerForEffectType(t: EffectType | undefined): TimelineLayerId {
  return (t && EFFECT_TO_LAYER[t]) || "camera";
}

/**
 * Expand a (possibly sparse) visibility map into an EXPLICIT boolean for every
 * layer. This is the shape that gets persisted, and it exists because Firestore's
 * `setDoc(..., { merge: true })` DEEP-MERGES nested maps: writing `{}` — or a map
 * that has simply dropped the `captions` key — leaves an existing
 * `captions: false` sitting in the document. Re-showing a layer would appear to
 * work, then the layer would come back hidden on the next read, and undo would
 * silently fail to restore.
 *
 * Writing all eleven keys every time (eleven booleans) makes each write fully
 * determine the state, so merge semantics can't strand a stale `false`.
 */
export function normalizeLayerVisibility(
  layers: LayerVisibility | undefined
): Record<TimelineLayerId, boolean> {
  const out = {} as Record<TimelineLayerId, boolean>;
  for (const id of TIMELINE_LAYER_IDS) out[id] = isLayerVisible(layers, id);
  return out;
}

/** Absent = visible. Only an explicit `false` hides a layer. */
export function isLayerVisible(
  layers: LayerVisibility | undefined,
  id: TimelineLayerId
): boolean {
  return layers?.[id] !== false;
}

/** True when this edit's LAYER is visible (says nothing about the edit's own flag). */
export function isMomentLayerVisible(
  layers: LayerVisibility | undefined,
  m: Pick<DetectedMoment, "effectType">
): boolean {
  return isLayerVisible(layers, layerForEffectType(m.effectType));
}

/** The ids of every hidden layer (stable order). Empty when nothing is hidden. */
export function hiddenLayerIds(layers: LayerVisibility | undefined): TimelineLayerId[] {
  if (!layers) return [];
  return (Object.keys(layers) as TimelineLayerId[]).filter((id) => layers[id] === false);
}

/**
 * The edits that REACH the renderer: everything in a visible layer. The edit's
 * own `enabled` flag is NOT applied here — the render core already gates that at
 * its three selectors, and the timeline UI needs to keep drawing disabled edits.
 *
 * Returns the SAME array reference when no layer is hidden (the overwhelmingly
 * common case), so the preview's `useMemo` doesn't churn and re-render the
 * player on every unrelated project write.
 */
export function visibleMoments(
  moments: DetectedMoment[],
  layers: LayerVisibility | undefined
): DetectedMoment[] {
  const hidden = hiddenLayerIds(layers);
  if (hidden.length === 0 || moments.length === 0) return moments;
  const off = new Set<TimelineLayerId>(hidden);
  return moments.filter((m) => !off.has(layerForEffectType(m.effectType)));
}
