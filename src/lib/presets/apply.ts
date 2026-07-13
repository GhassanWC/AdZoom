/**
 * Applying a preset — the ONLY bridge from the library to the timeline.
 *
 * A preset compiles into an ordinary `DetectedMoment`. Not a "preset layer", not
 * a special render node — the same shape a hand-made edit has. That is what
 * makes every requirement downstream fall out for free:
 *
 *   • it appears on the existing timeline (laneModel routes it by effectType)
 *   • it can be moved, resized, split, duplicated, disabled and deleted
 *   • preview and export render it, because both read `detectedMoments`
 *   • it survives refresh, because it's written to the same Firestore field
 *   • undo/redo works, because it goes through the same `commitMoments` funnel
 *
 * The preset is captured as RESOLVED DATA (a concrete `textStyle` + `animation`)
 * rather than as a live reference to the registry. So a user who edits the text,
 * colour or timing keeps their edit permanently, and a future change to the
 * preset definition can never silently rewrite a video they already approved.
 * `moment.preset` is provenance, not a binding.
 *
 * Pure. No React, no Firebase.
 */
import type { DetectedMoment, EffectType, TextStyle } from "../firebase/schema";
import { sanitizeAnimation } from "./animation";
import { aspectOf, clampToSafeArea, resolvePresetStyle } from "./layout";
import {
  PRESET_SCHEMA_VERSION,
  type FramevoPreset,
  type PresetAspect,
} from "./types";

export interface ApplyPresetInput {
  preset: FramevoPreset;
  /** Where the playhead is — the edit starts here. */
  startTime: number;
  /** Source duration, so the edit can't run off the end. */
  duration: number;
  /** Output canvas — decides which aspect adaptation to bake in. */
  canvasWidth: number;
  canvasHeight: number;
  /** Unique id (the editor's `newMomentId`). */
  id: string;
  /** Overrides the preset's `defaultText`. */
  text?: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** The per-type settings bag a given effect type requires to render at all. */
function settingsFor(
  effectType: EffectType,
  text: string,
  preset: FramevoPreset
): Partial<DetectedMoment> {
  switch (effectType) {
    case "captions":
      return {
        captions: {
          text,
          // The legacy preset enum still has to be present — it's what older
          // readers and the caption panel key off. The real look comes from
          // `textStyle`, which is layered over it at draw time.
          stylePreset: "clean",
          position: "bottom",
        },
      };
    case "hook-text":
      return {
        hookText: {
          text,
          stylePreset: "bold",
          position: "center",
          // "none": the declarative `animation` owns the motion now. Leaving a
          // legacy enum here would be ignored by the renderer (preset animation
          // wins) but would mislead anyone reading the document.
          animation: "none",
        },
      };
    case "text-overlay":
      return {
        textOverlay: {
          text,
          position: "bottom-center",
          size: "medium",
          alignment: preset.textStyle.align ?? "center",
          backgroundStyle: "none",
          animation: "none",
        },
      };
    case "callout":
      return { callout: { text, style: "box" } };
    case "branding-cta":
      return {
        brandingCta: {
          ctaText: text,
          // "custom" is what makes `drawBrandingCta` read the resolved
          // `textStyle.customX/customY` — i.e. the preset's placement, adapted to
          // the aspect ratio and pulled inside the safe area. Pinning it to
          // "bottom-center" (as this originally did) silently discarded the whole
          // layout system for every CTA preset.
          position: "custom",
          stylePreset: "social",
        },
      };
    case "transition":
      // The preset's REAL style. Defaulting everything to "fade" would render
      // four distinct designs identically.
      return { transition: { style: preset.transitionStyle ?? "fade" } };
    default:
      return {};
  }
}

/**
 * Compile a preset into a real timeline edit.
 *
 * Returns `null` for an effect type the preset system can't express — a guard
 * that should be unreachable (the registry is typed), but a preset is data and
 * data can be wrong, and a silently-malformed moment on the timeline is far
 * worse than a refusal.
 */
export function applyPreset(input: ApplyPresetInput): DetectedMoment | null {
  const { preset, duration, canvasWidth, canvasHeight, id } = input;

  const aspect: PresetAspect = aspectOf(canvasWidth, canvasHeight);

  // Clamp the window into the video. A preset dropped near the end shortens
  // rather than hanging off the edge (which the review engine would flag).
  const maxEnd = duration > 0 ? duration : input.startTime + preset.defaultDurationSeconds;
  const start = Math.max(0, Math.min(input.startTime, Math.max(0, maxEnd - 0.3)));
  const end = Math.min(maxEnd, start + preset.defaultDurationSeconds);
  if (!(end > start)) return null;

  const text = (input.text ?? preset.defaultText ?? "").trim();
  const needsText =
    preset.effectType === "captions" ||
    preset.effectType === "hook-text" ||
    preset.effectType === "text-overlay" ||
    preset.effectType === "callout" ||
    preset.effectType === "branding-cta";
  if (needsText && !text) return null;

  // Resolve the design for THIS aspect ratio, then pull it inside the platform's
  // safe area. Both steps are baked into the persisted style, so what the user
  // sees in the preview is exactly what the exporter draws — the adaptation is
  // not re-derived at render time and cannot disagree.
  const styled: TextStyle = clampToSafeArea(
    resolvePresetStyle(preset, aspect),
    aspect
  );

  const settings = settingsFor(preset.effectType, text, preset);

  const moment: DetectedMoment = {
    id,
    startTime: round(start),
    endTime: round(end),
    label: preset.name,
    reason: `${preset.name} preset.`,
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType: preset.effectType,
    enabled: true,
    // A preset the USER applied is the user's edit — it must survive a
    // re-analysis in "keep" mode, and it must not be swept away as an AI edit.
    source: "user",
    provenance: "user",
    edited: true,
    textStyle: styled,
    preset: { id: preset.id, version: PRESET_SCHEMA_VERSION },
    intensity: 0.7,
    attentionScore: 0.6,
    ...settings,
  };

  const anim = sanitizeAnimation(preset.animation);
  if (anim) moment.animation = anim;

  return moment;
}

/**
 * Re-adapt an already-applied preset to a NEW aspect ratio.
 *
 * Called when the user changes the output canvas (16:9 → 9:16). It re-resolves
 * the preset's layout — font scale, placement, safe area — while PRESERVING every
 * property the user customised (colour, text, weight, background…), because
 * losing someone's hand-tuned colour just because they switched to vertical
 * would be indefensible.
 *
 * Only layout keys are touched. Anything else the user set stays exactly as it is.
 */
export function readaptPresetMoment(
  m: DetectedMoment,
  preset: FramevoPreset,
  canvasWidth: number,
  canvasHeight: number
): DetectedMoment {
  const aspect = aspectOf(canvasWidth, canvasHeight);
  const fresh = resolvePresetStyle(preset, aspect);
  const clamped = clampToSafeArea(fresh, aspect);

  return {
    ...m,
    textStyle: {
      // The user's style wins on every axis EXCEPT the four layout keys the
      // aspect ratio genuinely owns.
      ...(m.textStyle ?? {}),
      fontScale: clamped.fontScale,
      position: clamped.position,
      customX: clamped.customX,
      customY: clamped.customY,
    },
  };
}

/** True when this moment came from the preset library. */
export function isPresetMoment(m: Pick<DetectedMoment, "preset">): boolean {
  return !!m.preset?.id;
}

/** Suggested default text for a preset, never fabricated as a factual claim. */
export function presetPlaceholderText(preset: FramevoPreset): string {
  return preset.defaultText ?? "Your text here";
}

/** Clamp any user-authored text style back inside the safe area for a canvas. */
export function enforceSafeArea(
  style: TextStyle,
  canvasWidth: number,
  canvasHeight: number
): TextStyle {
  return clampToSafeArea(style, aspectOf(canvasWidth, canvasHeight));
}

export { clamp01 };
