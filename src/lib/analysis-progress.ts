/**
 * Analysis-progress model — the modern, video-type-aware progress copy shown
 * while Framevo generates an AI edit. Pure + framework-neutral (type-only
 * imports) so it's unit-testable and shared by the processing overlay.
 *
 * Framevo is no longer a screen-recording zoom editor: the steps + headline are
 * generic by default and only use cursor/click/interaction language for the
 * Screen Recording type. Steps are FILTERED by the run's generation options so
 * we never claim to generate something the user turned off.
 */
import type { AnalysisOptions } from "@/lib/analysis/engine-layers";
import type {
  AnalysisActivityEvent,
  DetectedMoment,
  EffectType,
  SelectedVideoType,
} from "@/lib/firebase/schema";

export interface ProgressStep {
  id: string;
  label: string;
}

/** Normalized "is this generation category on?" reads (absent overlay = on). */
interface GenFlags {
  camera: boolean;
  cut: boolean;
  speed: boolean;
  captions: boolean;
  hook: boolean;
  text: boolean;
  smartCrop: boolean;
  callouts: boolean;
  transitions: boolean;
  cta: boolean;
  /**
   * Whether the Director will run. NOT derivable from `AnalysisOptions` alone —
   * options can only SUPPRESS the brief (`applyDirectorBrief: false`); whether one
   * exists at all is a property of the project. The caller supplies it.
   */
  director: boolean;
}

function flags(
  o: AnalysisOptions | null | undefined,
  directing: boolean | undefined
): GenFlags {
  return {
    camera: o?.generateCameraEdits !== false,
    cut: o?.generateCut !== false,
    speed: o?.generateSpeed !== false,
    captions: o?.generateCaptions !== false,
    hook: o?.generateHookText !== false,
    text: o?.generateTextOverlays !== false,
    smartCrop: o?.generateSmartCrop !== false,
    callouts: o?.generateCallouts !== false,
    transitions: o?.generateTransitions !== false,
    cta: o?.generateCta !== false,
    director: directing === true && o?.applyDirectorBrief !== false,
  };
}

interface StepTemplate {
  id: string;
  base: string;
  gate: (g: GenFlags) => boolean;
  /** Video-type-specific label overrides (product copy per §7). */
  byType?: Partial<Record<SelectedVideoType, string>>;
}

const STEP_TEMPLATES: StepTemplate[] = [
  { id: "prepare", base: "Preparing video", gate: () => true },
  {
    id: "scenes",
    base: "Analyzing scenes",
    gate: () => true,
    byType: {
      "screen-recording": "Analyzing interactions",
      "product-demo": "Finding product moments",
      "reels-shorts": "Finding strong moments",
      "ad-promo": "Finding strong moments",
      tutorial: "Finding steps",
      "talking-head": "Analyzing speech",
      "podcast-clip": "Finding the best moments",
    },
  },
  { id: "audio", base: "Reading audio", gate: () => true },
  {
    id: "transcribe",
    base: "Transcribing speech",
    // Only when captions (the transcript's main consumer) are on.
    gate: (g) => g.captions,
    byType: { "talking-head": "Analyzing speech", "podcast-clip": "Analyzing speech" },
  },
  { id: "recipe", base: "Applying edit recipe", gate: () => true },
  {
    id: "cuts",
    base: "Generating cuts",
    gate: (g) => g.cut,
    byType: { "talking-head": "Cleaning pacing", "podcast-clip": "Cleaning pacing" },
  },
  {
    id: "zooms",
    base: "Generating zooms & focus",
    gate: (g) => g.camera,
    byType: {
      "screen-recording": "Finding clicks and focus moments",
      "product-demo": "Highlighting key actions",
      "talking-head": "Centering the speaker",
    },
  },
  { id: "speed", base: "Generating speed changes", gate: (g) => g.speed },
  {
    id: "captions",
    base: "Generating captions",
    gate: (g) => g.captions,
    byType: {
      "reels-shorts": "Preparing captions",
      "talking-head": "Preparing captions",
      tutorial: "Preparing captions",
      "podcast-clip": "Preparing captions",
    },
  },
  {
    id: "hook",
    base: "Generating hook text",
    gate: (g) => g.hook,
    byType: { "reels-shorts": "Creating hook text", "ad-promo": "Creating hook text" },
  },
  {
    id: "text",
    base: "Generating text overlays",
    gate: (g) => g.text,
    byType: { tutorial: "Adding explanation labels", "product-demo": "Adding action labels" },
  },
  {
    id: "smartcrop",
    base: "Generating smart crop",
    gate: (g) => g.smartCrop,
    byType: {
      "reels-shorts": "Reframing for social",
      "ad-promo": "Reframing for social",
      "talking-head": "Centering the speaker",
    },
  },
  {
    id: "callouts",
    base: "Generating callouts",
    gate: (g) => g.callouts,
    byType: {
      "product-demo": "Adding callouts",
      "screen-recording": "Adding zooms and callouts",
      tutorial: "Adding callouts",
    },
  },
  { id: "cta", base: "Generating CTA", gate: (g) => g.cta },
  { id: "transitions", base: "Generating transitions", gate: (g) => g.transitions },
  { id: "timeline", base: "Adding selected edits to the timeline", gate: () => true },
  // Only when the user actually wrote a brief — otherwise this step would sit
  // there permanently unticked on every plain analysis, implying a stage failed.
  { id: "director", base: "Directing your video", gate: (g) => g.director },
  { id: "finalize", base: "Finalizing AI edit", gate: () => true },
];

/**
 * Build the ordered, filtered step list for a run. Only steps relevant to the
 * selected generation options appear, and labels are tailored to the video type.
 */
export function buildProgressSteps(input: {
  videoType: SelectedVideoType;
  options: AnalysisOptions | null | undefined;
  /** True when the project has a Director brief this run will apply. */
  directing?: boolean;
}): ProgressStep[] {
  const g = flags(input.options, input.directing);
  return STEP_TEMPLATES.filter((t) => t.gate(g)).map((t) => ({
    id: t.id,
    label: t.byType?.[input.videoType] ?? t.base,
  }));
}

/** The headline + subtitle — generic by default, interaction-flavored for Screen Recording. */
export function progressHeadline(videoType: SelectedVideoType): {
  headline: string;
  subtitle: string;
} {
  const headline = "Generating your AI edit…";
  if (videoType === "screen-recording") {
    return { headline, subtitle: "Analyzing interactions, clicks, scenes, and the edit recipe." };
  }
  return {
    headline,
    subtitle: "Analyzing the video, audio, transcript, scenes, and the edit recipe.",
  };
}

/** Every timeline effect type is a real edit — count them ALL, not just zooms. */
const EDIT_EFFECT_TYPES: ReadonlySet<EffectType> = new Set<EffectType>([
  "zoom",
  "click-highlight",
  "cursor-focus",
  "speed-up",
  "cut",
  "crop",
  "captions",
  "hook-text",
  "text-overlay",
  "smart-crop",
  "callout",
  "blur-redaction",
  "transition",
  "branding-cta",
]);

/** Count generated edits across ALL types (cuts, zooms, speeds, captions, overlays, …). */
export function countGeneratedEdits(moments: DetectedMoment[] | undefined | null): number {
  if (!moments) return 0;
  return moments.reduce((n, m) => (EDIT_EFFECT_TYPES.has(m.effectType) ? n + 1 : n), 0);
}

/** The "N edits generated so far" progress-card line (product copy per §4). */
export function editsProgressLine(count: number): string {
  return count > 0
    ? `${count} edit${count === 1 ? "" : "s"} generated so far — you can review them while analysis continues.`
    : "Preparing your selected AI edits. Completed edits will appear on the timeline as they are generated.";
}

// ── Activity log — product-friendly labels; technical stays under details ────

/**
 * Rename rules → product-friendly labels (§5). A renamed line is considered
 * FRIENDLY (shown), so these take precedence over the technical filter below.
 */
const ACTIVITY_RENAMES: { test: RegExp; label: string }[] = [
  { test: /^downloaded video/i, label: "Video prepared" },
  { test: /uploading.*gemini|uploaded.*file id|using inline video/i, label: "Preparing AI analysis" },
  { test: /finished extracting frames/i, label: "Scenes ready" },
  { test: /gemini proposed \d+ visual moment/i, label: "Found key moments" },
  { test: /asking gemini to label|labell?ed \d+ moment/i, label: "Refining edits" },
  { test: /^transcribing/i, label: "Transcript processing started" },
];

/** Un-renamed infra/technical lines — hidden from the feed (kept under details). */
const TECHNICAL_ACTIVITY = /gemini|files api|file id|inline video|extracting frames|state:/i;

/**
 * Director lines are ALWAYS user-facing, whatever they contain.
 *
 * They are the record of decisions made on the user's behalf — which designs were
 * chosen, what was applied, what couldn't be. Without this they'd be filtered by
 * the technical rule the moment a message happened to mention the model (e.g.
 * "Director planned without the model (gemini timeout)"), which is exactly the
 * line the user most needs to see.
 */
const DIRECTOR_ACTIVITY = /^director\b|^applying your director/i;

export interface FriendlyActivity {
  ts: number;
  kind: AnalysisActivityEvent["kind"];
  label: string;
  /** True when this is a technical/infra line (shown only under Processing details). */
  technical: boolean;
}

/** Map a raw activity event to a friendly label + a `technical` flag. */
export function mapActivity(e: AnalysisActivityEvent): FriendlyActivity {
  const raw = e.text ?? "";
  const rename = ACTIVITY_RENAMES.find((r) => r.test.test(raw));
  if (rename) return { ts: e.ts, kind: e.kind, label: rename.label, technical: false };
  // Director decisions are shown verbatim — never renamed, never hidden.
  if (DIRECTOR_ACTIVITY.test(raw)) {
    return { ts: e.ts, kind: e.kind, label: raw, technical: false };
  }
  return { ts: e.ts, kind: e.kind, label: raw, technical: TECHNICAL_ACTIVITY.test(raw) };
}

/** The user-facing activity feed — friendly labels, technical lines removed (kept for details). */
export function friendlyActivityFeed(activity: AnalysisActivityEvent[]): FriendlyActivity[] {
  const out: FriendlyActivity[] = [];
  for (const e of activity) {
    const m = mapActivity(e);
    if (m.technical) continue;
    // Collapse consecutive duplicate labels (e.g. the two upload lines both
    // rename to "Preparing AI analysis") — keep the latest kind for that label.
    const prev = out[out.length - 1];
    if (prev && prev.label === m.label) {
      prev.kind = m.kind;
      continue;
    }
    out.push(m);
  }
  return out;
}
