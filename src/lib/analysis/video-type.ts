/**
 * User-selected video type — the pre-analysis choice that drives which edit
 * recipe the AI applies. Pure + framework-neutral (types only) so it's shared by
 * the picker UI, the editor context, and the server analyze route.
 *
 * This is DISTINCT from the AI-detected `VideoType` (the model's internal
 * classification). "auto" defers to detection; every other choice maps onto a
 * detected type (`mapSelectedToDetectedVideoType`) so the balancer + prompt bias
 * follow the user's declaration.
 */
import type { SelectedVideoType, VideoType } from "@/lib/firebase/schema";

export const DEFAULT_SELECTED_VIDEO_TYPE: SelectedVideoType = "auto";

/** Display order in the picker — "Auto Detect" first (the default). */
export const SELECTED_VIDEO_TYPES: SelectedVideoType[] = [
  "auto",
  "reels-shorts",
  "talking-head",
  "podcast-clip",
  "product-demo",
  "tutorial",
  "vlog",
  "ad-promo",
  "screen-recording",
];

export interface VideoTypeMeta {
  /** Short card title. */
  label: string;
  /** One-line explanation shown under the title. */
  description: string;
}

/** Labels + brief descriptions for the picker (and any server-side labelling). */
export const VIDEO_TYPE_META: Record<SelectedVideoType, VideoTypeMeta> = {
  auto: {
    label: "Auto Detect",
    description: "Let Framevo analyze and pick the best edit for your video.",
  },
  "reels-shorts": {
    label: "Reels / Shorts / TikTok",
    description: "Fast social content — punchy pacing and vertical framing.",
  },
  "talking-head": {
    label: "Talking Head",
    description: "Speaker-focused videos — keep the subject centered and steady.",
  },
  "podcast-clip": {
    label: "Podcast Clip",
    description: "Long conversation clips — minimal cuts, follow the speakers.",
  },
  "product-demo": {
    label: "Product Demo",
    description: "Software / product walkthroughs — zoom into what matters.",
  },
  tutorial: {
    label: "Tutorial / Educational",
    description: "Step-by-step educational video — clear, focused pacing.",
  },
  vlog: {
    label: "Vlog / Lifestyle",
    description: "Lifestyle / story video — natural pacing, light trimming.",
  },
  "ad-promo": {
    label: "Ad / Promo",
    description: "Marketing video — tight, energetic, hook-first edits.",
  },
  "screen-recording": {
    label: "Screen Recording",
    description: "Software / screen workflow — cinematic zooms on the action.",
  },
};

/** Coerce arbitrary Firestore input into a valid type (default "auto"). */
export function normalizeSelectedVideoType(raw: unknown): SelectedVideoType {
  return typeof raw === "string" && raw in VIDEO_TYPE_META
    ? (raw as SelectedVideoType)
    : DEFAULT_SELECTED_VIDEO_TYPE;
}

/**
 * Map the user's selection onto the AI's internal `VideoType` so the balancer +
 * prompt bias follow it. Returns `undefined` for "auto" — the pipeline then uses
 * the model's own detection. The internal enum is screen-centric, so this is a
 * best-fit projection (e.g. Reels → vertical-short, Talking Head → talking-tutorial).
 */
export function mapSelectedToDetectedVideoType(
  selected: SelectedVideoType | undefined
): VideoType | undefined {
  switch (selected) {
    case "reels-shorts":
      return "vertical-short";
    case "talking-head":
    case "podcast-clip":
      return "talking-tutorial";
    case "product-demo":
      return "saas-demo";
    case "tutorial":
      return "talking-tutorial";
    case "vlog":
      return "mixed";
    case "ad-promo":
      return "vertical-short";
    case "screen-recording":
      return "onboarding-flow";
    case "auto":
    default:
      return undefined;
  }
}
