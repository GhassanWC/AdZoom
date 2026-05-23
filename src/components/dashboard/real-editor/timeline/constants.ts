import {
  Sparkles,
  MousePointer2,
  Target,
  FastForward,
  Zap,
  Brain,
  Hand,
  Cpu,
  User,
  Pointer,
  RefreshCcw,
  type LucideIcon,
} from "lucide-react";
import type {
  EffectType,
  MomentProvenance,
  NarrativeRole,
} from "@/lib/firebase/schema";

export const EFFECT_ICONS: Record<EffectType, LucideIcon> = {
  zoom: Zap,
  "click-highlight": Target,
  "cursor-focus": MousePointer2,
  "speed-up": FastForward,
};

/**
 * Narrative roles → cinematic chapter colours. Each gradient feels like a
 * Netflix chapter marker rather than a debug pill: warm for action/result,
 * cool for setup/explanation, neutral for transition/filler.
 */
export const NARRATIVE_COLORS: Record<NarrativeRole, string> = {
  intro: "from-cyan-400/35 to-cyan-500/15",
  setup: "from-indigo-400/40 to-violet-500/20",
  action: "from-violet-500/55 to-fuchsia-500/25",
  explanation: "from-emerald-400/40 to-emerald-500/15",
  result: "from-amber-400/55 to-orange-500/20",
  transition: "from-white/15 to-white/[0.04]",
  filler: "from-white/[0.05] to-transparent",
};

export const NARRATIVE_TEXT: Record<NarrativeRole, string> = {
  intro: "text-cyan-100",
  setup: "text-indigo-100",
  action: "text-violet-50",
  explanation: "text-emerald-100",
  result: "text-amber-50",
  transition: "text-white/70",
  filler: "text-white/55",
};

/**
 * Names users see — "Intro", "Discovery", "Focus", "Action", "Decision",
 * "Result". Cinematic, not technical.
 */
export const NARRATIVE_LABEL: Record<NarrativeRole, string> = {
  intro: "Intro",
  setup: "Discovery",
  action: "Action",
  explanation: "Focus",
  result: "Result",
  transition: "Bridge",
  filler: "Quiet",
};

/**
 * Per-effect colour tokens for pills. Body gradients are richer than the
 * old "calm" mix so important moments dominate visually. The `accent` is the
 * left bar that signals AI vs user at a glance.
 */
export const EFFECT_TONES: Record<
  EffectType,
  {
    ai: string;
    user: string;
    dot: string;
    label: string;
    /** Static shadow utility — apply when selected/dragging. */
    glow: string;
    /**
     * Hover-prefixed variant of `glow`. Kept separate so Tailwind's content
     * scan sees the full `hover:shadow-[…]` class literal and emits it.
     * Concatenating `hover:` + a runtime string would NOT generate the rule.
     */
    hoverGlow: string;
  }
> = {
  zoom: {
    ai: "from-violet-500/85 via-violet-500/60 to-violet-600/40 border-violet-300/40",
    user: "from-cyan-400/80 via-cyan-400/55 to-sky-500/40 border-cyan-200/50",
    dot: "bg-violet-300",
    label: "Zoom",
    glow: "shadow-[0_8px_36px_-12px_rgba(139,92,246,0.95)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(139,92,246,0.95)]",
  },
  "click-highlight": {
    ai: "from-fuchsia-500/85 via-fuchsia-500/55 to-violet-600/40 border-fuchsia-300/40",
    user: "from-cyan-400/80 via-fuchsia-400/55 to-fuchsia-500/40 border-cyan-200/50",
    dot: "bg-fuchsia-300",
    label: "Click",
    glow: "shadow-[0_8px_36px_-12px_rgba(217,70,239,0.85)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(217,70,239,0.85)]",
  },
  "cursor-focus": {
    ai: "from-indigo-400/85 via-indigo-500/55 to-violet-600/40 border-indigo-200/40",
    user: "from-cyan-400/80 via-indigo-400/55 to-indigo-500/40 border-cyan-200/50",
    dot: "bg-indigo-300",
    label: "Focus",
    glow: "shadow-[0_8px_36px_-12px_rgba(129,140,248,0.85)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(129,140,248,0.85)]",
  },
  "speed-up": {
    ai: "from-amber-400/85 via-amber-400/60 to-orange-500/40 border-amber-200/50",
    user: "from-cyan-400/80 via-amber-400/55 to-amber-500/40 border-cyan-200/50",
    dot: "bg-amber-300",
    label: "Speed",
    glow: "shadow-[0_8px_36px_-12px_rgba(251,191,36,0.85)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(251,191,36,0.85)]",
  },
};

/**
 * Provenance visual system. Every detection source has its own icon,
 * gradient, dot, short label, and hover blurb so the user can trust where an
 * edit came from at a glance.
 */
export const PROVENANCE_PRESENTATION: Record<
  MomentProvenance,
  {
    label: string;
    short: string;
    Icon: LucideIcon;
    dot: string;
    chip: string;
    text: string;
    blurb: string;
  }
> = {
  event: {
    label: "Real interaction",
    short: "Click",
    Icon: Pointer,
    dot: "bg-emerald-400",
    chip: "border-emerald-400/40 bg-emerald-500/15 text-emerald-100",
    text: "text-emerald-100",
    blurb: "Derived from a real interaction event captured in your recording.",
  },
  cv: {
    label: "Motion",
    short: "Motion",
    Icon: Cpu,
    dot: "bg-sky-400",
    chip: "border-sky-400/40 bg-sky-500/15 text-sky-100",
    text: "text-sky-100",
    blurb: "Inferred from on-device motion + scene-change analysis.",
  },
  ai: {
    label: "AI",
    short: "AI",
    Icon: Brain,
    dot: "bg-violet-400",
    chip: "border-violet-400/45 bg-violet-500/15 text-violet-100",
    text: "text-violet-100",
    blurb: "Gemini suggestion — added to fill a coverage gap.",
  },
  "ai-override": {
    label: "AI rebalance",
    short: "Rebalance",
    Icon: RefreshCcw,
    dot: "bg-fuchsia-400",
    chip: "border-fuchsia-400/45 bg-fuchsia-500/15 text-fuchsia-100",
    text: "text-fuchsia-100",
    blurb: "AI overrode a low-confidence interaction here.",
  },
  user: {
    label: "Your edit",
    short: "You",
    Icon: Hand,
    dot: "bg-amber-300",
    chip: "border-amber-300/40 bg-amber-400/15 text-amber-100",
    text: "text-amber-100",
    blurb: "You created this moment manually.",
  },
};

/** Convenience re-export — covers icons commonly used inline. */
export const PROVENANCE_LEGEND_EXTRA = { Sparkles, User } as const;

/** Pointer snap-to-magnet threshold in pixels. */
export const SNAP_PX = 7;
/** Pointer movement below this counts as a click, not a drag. */
export const CLICK_PX = 4;
/** Smallest allowed moment length (seconds) — prevents resize-to-zero. */
export const MIN_MOMENT_LEN = 0.3;

/**
 * Cinematic track heights. The AI/user rows are tall enough to show a
 * thumbnail strip + title + reasoning + intensity micro-bar without crowding.
 */
export const TRACK_HEIGHTS = {
  ai: 96,
  user: 84,
  ruler: 36,
  gap: 22,
  /** Narrative chapter strip — the cinematic "act" band above the lane. */
  chapters: 56,
  /** Attention waveform layer drawn behind the AI track. */
  attention: 96,
} as const;

/** Width of the static left label gutter (px). */
export const GUTTER_WIDTH = 128;
