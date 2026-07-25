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
  Crop,
  Scissors,
  Captions,
  Type,
  Frame,
  Megaphone,
  EyeOff,
  Shuffle,
  BadgeCheck,
  Clapperboard,
  type LucideIcon,
} from "lucide-react";
import type {
  DetectedMoment,
  EffectType,
  MomentProvenance,
  NarrativeRole,
} from "@/lib/firebase/schema";

export const EFFECT_ICONS: Record<EffectType, LucideIcon> = {
  zoom: Zap,
  "click-highlight": Target,
  "cursor-focus": MousePointer2,
  "speed-up": FastForward,
  cut: Scissors,
  crop: Crop,
  // Phase 3 — Core AI Edit Pack.
  captions: Captions,
  "hook-text": Sparkles,
  "text-overlay": Type,
  "smart-crop": Frame,
  callout: Megaphone,
  "blur-redaction": EyeOff,
  transition: Shuffle,
  "branding-cta": BadgeCheck,
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
    user: "from-amber-400/85 via-amber-400/60 to-orange-500/40 border-amber-200/50",
    dot: "bg-amber-300",
    label: "Speed",
    glow: "shadow-[0_8px_36px_-12px_rgba(251,191,36,0.85)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(251,191,36,0.85)]",
  },
  cut: {
    ai: "from-rose-500/85 via-rose-500/55 to-red-600/40 border-rose-300/45",
    user: "from-rose-500/85 via-rose-500/55 to-red-600/40 border-rose-300/50",
    dot: "bg-rose-300",
    label: "Cut",
    glow: "shadow-[0_8px_36px_-12px_rgba(244,63,94,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(244,63,94,0.9)]",
  },
  crop: {
    ai: "from-teal-400/85 via-teal-500/55 to-emerald-600/40 border-teal-200/40",
    user: "from-teal-400/85 via-teal-500/55 to-emerald-600/40 border-teal-200/45",
    dot: "bg-teal-300",
    label: "Crop / Reframe",
    glow: "shadow-[0_8px_36px_-12px_rgba(45,212,191,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(45,212,191,0.9)]",
  },
  // ── Phase 3 — Core AI Edit Pack overlays. Distinct colour families so the
  // overlay lane reads clearly against the camera/cut/speed lanes. ──
  captions: {
    ai: "from-sky-400/85 via-sky-500/55 to-blue-600/40 border-sky-200/40",
    user: "from-sky-400/85 via-sky-500/55 to-blue-600/40 border-sky-200/50",
    dot: "bg-sky-300",
    label: "Captions",
    glow: "shadow-[0_8px_36px_-12px_rgba(56,189,248,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(56,189,248,0.9)]",
  },
  "hook-text": {
    ai: "from-pink-500/85 via-pink-500/55 to-rose-600/40 border-pink-300/40",
    user: "from-pink-500/85 via-pink-500/55 to-rose-600/40 border-pink-300/50",
    dot: "bg-pink-300",
    label: "Hook Text",
    glow: "shadow-[0_8px_36px_-12px_rgba(236,72,153,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(236,72,153,0.9)]",
  },
  "text-overlay": {
    ai: "from-blue-400/85 via-blue-500/55 to-indigo-600/40 border-blue-200/40",
    user: "from-blue-400/85 via-blue-500/55 to-indigo-600/40 border-blue-200/50",
    dot: "bg-blue-300",
    label: "Text",
    glow: "shadow-[0_8px_36px_-12px_rgba(96,165,250,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(96,165,250,0.9)]",
  },
  "smart-crop": {
    ai: "from-emerald-400/85 via-emerald-500/55 to-green-600/40 border-emerald-200/40",
    user: "from-emerald-400/85 via-emerald-500/55 to-green-600/40 border-emerald-200/50",
    dot: "bg-emerald-300",
    label: "Smart Crop",
    glow: "shadow-[0_8px_36px_-12px_rgba(52,211,153,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(52,211,153,0.9)]",
  },
  callout: {
    ai: "from-orange-400/85 via-orange-500/55 to-amber-600/40 border-orange-200/40",
    user: "from-orange-400/85 via-orange-500/55 to-amber-600/40 border-orange-200/50",
    dot: "bg-orange-300",
    label: "Callout",
    glow: "shadow-[0_8px_36px_-12px_rgba(251,146,60,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(251,146,60,0.9)]",
  },
  "blur-redaction": {
    ai: "from-slate-400/85 via-slate-500/55 to-slate-700/40 border-slate-200/40",
    user: "from-slate-400/85 via-slate-500/55 to-slate-700/40 border-slate-200/50",
    dot: "bg-slate-300",
    label: "Blur",
    glow: "shadow-[0_8px_36px_-12px_rgba(148,163,184,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(148,163,184,0.9)]",
  },
  transition: {
    ai: "from-purple-400/85 via-purple-500/55 to-violet-700/40 border-purple-200/40",
    user: "from-purple-400/85 via-purple-500/55 to-violet-700/40 border-purple-200/50",
    dot: "bg-purple-300",
    label: "Transition",
    glow: "shadow-[0_8px_36px_-12px_rgba(192,132,252,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(192,132,252,0.9)]",
  },
  "branding-cta": {
    ai: "from-lime-400/85 via-lime-500/55 to-green-600/40 border-lime-200/40",
    user: "from-lime-400/85 via-lime-500/55 to-green-600/40 border-lime-200/50",
    dot: "bg-lime-300",
    label: "CTA",
    glow: "shadow-[0_8px_36px_-12px_rgba(163,230,53,0.9)]",
    hoverGlow: "hover:shadow-[0_8px_36px_-12px_rgba(163,230,53,0.9)]",
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

/**
 * AI Director edits get their OWN presentation, distinct from the generic "AI"
 * provenance chip.
 *
 * Why not just add a `MomentProvenance` member: provenance answers "which SIGNAL
 * produced this" (a click, motion, Gemini), and a Director edit's signal is still
 * one of those — what's different is WHO decided to place it. So a Director zoom
 * grounded in a real click keeps `provenance: "ai"` (correct for the balancer and
 * the carry-over logic), and the Director identity rides on `source`, which is
 * what this presentation keys off. Adding a provenance member would also have
 * silently changed the behaviour of every `Record<MomentProvenance, …>` in the
 * app.
 */
export const DIRECTOR_PRESENTATION = {
  label: "AI Director",
  short: "Director",
  Icon: Clapperboard,
  dot: "bg-fuchsia-400",
  chip: "border-fuchsia-400/50 bg-fuchsia-500/20 text-fuchsia-50",
  text: "text-fuchsia-100",
  blurb:
    "Created by the AI Director from your prompt. Move, resize, split, disable or delete it like any other edit.",
} as const;

/** True when this edit was placed by the AI Director. */
export function isDirectorEdit(m: Pick<DetectedMoment, "source">): boolean {
  return m.source === "ai-director";
}

/**
 * The identity chip a pill should show. Director edits win over provenance —
 * "the Director put this here" is the more useful fact when you're deciding
 * whether to keep it.
 */
export function presentationFor(
  m: Pick<DetectedMoment, "source" | "provenance">
): (typeof PROVENANCE_PRESENTATION)[MomentProvenance] | typeof DIRECTOR_PRESENTATION {
  if (isDirectorEdit(m)) return DIRECTOR_PRESENTATION;
  if (m.provenance) return PROVENANCE_PRESENTATION[m.provenance];
  if (m.source === "user") return PROVENANCE_PRESENTATION.user;
  return PROVENANCE_PRESENTATION.ai;
}

/** Convenience re-export — covers icons commonly used inline. */
export const PROVENANCE_LEGEND_EXTRA = { Sparkles, User } as const;

/** Pointer snap-to-magnet threshold in pixels. */
export const SNAP_PX = 7;
/** Pointer movement below this counts as a click, not a drag. */
export const CLICK_PX = 4;
/** Smallest allowed moment length (seconds) — prevents resize-to-zero. */
export const MIN_MOMENT_LEN = 0.3;

/**
 * Minimum rendered width (px) for a moment clip / chapter. A short clip (e.g. a
 * 1.6s CV zoom on a long video) is a tiny % of the timeline, so a pure `%`
 * width turns it into a hairline "marker". This px floor keeps real-duration
 * clips reading as blocks while longer ones still scale by `(end-start)/total`.
 */
export const MIN_PILL_PX = 34;
/**
 * Fallback clip length (seconds) when a moment's duration is missing/zero/NaN —
 * it still renders as a small block instead of collapsing to nothing.
 */
export const MIN_RENDER_DURATION = 0.5;

/**
 * Cinematic track heights.
 *
 * Vertical space is the timeline's scarcest resource — every pixel spent on
 * chrome is a pixel not spent on an edit lane. EVERY edit lane — camera/zoom
 * included — is now a single compact row of the same height, so a short zoom
 * reads as a horizontal chip like every other edit rather than a tall vertical
 * bar. There is deliberately NO group-header height any more: lane groups are a
 * data concept (see laneModel.ts), not a row that eats 30px in both columns.
 */
export const TRACK_HEIGHTS = {
  /** Legacy tall-lane height. The camera/zoom lane now uses `overlay` like every
   *  other edit lane; kept for reference / any future opt-in tall view. */
  ai: 84,
  user: 84,
  /** Compact height for the cut/speed + per-type overlay lanes (keeps the taller
   *  stack of lanes readable without a huge vertical footprint). */
  overlay: 44,
  ruler: 36,
  gap: 22,
  /** Narrative chapter strip — the cinematic "act" band above the lane. */
  chapters: 56,
  /** Attention waveform layer drawn behind the AI track. */
  attention: 84,
  /** Read-only cursor / click / focus marker lane. */
  interactions: 40,
  /** Future-feature placeholder lanes (speed / crop) — dimmed, non-interactive. */
  placeholder: 40,
} as const;

/*
 * There is deliberately NO gutter width constant. The left label column is gone:
 * lanes and the ruler both start at x=0, so time — not a classifier — owns every
 * pixel of the timeline's width. Re-introducing a width here would be the first
 * step back toward a column that has to stay pixel-aligned with the lanes, the
 * ruler and the playhead.
 */
