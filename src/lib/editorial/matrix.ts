/**
 * Gate A — context validity. "Is this edit valid for this kind of video?"
 *
 * Two small tables plus a combination rule, per the approved Revision-2
 * semantics: THE MATRIX IS A PRIOR; EVIDENCE IS THE VERDICT.
 *
 *   • MODALITY_REQUIREMENTS — what an edit PHYSICALLY needs. The only source
 *     of "impossible", and even then it is COMPUTED per video ("unavailable:
 *     no cursor evidence in this video"), never authored per category. Blur is
 *     deliberately unrestricted (faces/plates on camera footage are real
 *     redaction targets); B-roll is unrestricted (disabled-by-default is a
 *     PRIOR, not a law).
 *
 *   • INTENT_PRIORS + TARGET_MODIFIERS — the editorial DEFAULTS per axis.
 *     Phase 1 consumes these for reporting + the cursor-emphasis gate;
 *     Phase 2's template surfacing builds on them.
 *
 * Pure data + pure functions. No I/O.
 */
import type { RecipeSignals } from "@/lib/analysis/edit-recipe";
import type { DirectorPlatform } from "@/lib/director/types";
import {
  mayContainMode,
  type ContentMode,
  type ContentProfile,
  type PrimaryIntent,
} from "./context";
import type { AuthorableStatus, EditCategoryId } from "./policy";

// ── Physical requirements ───────────────────────────────────────────────────

export interface ModalityRequirement {
  /** The video must (possibly) contain this mode. */
  needsMode?: ContentMode;
  /** At least one of these signals must exist for the edit to be meaningful. */
  needsEvidence?: ReadonlyArray<"cursor" | "transcript" | "speech">;
  /** Human sentence used when the requirement is unmeetable. */
  unavailableReason: string;
}

/**
 * Only entries with a REAL physical requirement appear here. Everything else
 * has none — a status prior may discourage it, but nothing forbids it.
 */
export const MODALITY_REQUIREMENTS: Partial<
  Record<EditCategoryId, ModalityRequirement>
> = {
  cursor_emphasis: {
    needsMode: "screen",
    needsEvidence: ["cursor"],
    unavailableReason:
      "unavailable: no screen content or cursor evidence in this video — there is no cursor to emphasise",
  },
  captions: {
    needsEvidence: ["transcript"],
    unavailableReason: "unavailable: no transcript yet — captions are never invented",
  },
  silence_removal: {
    needsEvidence: ["speech"],
    unavailableReason:
      "unavailable: no usable speech with removable silence detected yet",
  },
};

/** The evidence actually present for this video, derived from run signals. */
export interface EvidenceSignals {
  /** Real interaction stream OR CV cursor tracking produced usable cursor data. */
  hasCursorEvidence: boolean;
  hasTranscript: boolean;
  hasUsableSpeech: boolean;
}

export function evidenceFromSignals(s: RecipeSignals): EvidenceSignals {
  return {
    // Tab-scope interactions and the CV cursor tracker both count; the recipe's
    // hasInteractionData flag is the existing conservative proxy for either.
    hasCursorEvidence: s.hasInteractionData || s.isScreenRecording,
    hasTranscript: s.hasTranscript,
    hasUsableSpeech: s.hasUsableSpeech && s.silenceSegmentCount > 0,
  };
}

/**
 * The computed "impossible": returns the reason this category is unmeetable for
 * this video, or null when it is (possibly) meetable. An unknown modality axis
 * never rules an edit out — `mayContainMode` answers "maybe" for unknowns, so
 * detection improving later can only ever OPEN categories, not strand them.
 */
export function unavailableReason(
  category: EditCategoryId,
  profile: ContentProfile,
  evidence: EvidenceSignals
): string | null {
  const req = MODALITY_REQUIREMENTS[category];
  if (!req) return null;
  if (req.needsMode && !mayContainMode(profile, req.needsMode)) {
    // The mode is ruled out — but hard evidence still wins (e.g. the user
    // called it a talking head, yet real cursor data exists: a hybrid).
    const evidenceMet =
      req.needsEvidence?.some((e) =>
        e === "cursor"
          ? evidence.hasCursorEvidence
          : e === "transcript"
            ? evidence.hasTranscript
            : evidence.hasUsableSpeech
      ) ?? false;
    if (!evidenceMet) return req.unavailableReason;
  }
  if (req.needsEvidence && req.needsEvidence.length > 0) {
    const met = req.needsEvidence.some((e) =>
      e === "cursor"
        ? evidence.hasCursorEvidence
        : e === "transcript"
          ? evidence.hasTranscript
          : evidence.hasUsableSpeech
    );
    if (!met) return req.unavailableReason;
  }
  return null;
}

// ── Editorial priors ────────────────────────────────────────────────────────

/**
 * Status priors by PRIMARY INTENT. These are defaults a template starts from,
 * not enforcement — Phase 1 uses them for reporting and template surfacing;
 * the shipped Classic templates keep reproducing recipe behaviour regardless.
 */
export const INTENT_PRIORS: Record<
  PrimaryIntent,
  Partial<Record<EditCategoryId, AuthorableStatus>>
> = {
  tutorial: {
    captions: "core",
    text_overlay: "core",
    callout: "allowed",
    zoom: "encouraged",
    cut: "allowed",
    speed: "discouraged",
    freeze_frame: "encouraged",
    cursor_emphasis: "allowed",
    silence_removal: "encouraged",
  },
  demo: {
    zoom: "core",
    cursor_emphasis: "core",
    callout: "encouraged",
    text_overlay: "encouraged",
    captions: "allowed",
    cut: "encouraged",
    speed: "encouraged",
    blur_redaction: "allowed",
  },
  promo: {
    hook_text: "core",
    cut: "core",
    zoom: "encouraged",
    captions: "encouraged",
    transition: "encouraged",
    branding: "core",
    smart_crop: "encouraged",
    speed: "allowed",
    music: "encouraged",
  },
  conversation: {
    silence_removal: "core",
    captions: "core",
    cut: "core",
    text_overlay: "allowed",
    smart_crop: "encouraged",
    branding: "allowed",
    zoom: "disabled-by-default",
    transition: "discouraged",
    speed: "discouraged",
    music: "disabled-by-default",
  },
  story: {
    cut: "core",
    speed: "encouraged",
    transition: "core",
    music: "core",
    smart_crop: "allowed",
    captions: "allowed",
    zoom: "disabled-by-default",
    broll_overlay: "encouraged",
  },
  unknown: {},
};

/** Status promotions by output target (a short vertical feed changes priorities). */
export const TARGET_MODIFIERS: Partial<
  Record<DirectorPlatform, Partial<Record<EditCategoryId, AuthorableStatus>>>
> = {
  tiktok: { smart_crop: "core", captions: "core", hook_text: "core" },
  reels: { smart_crop: "core", captions: "core", hook_text: "core" },
  shorts: { smart_crop: "core", captions: "core", hook_text: "core" },
  linkedin: { captions: "encouraged", branding: "allowed" },
};
