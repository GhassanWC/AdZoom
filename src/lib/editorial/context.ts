/**
 * ContentProfile — the internal editorial classification of a video.
 *
 * `SelectedVideoType` (the picker) survives as the user-facing shortcut and
 * back-compat field, but it mixes concepts: talking-head is a MODALITY,
 * tutorial is a PURPOSE, reels-shorts is a DISTRIBUTION FORMAT. A real video is
 * legitimately several of these at once (a tutorial that is screen recording +
 * talking head + short-form). This profile separates the axes:
 *
 *   • primaryIntent — what the SOURCE CONTENT fundamentally is (its purpose).
 *   • contentModes  — what the pixels are, as coexisting duration fractions.
 *   • outputTarget  — where it is going (reuses the Director's platform vocab).
 *
 * THE SOURCE/REQUEST SEPARATION (approved clarification #1): a Director brief
 * describes what the user wants DONE with the content, never what the content
 * IS. "Turn this tutorial into a punchy LinkedIn promo" leaves
 * `primaryIntent: "tutorial"` untouched — the promo ask is a run-level policy
 * delta applied in `resolve.ts`. Nothing in this module accepts a DirectorBrief.
 *
 * PER-AXIS SOURCES (approved clarification #2): each axis records who set it
 * (`default` | `detected` | `user`) independently — intent can be detected
 * while the target is user-chosen — and a user-set axis is LOCKED: detection
 * merges via `mergeDetectedContext` and never overwrites it.
 *
 * Pure + framework-neutral; type-only imports; loadable under `node --test`.
 */
import type { SelectedVideoType } from "@/lib/firebase/schema";
import type { DirectorPlatform } from "@/lib/director/types";

/** What the source content fundamentally is. NOT what the user wants made from it. */
export type PrimaryIntent =
  | "tutorial"
  | "demo"
  | "promo"
  | "conversation"
  | "story"
  | "unknown";

export const PRIMARY_INTENTS: readonly PrimaryIntent[] = [
  "tutorial",
  "demo",
  "promo",
  "conversation",
  "story",
  "unknown",
];

/** What the pixels are. Fractions of duration; several coexist on one video. */
export type ContentMode = "screen" | "camera" | "slides" | "gameplay" | "other";

export const CONTENT_MODES: readonly ContentMode[] = [
  "screen",
  "camera",
  "slides",
  "gameplay",
  "other",
];

/** Who set an axis. `user` locks it against detection. */
export type ContextSource = "default" | "detected" | "user";

export type ContextAxis = "intent" | "modes" | "target";

/** A coarse modality stretch (camera / screen / mixed). Produced in Phase 3. */
export interface ModalitySegment {
  startSec: number;
  endSec: number;
  mode: ContentMode | "mixed";
  /** 0..1 */
  confidence: number;
}

export interface ContentProfile {
  version: 1;
  primaryIntent: PrimaryIntent;
  /** 0..1 — confidence in `primaryIntent` (1 when the user set it). */
  intentConfidence: number;
  /** Duration fractions per mode, Σ ≤ 1. Missing mode = 0. */
  contentModes: Partial<Record<ContentMode, number>>;
  outputTarget: DirectorPlatform | "unknown";
  /** Per-axis provenance — axes are set independently (clarification #2). */
  sources: Record<ContextAxis, ContextSource>;
  /**
   * Axes the user explicitly pinned. Redundant with `sources.* === "user"` on
   * write, but kept separate so a future detection pass can distinguish "the
   * user picked this" from "the user picked this AND said never change it".
   * Phase 1 treats `sources.* === "user"` as locked either way.
   */
  userLocked?: ContextAxis[];
  /**
   * Coarse modality timeline (camera / screen / mixed). OPTIONAL and unused in
   * Phase 1 — the field exists now so hybrid support is a data change, not a
   * schema migration. Every policy read goes through `policyAt(t)` so segment
   * awareness lands without touching call sites.
   */
  segments?: ModalitySegment[];
}

/** All-unknown profile — what a project has before anyone says or detects anything. */
export function defaultContentProfile(): ContentProfile {
  return {
    version: 1,
    primaryIntent: "unknown",
    intentConfidence: 0,
    contentModes: {},
    outputTarget: "unknown",
    sources: { intent: "default", modes: "default", target: "default" },
  };
}

/**
 * Expand the legacy user shortcut into context priors. The picker's choice IS a
 * user classification of the source, so every axis it implies is stamped
 * `user`; axes it says nothing about stay `default` for detection to fill.
 *
 * The mapping mirrors what each SelectedVideoType has always meant to the
 * recipes: talking-head/podcast/vlog are camera footage, screen-recording is
 * screen pixels, product-demo is a demo (mostly screen), tutorial is an intent
 * with UNKNOWN modality (tutorials are legitimately either), reels-shorts is a
 * distribution format with unknown intent/modality.
 */
export function contextFromSelectedVideoType(
  selected: SelectedVideoType | undefined
): ContentProfile {
  const base = defaultContentProfile();
  const user = (over: Partial<ContentProfile>, axes: ContextAxis[]): ContentProfile => ({
    ...base,
    ...over,
    intentConfidence: axes.includes("intent") ? 1 : base.intentConfidence,
    sources: {
      intent: axes.includes("intent") ? "user" : "default",
      modes: axes.includes("modes") ? "user" : "default",
      target: axes.includes("target") ? "user" : "default",
    },
  });

  switch (selected) {
    case "talking-head":
      return user({ contentModes: { camera: 1 } }, ["modes"]);
    case "screen-recording":
      return user({ contentModes: { screen: 1 } }, ["modes"]);
    case "product-demo":
      return user(
        { primaryIntent: "demo", contentModes: { screen: 0.8, camera: 0.2 } },
        ["intent", "modes"]
      );
    case "tutorial":
      // Intent only — a tutorial's modality is genuinely unknown until detected.
      return user({ primaryIntent: "tutorial" }, ["intent"]);
    case "podcast-clip":
      return user(
        { primaryIntent: "conversation", contentModes: { camera: 1 } },
        ["intent", "modes"]
      );
    case "vlog":
      return user(
        { primaryIntent: "story", contentModes: { camera: 1 } },
        ["intent", "modes"]
      );
    case "ad-promo":
      return user({ primaryIntent: "promo" }, ["intent"]);
    case "reels-shorts":
      // A distribution format, not a content classification. Target-only.
      return user({ outputTarget: "shorts" }, ["target"]);
    case "auto":
    default:
      return base;
  }
}

/** The mode carrying the largest duration share ("other" when nothing is known). */
export function dominantMode(profile: ContentProfile): ContentMode {
  let best: ContentMode = "other";
  let bestShare = 0;
  for (const mode of CONTENT_MODES) {
    const share = profile.contentModes[mode] ?? 0;
    if (share > bestShare) {
      best = mode;
      bestShare = share;
    }
  }
  return best;
}

/** Duration share of a mode, 0..1 (0 when unknown). */
export function modeShare(profile: ContentProfile, mode: ContentMode): number {
  const share = profile.contentModes[mode];
  return typeof share === "number" && Number.isFinite(share)
    ? Math.max(0, Math.min(1, share))
    : 0;
}

/** True when the video has (or may have) any screen content at all. */
export function mayContainMode(profile: ContentProfile, mode: ContentMode): boolean {
  // An unknown modes axis means "we don't know yet" — the answer is then
  // "maybe", never "no". Only a concrete modes classification can rule a
  // mode out.
  if (profile.sources.modes === "default") return true;
  return modeShare(profile, mode) > 0;
}

export interface DetectedContext {
  primaryIntent?: PrimaryIntent;
  intentConfidence?: number;
  contentModes?: Partial<Record<ContentMode, number>>;
  outputTarget?: DirectorPlatform;
  segments?: ModalitySegment[];
}

/**
 * Fold a detection result into a profile. Per-axis: a `user` axis (or one in
 * `userLocked`) is NEVER overwritten — detection refines only what the user
 * left open. Segments are modality data, so they ride the `modes` axis lock.
 */
export function mergeDetectedContext(
  profile: ContentProfile,
  detected: DetectedContext
): ContentProfile {
  const locked = (axis: ContextAxis): boolean =>
    profile.sources[axis] === "user" || (profile.userLocked ?? []).includes(axis);

  const next: ContentProfile = { ...profile, sources: { ...profile.sources } };

  if (!locked("intent") && detected.primaryIntent && detected.primaryIntent !== "unknown") {
    next.primaryIntent = detected.primaryIntent;
    next.intentConfidence = Math.max(
      0,
      Math.min(1, detected.intentConfidence ?? 0.5)
    );
    next.sources.intent = "detected";
  }
  if (!locked("modes") && detected.contentModes) {
    next.contentModes = { ...detected.contentModes };
    next.sources.modes = "detected";
    if (detected.segments) next.segments = detected.segments;
  }
  if (!locked("target") && detected.outputTarget) {
    next.outputTarget = detected.outputTarget;
    next.sources.target = "detected";
  }
  return next;
}

/** Coerce arbitrary Firestore data into a valid profile (or undefined). */
export function normalizeContentProfile(raw: unknown): ContentProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<ContentProfile>;
  if (r.version !== 1) return undefined;
  const base = defaultContentProfile();
  const src = (v: unknown): ContextSource =>
    v === "detected" || v === "user" ? v : "default";
  const intent: PrimaryIntent = PRIMARY_INTENTS.includes(
    r.primaryIntent as PrimaryIntent
  )
    ? (r.primaryIntent as PrimaryIntent)
    : "unknown";
  const modes: Partial<Record<ContentMode, number>> = {};
  if (r.contentModes && typeof r.contentModes === "object") {
    for (const mode of CONTENT_MODES) {
      const v = (r.contentModes as Record<string, unknown>)[mode];
      if (typeof v === "number" && Number.isFinite(v)) {
        modes[mode] = Math.max(0, Math.min(1, v));
      }
    }
  }
  return {
    ...base,
    primaryIntent: intent,
    intentConfidence:
      typeof r.intentConfidence === "number"
        ? Math.max(0, Math.min(1, r.intentConfidence))
        : 0,
    contentModes: modes,
    outputTarget: ((): ContentProfile["outputTarget"] => {
      const value = (raw as Record<string, unknown>).outputTarget;
      return typeof value === "string" && value.length > 0
        ? (value as ContentProfile["outputTarget"])
        : "unknown";
    })(),
    sources: {
      intent: src(r.sources?.intent),
      modes: src(r.sources?.modes),
      target: src(r.sources?.target),
    },
    ...(Array.isArray(r.userLocked)
      ? {
          userLocked: r.userLocked.filter(
            (a): a is ContextAxis => a === "intent" || a === "modes" || a === "target"
          ),
        }
      : {}),
    ...(Array.isArray(r.segments) ? { segments: r.segments } : {}),
  };
}
