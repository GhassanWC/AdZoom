/**
 * Analyze-dialog structure — pure config so the separation rule is testable:
 * CAPTIONS ARE NOT AN "AI VIDEO EDIT". They're a transcription feature with
 * their own quota, language, background processing, and failure modes. The AI
 * edit bulk actions (Select all / Disable extras / recipe reset of the grid)
 * never touch the captions toggle.
 *
 * NOTE: the dialog no longer renders a captions section at all — captions are
 * generated only by the dedicated "Generate AI Captions" action, and the modal
 * STRIPS `generateCaptions` from its payload so analysis can never start ASR.
 * `CAPTIONS_TOGGLE` below stays as the structural record of that separation
 * (tests/caption-separation.test.ts pins the rule against it); it is spec, not
 * rendered UI.
 */
import type { GenerationToggles } from "./edit-recipe";

export interface AnalyzeToggleSpec {
  key: keyof GenerationToggles;
  label: string;
  description: string;
  /** Extra honesty note shown while the toggle is ON. */
  note?: string;
}

/**
 * The AI VIDEO EDITS grid — every automatic edit type EXCEPT captions.
 * (Captions live in their own section; see CAPTIONS_TOGGLE.)
 */
export const AI_EDIT_GROUPS: { title: string; items: AnalyzeToggleSpec[] }[] = [
  {
    title: "AI edits",
    items: [
      { key: "generateHookText", label: "Hook text", description: "Add a strong opening line in the first seconds." },
      { key: "generateTextOverlays", label: "Text overlays", description: "Label key moments with on-screen text." },
      { key: "generateCta", label: "CTA / end card", description: "Add an end-card call to action." },
    ],
  },
  {
    title: "Visual focus",
    items: [
      { key: "generateCameraEdits", label: "Zooms & focus", description: "Add zooms, focus moments, and camera emphasis." },
      { key: "generateSmartCrop", label: "Smart crop", description: "Reframe the video for social formats." },
      { key: "generateCallouts", label: "Callouts", description: "Point at the parts of the frame that matter." },
    ],
  },
  {
    title: "Pacing",
    items: [
      { key: "generateCut", label: "Cuts", description: "Remove boring, idle, loading, or dead sections." },
      { key: "generateSpeed", label: "Speed changes", description: "Speed up slow, idle, or loading sections." },
      { key: "generateTransitions", label: "Transitions", description: "Add transitions around strong cuts." },
    ],
  },
];

/** Every AI-edit toggle key (captions deliberately absent). */
export const AI_EDIT_TOGGLE_KEYS: (keyof GenerationToggles)[] = AI_EDIT_GROUPS.flatMap(
  (g) => g.items.map((i) => i.key)
);

/**
 * Keys "Disable extras" turns off — overlay/extra AI edits only. The core
 * engines stay on, and CAPTIONS ARE NOT INCLUDED: they're an independent
 * transcription choice, not an "extra".
 */
export const AI_EDIT_EXTRA_KEYS: (keyof GenerationToggles)[] = [
  "generateHookText",
  "generateTextOverlays",
  "generateCta",
  "generateSmartCrop",
  "generateCallouts",
  "generateTransitions",
];

/**
 * The captions toggle SPEC — deliberately absent from every rendered group.
 * Not UI: it exists so the separation rule ("captions are never an AI edit")
 * stays a testable structural fact rather than tribal knowledge.
 */
export const CAPTIONS_TOGGLE: AnalyzeToggleSpec = {
  key: "generateCaptions",
  label: "Generate captions",
  description: "Transcribe the video's speech and add subtitle captions.",
  note: "Requires transcription. If unavailable, captions will be skipped — every other edit still generates.",
};
