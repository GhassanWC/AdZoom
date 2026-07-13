/**
 * The Framevo preset registry — the shipped library.
 *
 * WHAT THIS IS
 * A frozen list of `FramevoPreset` DATA. Each entry is a `TextStyle` + a
 * `PresetAnimation` + a layout intent. `apply.ts` compiles one into an ordinary
 * `DetectedMoment`, and `overlay-draw.ts` paints it. There is no preset renderer.
 *
 * WHERE THE DESIGNS CAME FROM
 * Most are ports of MIT-licensed Remotion templates (see THIRD_PARTY_LICENSES.md
 * at the repo root for the full table, the licence text and the pinned commits).
 * NO upstream CODE is used here. The upstream templates are React components that
 * animate JSX with `useCurrentFrame()` + `interpolate()` + `spring()`; Framevo
 * draws overlays on a 2D canvas that four render paths share (editor preview,
 * browser exporter, Cloud Run worker, Remotion renderer). A vendored React
 * component would render in exactly one of those and be invisible in the other
 * three — including every real export.
 *
 * So each design was READ, its motion characterised (entrance curve, offsets,
 * timing, stagger, typography, plate treatment), and RE-EXPRESSED as the numbers
 * below. Where a design depends on something the canvas text path genuinely
 * cannot do — per-glyph colour, RGB channel split, SVG rings, clip-paths,
 * non-uniform squash, image assets — the attribution `note` says so plainly
 * rather than pretending the port is exact.
 *
 * DETERMINISM
 * Several upstream templates call `Math.random()` per frame. That is reproduced
 * NOWHERE. Every chaotic look here uses `loop: { kind: "glitch" | "shake" }`,
 * which `evaluateAnimation` drives from a seeded hash of a quantized frame index
 * — so the exported file matches the preview the user approved, frame for frame.
 *
 * UNITS (all resolution-independent, so 1080p preview == 4K export)
 *   fontScale      fraction of canvas height
 *   translateX/Y   fraction of canvas width / height
 *   blur           fraction of canvas height
 *   letterSpacing / padding / stroke / shadow   fractions of font size
 *
 * Pure data. No React, no I/O.
 */
import type { TextStyle } from "../firebase/schema";
import type { FramevoPreset, PresetCategory, PresetTone } from "./types";

/**
 * Shared plate/shadow recipes.
 *
 * These are the two treatments that make text survive being drawn OVER VIDEO —
 * the thing every upstream template got for free by owning the whole frame with
 * a flat `#111827` background, and which we do not get. A caption with no plate
 * and no outline is unreadable the moment the shot behind it goes bright, so the
 * ports add one deliberately; it is the single most common adaptation in here.
 */
const READABLE_SHADOW: Partial<TextStyle> = {
  shadow: true,
  shadowColor: "#000000",
  shadowOpacity: 0.6,
  shadowBlur: 0.34,
  shadowOffsetX: 0,
  shadowOffsetY: 0.04,
};

const DARK_PLATE: Partial<TextStyle> = {
  background: "box",
  backgroundColor: "#000000",
  backgroundOpacity: 0.68,
  paddingX: 0.6,
  paddingY: 0.32,
  borderRadius: 0.22,
};

export const PRESETS: readonly FramevoPreset[] = Object.freeze([
  // ══════════════════════════════════════════════════════════════════════════
  // CAPTIONS
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "caption-bold-pop",
    name: "Bold Pop",
    category: "captions",
    description: "Heavy outlined caps that pop in word by word.",
    effectType: "captions",
    tone: "energetic",
    tags: ["caption", "pop", "bold", "social", "tiktok", "outline", "punchy"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.058,
      fontWeight: 900,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.05,
      lineHeight: 1.18,
      background: "none",
      strokeColor: "#000000",
      strokeWidth: 0.09,
      ...READABLE_SHADOW,
    },
    animation: {
      // Upstream springs each CHARACTER in with mass 0.4 / damping 8 — an
      // under-damped curve that overshoots. `back-out` is the closed-form
      // equivalent, and `reveal: word` carries the stagger (per-glyph transforms
      // are not available: the canvas draws a line as one block).
      in: { durationSeconds: 0.35, ease: "back-out", scale: [0.5, 1], opacity: [0, 1] },
      reveal: { kind: "word", durationSeconds: 0.6 },
    },
    placement: "bottom",
    maxWidthFraction: 0.9,
    defaultDurationSeconds: 2.5,
    defaultText: "Your caption here",
    aspects: {
      // Vertical needs BIGGER text than the 0.62 default: a phone-sized caption
      // that reads on a desktop preview is unreadable in a feed.
      "9:16": { fontScaleMultiplier: 0.78, maxWidthFraction: 0.98 },
      "1:1": { fontScaleMultiplier: 0.9 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/popping-text.tsx",
      license: "MIT",
      note: "Per-unit spring pop entrance (mass 0.4 / damping 8) + heavy outlined caps; the per-character stagger is re-expressed as a word reveal, and the outline is inverted to black-on-white so it stays legible over video.",
    },
  },
  {
    id: "caption-word-highlight",
    name: "Word Highlight",
    category: "captions",
    description: "Words arrive one at a time on an accent highlight plate.",
    effectType: "captions",
    tone: "energetic",
    tags: ["caption", "highlight", "karaoke", "word", "accent", "sequential"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.05,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.3,
      background: "box",
      backgroundColor: "#3b82f6",
      backgroundOpacity: 0.88,
      paddingX: 0.42,
      paddingY: 0.22,
      borderRadius: 0.16,
      shadow: true,
      shadowColor: "#1e3a8a",
      shadowOpacity: 0.5,
      shadowBlur: 0.4,
      shadowOffsetX: 0,
      shadowOffsetY: 0.05,
    },
    animation: {
      in: { durationSeconds: 0.25, ease: "ease-out", opacity: [0, 1], translateY: [0.012, 0] },
      reveal: { kind: "word", durationSeconds: 0.9 },
    },
    placement: "bottom",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 3,
    defaultText: "Your caption here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.74, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.88 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/text-highlight.tsx",
      license: "MIT",
      note: "Sequential word-by-word highlight at ~0.6s per word, on a blue/violet accent plate. Upstream sweeps a plate across each word individually; the canvas draws a line as one block, so the sweep becomes one highlight plate behind the progressively revealed text.",
    },
  },
  {
    id: "caption-typewriter",
    name: "Typewriter",
    category: "captions",
    description: "Monospace subtitle typed out character by character.",
    effectType: "captions",
    tone: "minimal",
    tags: ["caption", "typewriter", "mono", "code", "typed", "terminal"],
    textStyle: {
      preset: "minimal",
      fontFamily: "mono",
      fontScale: 0.042,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.35,
      background: "box",
      backgroundColor: "#0b1120",
      backgroundOpacity: 0.72,
      paddingX: 0.55,
      paddingY: 0.3,
      borderRadius: 0.14,
      shadow: false,
    },
    animation: {
      // Upstream types ~5 frames per character (0.15 chars/frame at 30fps ≈ 4.5
      // chars/sec). `typewriter` is the reveal that cuts mid-word, which is the
      // look. The blinking block cursor is NOT reproduced — the canvas text path
      // has no per-frame trailing glyph.
      in: { durationSeconds: 0.2, ease: "ease-out", opacity: [0, 1] },
      reveal: { kind: "typewriter", durationSeconds: 1.6 },
    },
    placement: "bottom",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 3.5,
    defaultText: "Your caption here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.72, maxWidthFraction: 0.98 },
      "1:1": { fontScaleMultiplier: 0.86 },
    },
    attribution: {
      source: "clippkit",
      file: "apps/docs/registry/default/components/typing-text.tsx",
      license: "MIT",
      note: "Monospace character-by-character typing at ~5 frames per character. The blinking cursor is dropped (not expressible on the canvas text path).",
    },
  },
  {
    id: "caption-clean-lift",
    name: "Clean Lift",
    category: "captions",
    description: "A readable pill caption that lifts gently into place.",
    effectType: "captions",
    tone: "professional",
    tags: ["caption", "clean", "pill", "readable", "subtle", "default"],
    textStyle: {
      preset: "clean",
      fontFamily: "sans",
      fontScale: 0.05,
      fontWeight: 600,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0,
      lineHeight: 1.25,
      background: "pill",
      backgroundColor: "#000000",
      backgroundOpacity: 0.55,
      paddingX: 0.55,
      paddingY: 0.28,
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.3, ease: "ease-out", opacity: [0, 1], translateY: [0.014, 0] },
      out: { durationSeconds: 0.22, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "bottom",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 2.5,
    defaultText: "Your caption here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.74, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.88 },
    },
    attribution: { source: "framevo" },
  },
  {
    id: "caption-minimal-fade",
    name: "Minimal Fade",
    category: "captions",
    description: "No plate, no noise — just clean text that fades in.",
    effectType: "captions",
    tone: "minimal",
    tags: ["caption", "minimal", "plain", "documentary", "quiet", "no-plate"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.045,
      fontWeight: 600,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.005,
      lineHeight: 1.3,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.25, ease: "ease-out", opacity: [0, 1] },
      out: { durationSeconds: 0.25, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "bottom",
    maxWidthFraction: 0.84,
    defaultDurationSeconds: 2.5,
    defaultText: "Your caption here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.72, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.86 },
    },
    attribution: { source: "framevo" },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TITLES
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "title-cinematic-rise",
    name: "Cinematic Rise",
    category: "titles",
    description: "A tracked title that rises and settles, film-trailer style.",
    effectType: "text-overlay",
    tone: "cinematic",
    tags: ["title", "cinematic", "rise", "trailer", "elegant", "film"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.075,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.05,
      lineHeight: 1.15,
      background: "none",
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.55,
      shadowBlur: 0.45,
      shadowOffsetX: 0,
      shadowOffsetY: 0.05,
    },
    animation: {
      // Upstream: titleY springs 50px → 0 (damping 14, mass 0.8) over ~40 frames
      // while opacity springs in over 30. 50/1080 ≈ 0.046 of canvas height.
      in: { durationSeconds: 1, ease: "spring", translateY: [0.046, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.5, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3.5,
    defaultText: "Your title here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.68, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.84 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/cinematic-title-intro.tsx",
      license: "MIT",
      note: "Spring rise from +50px (damping 14 / mass 0.8) with a fade, at 0.05em tracking. The growing gradient underline rule and the delayed subtitle line are dropped — the canvas overlay draws one text block, not a composed card.",
    },
  },
  {
    id: "title-split-converge",
    name: "Split Converge",
    category: "titles",
    description: "Wide-tracked caps that converge and tighten into a locked title.",
    effectType: "text-overlay",
    tone: "cinematic",
    tags: ["title", "split", "converge", "tracking", "caps", "bold", "glow"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.072,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.15,
      lineHeight: 1.2,
      background: "none",
      shadow: true,
      shadowColor: "#3b82f6",
      shadowOpacity: 0.65,
      shadowBlur: 0.5,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      // Upstream slides a stroke-only top line DOWN from -120px and a solid
      // bottom line UP from +120px so they meet, then glows. The canvas applies
      // ONE transform to the whole block, so two lines cannot travel in opposite
      // directions. The convergence is carried instead by the tracking collapsing
      // from very wide to the design's 0.15em — the same "letters arriving into
      // formation" read — plus a short settle. The blue glow survives as the
      // text shadow.
      in: {
        durationSeconds: 0.9,
        ease: "spring",
        letterSpacing: [0.3, 0],
        translateY: [0.03, 0],
        opacity: [0, 1],
      },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 3.5,
    defaultText: "Your title here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.6, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.8 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/title-split.tsx",
      license: "MIT",
      note: "Two-line converge at 0.15em tracking with a blue glow. The opposing per-line travel and the stroke-only top line are not expressible (one transform, one fill per block) — re-expressed as a tracking collapse into the same locked-caps look.",
    },
  },
  {
    id: "title-bounce-in",
    name: "Bounce In",
    category: "titles",
    description: "A plated title that slides in and bounces to a stop.",
    effectType: "text-overlay",
    tone: "playful",
    tags: ["title", "bounce", "spring", "plate", "slide", "energetic"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.068,
      fontWeight: 900,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.15,
      background: "box",
      backgroundColor: "#1e3a8a",
      backgroundOpacity: 0.94,
      paddingX: 0.55,
      paddingY: 0.34,
      borderRadius: 0.3,
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.35,
      shadowBlur: 0.4,
      shadowOffsetX: 0,
      shadowOffsetY: 0.08,
    },
    animation: {
      // Upstream: the plate scales 0.5 → 0.8 while the text inside slides in from
      // -100% (both springs, damping 100 / stiffness 200 — heavily damped, so it
      // arrives firmly rather than wobbling). The nested transforms collapse into
      // one: the block scales up AND travels in from the left.
      in: {
        durationSeconds: 0.7,
        ease: "spring",
        translateX: [-0.32, 0],
        scale: [0.62, 1],
        opacity: [0, 1],
      },
      out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3,
    defaultText: "Your title here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.62, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/bounce-text.tsx",
      license: "MIT",
      note: "Spring slide-in from the left inside a scaling rounded plate (damping 100 / stiffness 200). The upstream gradient plate becomes a solid navy plate — the canvas plate fill is a single colour.",
    },
  },
  {
    id: "title-slide-in",
    name: "Slide In",
    category: "titles",
    description: "A clean title that springs in from the side and settles.",
    effectType: "text-overlay",
    tone: "professional",
    tags: ["title", "slide", "spring", "clean", "simple", "lower-energy"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.066,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.2,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      // Upstream default: initialOffset 200px, damping 12 / mass 0.5 /
      // stiffness 100 over 30 frames — a light overshoot. 200/1920 ≈ 0.104 of
      // canvas width, entering from the right.
      in: { durationSeconds: 1, ease: "spring", translateX: [0.104, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.82,
    defaultDurationSeconds: 3,
    defaultText: "Your title here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.64, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "clippkit",
      file: "apps/docs/registry/default/components/sliding-text.tsx",
      license: "MIT",
      note: "Directional spring slide from a 200px offset (damping 12 / mass 0.5 / stiffness 100) with a fade.",
    },
  },
  {
    id: "title-glitch",
    name: "Glitch",
    category: "titles",
    description: "A monospace title that stutters and tears like a bad signal.",
    effectType: "text-overlay",
    tone: "energetic",
    tags: ["title", "glitch", "mono", "cyberpunk", "distort", "tech", "stutter"],
    textStyle: {
      preset: "neon",
      fontFamily: "mono",
      fontScale: 0.07,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.06,
      lineHeight: 1.2,
      background: "none",
      // The cyan bloom stands in for the upstream cyan/magenta channel split.
      shadow: true,
      shadowColor: "#22d3ee",
      shadowOpacity: 0.7,
      shadowBlur: 0.4,
      shadowOffsetX: 0.02,
      shadowOffsetY: 0,
    },
    animation: {
      in: { durationSeconds: 0.18, ease: "ease-out", opacity: [0, 1] },
      // SEEDED, not random. Both upstream versions drive the tear from
      // Math.sin(frame) and (in clippkit's sporadic mode) Math.random() — the
      // latter would make the export differ from the approved preview, so the
      // deterministic `glitch` loop replaces it.
      loop: { kind: "glitch", amount: 0.7, periodSeconds: 0.35 },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 2.5,
    defaultText: "Your title here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.6, maxWidthFraction: 0.98 },
      "1:1": { fontScaleMultiplier: 0.8 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/glitch-text.tsx",
      license: "MIT",
      note: "Monospace bold caps with a sine-driven positional tear. The cyan/magenta RGB channel split is not expressible (the canvas text path has one fill per draw) — it becomes a cyan bloom, and the tear is driven by the seeded glitch loop rather than Math.random(), which clippkit's variant of this design uses.",
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // HOOKS
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "hook-impact-pop",
    name: "Impact Pop",
    category: "hooks",
    description: "A huge outlined statement that slams onto the screen.",
    effectType: "hook-text",
    tone: "energetic",
    tags: ["hook", "impact", "pop", "big", "shorts", "attention", "scroll-stopper"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.1,
      fontWeight: 900,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.03,
      lineHeight: 1.08,
      background: "none",
      strokeColor: "#000000",
      strokeWidth: 0.1,
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.5,
      shadowBlur: 0.35,
      shadowOffsetX: 0,
      shadowOffsetY: 0.05,
    },
    animation: {
      in: { durationSeconds: 0.45, ease: "back-out", scale: [0.3, 1], opacity: [0, 1] },
      out: { durationSeconds: 0.3, ease: "ease-in", opacity: [1, 0], scale: [1, 1.06] },
    },
    placement: "center",
    maxWidthFraction: 0.9,
    defaultDurationSeconds: 2.5,
    defaultText: "Your hook here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.66, maxWidthFraction: 0.98 },
      "1:1": { fontScaleMultiplier: 0.84 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/popping-text.tsx",
      license: "MIT",
      note: "The overshooting spring scale-pop entrance (mass 0.4 / damping 8) at display size. The upstream per-character colour cycling is not expressible (one fill per draw) — the design keeps its heavy outlined display caps in a single colour.",
    },
  },
  {
    id: "hook-bubble-pop",
    name: "Bubble Pop",
    category: "hooks",
    description: "A rounded bubble that pops open letter by letter.",
    effectType: "hook-text",
    tone: "playful",
    tags: ["hook", "bubble", "pop", "playful", "rounded", "fun", "kids"],
    textStyle: {
      preset: "shadow",
      fontFamily: "sans",
      fontScale: 0.078,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.04,
      lineHeight: 1.2,
      background: "pill",
      backgroundColor: "#1e3a8a",
      backgroundOpacity: 0.92,
      paddingX: 0.5,
      paddingY: 0.3,
      shadow: true,
      shadowColor: "#3b82f6",
      shadowOpacity: 0.5,
      shadowBlur: 0.5,
      shadowOffsetX: 0,
      shadowOffsetY: 0.08,
    },
    animation: {
      in: { durationSeconds: 0.45, ease: "back-out", scale: [0, 1], opacity: [0, 1] },
      reveal: { kind: "char", durationSeconds: 0.55 },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 2.5,
    defaultText: "Your hook here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.64, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/bubble-pop-text.tsx",
      license: "MIT",
      note: "Character-by-character spring pop (damping 8 / mass 0.3 / stiffness 100) inside a rounded glowing bubble. Upstream gives EACH character its own circular bubble; the canvas plate is per-line, so the row of bubbles becomes one pill and the stagger is carried by a char reveal.",
    },
  },
  {
    id: "hook-char-tumble",
    name: "Char Tumble",
    category: "hooks",
    description: "Text tumbles in, spinning upright as it lands.",
    effectType: "hook-text",
    tone: "playful",
    tags: ["hook", "tumble", "rotate", "spin", "drop", "character", "kinetic"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.085,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.15,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      // Upstream springs each char from y -50px and rotate -180° (mass 0.5,
      // damping 10-12) with a 5-frame stagger. The canvas rotates the BLOCK, not
      // each glyph, so the tumble reads as one body — the `char` reveal keeps the
      // staggered arrival.
      in: {
        durationSeconds: 0.6,
        ease: "spring",
        translateY: [-0.046, 0],
        rotate: [-180, 0],
        opacity: [0, 1],
      },
      reveal: { kind: "char", durationSeconds: 0.7 },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 2.5,
    defaultText: "Your hook here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.64, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/animated-text.tsx",
      license: "MIT",
      note: "Character reveal springing from -50px and -180° of rotation (mass 0.5 / damping 10-12, 5-frame stagger). The rotation is applied to the text block rather than per glyph — the canvas has one transform per draw.",
    },
  },
  {
    id: "hook-pulse-emphasis",
    name: "Pulse",
    category: "hooks",
    description: "A line that keeps breathing so the eye can't leave it.",
    effectType: "hook-text",
    tone: "energetic",
    tags: ["hook", "pulse", "breathe", "emphasis", "loop", "attention"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.088,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.04,
      lineHeight: 1.15,
      background: "none",
      shadow: true,
      shadowColor: "#ffffff",
      shadowOpacity: 0.35,
      shadowBlur: 0.6,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      in: { durationSeconds: 0.35, ease: "back-out", scale: [0.7, 1], opacity: [0, 1] },
      // Upstream pulses scale 1 → 1.2 → 1 on a 30-frame (1s) cycle. The shared
      // `pulse` loop is deliberately gentler (it caps at ~6% so text never
      // strobes), so this is the same rhythm at a calmer amplitude.
      loop: { kind: "pulse", amount: 1, periodSeconds: 1 },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 3,
    defaultText: "Your hook here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.64, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/pulsing-text.tsx",
      license: "MIT",
      note: "Continuous scale + opacity pulse on a 1-second cycle with a soft glow. The upstream per-character phase offset and blurred glow disc behind each glyph are not expressible — the pulse runs on the block and the glow becomes a text shadow.",
    },
  },
  {
    id: "hook-shake-alert",
    name: "Shake Alert",
    category: "hooks",
    description: "Wide-tracked caps that rattle with impact.",
    effectType: "hook-text",
    tone: "energetic",
    tags: ["hook", "shake", "impact", "alert", "urgent", "rattle", "warning"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.082,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.15,
      lineHeight: 1.2,
      background: "box",
      backgroundColor: "#0b1120",
      backgroundOpacity: 0.6,
      paddingX: 0.5,
      paddingY: 0.3,
      borderRadius: 0.2,
      shadow: true,
      shadowColor: "#3b82f6",
      shadowOpacity: 0.45,
      shadowBlur: 0.55,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      in: { durationSeconds: 0.3, ease: "back-out", scale: [0.8, 1], opacity: [0, 1] },
      // Upstream builds an "organic" shake from sin(f*0.8) / cos(f*1.1) with a
      // DECAYING amplitude. `LoopSpec` has no decay envelope, so this is a
      // constant seeded rattle — chaotic-looking but frame-stable at any fps.
      loop: { kind: "shake", amount: 0.75, periodSeconds: 0.2 },
    },
    placement: "center",
    maxWidthFraction: 0.86,
    defaultDurationSeconds: 2,
    defaultText: "Your hook here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.62, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.8 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/camera-shake.tsx",
      license: "MIT",
      note: "Impact rattle behind wide-tracked caps (0.15em) on a bordered card. Upstream's multi-frequency sine shake decays over the shot; the shared loop has no decay envelope, so this is a constant seeded shake instead.",
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CTAs
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "cta-subscribe-pill",
    name: "Subscribe Pill",
    category: "ctas",
    description: "A floating corner pill that rises in and keeps pulsing.",
    effectType: "text-overlay",
    tone: "professional",
    tags: ["cta", "subscribe", "pill", "corner", "reminder", "follow", "youtube"],
    textStyle: {
      preset: "clean",
      fontFamily: "sans",
      fontScale: 0.034,
      fontWeight: 600,
      color: "#ffffff",
      align: "right",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.25,
      background: "pill",
      backgroundColor: "#000000",
      backgroundOpacity: 0.78,
      paddingX: 0.7,
      paddingY: 0.35,
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.4,
      shadowBlur: 0.5,
      shadowOffsetX: 0,
      shadowOffsetY: 0.08,
    },
    animation: {
      // Upstream slides the pill up 100px (spring, damping 14 / stiffness 100)
      // and pulses the bell icon on a sin(f*0.15) cycle (~1.4s). The icon isn't
      // expressible, so the pulse moves to the pill itself.
      in: { durationSeconds: 0.7, ease: "spring", translateY: [0.09, 0], opacity: [0, 1] },
      loop: { kind: "pulse", amount: 0.4, periodSeconds: 1.4 },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0], translateY: [0, 0.05] },
    },
    placement: "bottom-right",
    maxWidthFraction: 0.5,
    defaultDurationSeconds: 4,
    defaultText: "Subscribe",
    aspects: {
      // On 9:16 the bottom-RIGHT corner is where TikTok/Reels stack the like,
      // comment and share rail. A pill parked there is half-covered by the
      // platform's own chrome, so the vertical adaptation moves it to the centre.
      "9:16": { placement: "bottom", fontScaleMultiplier: 0.72, maxWidthFraction: 0.9 },
      "1:1": { fontScaleMultiplier: 0.86 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/subscribe-reminder.tsx",
      license: "MIT",
      note: "Corner pill rising 100px on a spring (damping 14 / stiffness 100) with a slow pulse. The bell icon and the @handle sub-line are dropped (no asset system, one text block per overlay).",
    },
  },
  {
    id: "cta-button-glow",
    name: "Glowing Button",
    category: "ctas",
    description: "A solid call-to-action button that eases in and glows.",
    effectType: "branding-cta",
    tone: "professional",
    tags: ["cta", "button", "glow", "action", "convert", "click", "end-card"],
    textStyle: {
      preset: "clean",
      fontFamily: "sans",
      fontScale: 0.04,
      fontWeight: 600,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.05,
      lineHeight: 1.2,
      background: "box",
      backgroundColor: "#4361ee",
      backgroundOpacity: 0.96,
      paddingX: 0.9,
      paddingY: 0.45,
      borderRadius: 0.22,
      shadow: true,
      shadowColor: "#7209b7",
      shadowOpacity: 0.6,
      shadowBlur: 0.7,
      shadowOffsetX: 0,
      shadowOffsetY: 0.06,
    },
    animation: {
      in: { durationSeconds: 0.8, ease: "spring", scale: [0.8, 1], opacity: [0, 1] },
      loop: { kind: "pulse", amount: 0.45, periodSeconds: 2.4 },
    },
    placement: "bottom",
    maxWidthFraction: 0.7,
    defaultDurationSeconds: 4,
    defaultText: "Your call to action",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.78 },
      "1:1": { fontScaleMultiplier: 0.9 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/end-card.tsx",
      license: "MIT",
      note: "The end-card's action button: a gradient plate with a delayed spring fade-in and a sin(f*0.08) glow cycle. The gradient becomes a solid indigo fill with a violet bloom — the canvas plate takes one colour.",
    },
  },
  {
    id: "cta-swipe-up",
    name: "Swipe Up",
    category: "ctas",
    description: "A bottom prompt that floats to invite the swipe.",
    effectType: "branding-cta",
    tone: "energetic",
    tags: ["cta", "swipe", "float", "shorts", "stories", "prompt", "vertical"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.038,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.08,
      lineHeight: 1.2,
      background: "pill",
      backgroundColor: "#000000",
      backgroundOpacity: 0.6,
      paddingX: 0.8,
      paddingY: 0.4,
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.5, ease: "back-out", scale: [0.85, 1], opacity: [0, 1] },
      loop: { kind: "float", amount: 0.9, periodSeconds: 1.8 },
    },
    placement: "bottom",
    maxWidthFraction: 0.7,
    defaultDurationSeconds: 3.5,
    defaultText: "Swipe up",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.8 },
      "1:1": { fontScaleMultiplier: 0.9 },
    },
    attribution: { source: "framevo" },
  },
  {
    id: "cta-link-in-bio",
    name: "Quiet Link",
    category: "ctas",
    description: "An understated bottom bar that names where to go next.",
    effectType: "branding-cta",
    tone: "minimal",
    tags: ["cta", "link", "bio", "minimal", "quiet", "understated", "bar"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.03,
      fontWeight: 500,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.06,
      lineHeight: 1.2,
      background: "box",
      backgroundColor: "#0b1120",
      backgroundOpacity: 0.62,
      paddingX: 0.9,
      paddingY: 0.4,
      borderRadius: 0.12,
      shadow: false,
    },
    animation: {
      in: { durationSeconds: 0.5, ease: "ease-out", opacity: [0, 1], translateY: [0.02, 0] },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "bottom",
    maxWidthFraction: 0.66,
    defaultDurationSeconds: 4,
    defaultText: "Link in bio",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.78 },
      "1:1": { fontScaleMultiplier: 0.9 },
    },
    attribution: { source: "framevo" },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // CALLOUTS
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "callout-lower-third",
    name: "Lower Third",
    category: "callouts",
    description: "News-style name bar that slides in from the left.",
    effectType: "text-overlay",
    tone: "professional",
    tags: ["callout", "lower-third", "name", "news", "broadcast", "interview", "speaker"],
    textStyle: {
      preset: "clean",
      fontFamily: "sans",
      fontScale: 0.042,
      fontWeight: 700,
      color: "#ffffff",
      align: "left",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.3,
      background: "box",
      backgroundColor: "#000000",
      backgroundOpacity: 0.72,
      paddingX: 0.7,
      paddingY: 0.35,
      borderRadius: 0.08,
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.4,
      shadowBlur: 0.4,
      shadowOffsetX: 0,
      shadowOffsetY: 0.06,
    },
    animation: {
      // Upstream: an accent rule slides from -300px, then the plate follows from
      // -400px (spring, damping 14 / mass 0.7), then the text fades in 15 frames
      // later. -400/1920 ≈ -0.21 of canvas width.
      in: { durationSeconds: 0.9, ease: "spring", translateX: [-0.21, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0], translateX: [0, -0.05] },
    },
    placement: "bottom-left",
    maxWidthFraction: 0.62,
    defaultDurationSeconds: 4,
    defaultText: "Name · Role",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.76, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.88, maxWidthFraction: 0.8 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/lower-third.tsx",
      license: "MIT",
      note: "Staggered slide-in from -400px on a spring (damping 14 / mass 0.7) behind a dark plate. The blue accent rule and left edge-bar are dropped — the overlay renderer draws text plus its own plate, not composed shapes.",
    },
  },
  {
    id: "callout-notification",
    name: "Notification",
    category: "callouts",
    description: "A toast card that snaps in from the right edge.",
    effectType: "text-overlay",
    tone: "playful",
    tags: ["callout", "notification", "toast", "card", "alert", "message", "popup"],
    textStyle: {
      preset: "clean",
      fontFamily: "sans",
      fontScale: 0.034,
      fontWeight: 600,
      color: "#ffffff",
      align: "left",
      uppercase: false,
      letterSpacing: 0,
      lineHeight: 1.35,
      background: "box",
      backgroundColor: "#1f2937",
      backgroundOpacity: 0.92,
      paddingX: 0.75,
      paddingY: 0.45,
      borderRadius: 0.3,
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.45,
      shadowBlur: 0.6,
      shadowOffsetX: 0,
      shadowOffsetY: 0.1,
    },
    animation: {
      // Upstream: spring damping 14 / stiffness 180 / mass 0.6, translateX
      // 300 → 0 (300/1920 ≈ 0.156), staggered across three stacked toasts.
      in: { durationSeconds: 0.6, ease: "spring", translateX: [0.156, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0], translateX: [0, 0.06] },
    },
    placement: "bottom-right",
    maxWidthFraction: 0.5,
    defaultDurationSeconds: 3,
    defaultText: "Your note here",
    aspects: {
      "9:16": { placement: "upper-third", fontScaleMultiplier: 0.76, maxWidthFraction: 0.92 },
      "1:1": { fontScaleMultiplier: 0.88, maxWidthFraction: 0.7 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/notification-pop.tsx",
      license: "MIT",
      note: "Toast slide-in from +300px on a spring (damping 14 / stiffness 180 / mass 0.6). The stack of three, the avatar disc and the unread badge are dropped — one moment is one card, and there is no asset system.",
    },
  },
  {
    id: "callout-quote-serif",
    name: "Quote",
    category: "callouts",
    description: "A serif pull-quote that fades up and holds.",
    effectType: "text-overlay",
    tone: "calm",
    tags: ["callout", "quote", "serif", "pull-quote", "testimonial", "editorial", "calm"],
    textStyle: {
      preset: "minimal",
      fontFamily: "serif",
      fontScale: 0.044,
      fontWeight: 400,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.6,
      background: "none",
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.55,
      shadowBlur: 0.5,
      shadowOffsetX: 0,
      shadowOffsetY: 0.05,
    },
    animation: {
      in: { durationSeconds: 0.7, ease: "ease-out", opacity: [0, 1], translateY: [0.022, 0] },
      out: { durationSeconds: 0.5, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.72,
    defaultDurationSeconds: 5,
    defaultText: "Your quote here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.72, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.86, maxWidthFraction: 0.86 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/quote-card.tsx",
      license: "MIT",
      note: "Serif quotation at 1.6 line-height, fading up in a staged sequence. The oversized opening quote-mark glyph and the separately-animated attribution line are dropped — the overlay is one text block.",
    },
  },
  {
    id: "callout-float-chip",
    name: "Floating Chip",
    category: "callouts",
    description: "A rounded label that bobs gently in place.",
    effectType: "text-overlay",
    tone: "playful",
    tags: ["callout", "chip", "float", "label", "bob", "tag", "badge"],
    textStyle: {
      preset: "shadow",
      fontFamily: "sans",
      fontScale: 0.04,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.25,
      background: "box",
      backgroundColor: "#1e3a8a",
      backgroundOpacity: 0.93,
      paddingX: 0.75,
      paddingY: 0.42,
      borderRadius: 0.35,
      shadow: true,
      shadowColor: "#1e3a8a",
      shadowOpacity: 0.45,
      shadowBlur: 0.7,
      shadowOffsetX: 0,
      shadowOffsetY: 0.12,
    },
    animation: {
      // Upstream: spring scale-in (damping 12 / mass 0.5) then a sin(f/30) bob —
      // a 60-frame (2s) cycle at 30fps.
      in: { durationSeconds: 0.6, ease: "spring", scale: [0.4, 1], opacity: [0, 1] },
      loop: { kind: "float", amount: 0.9, periodSeconds: 2 },
      out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0], scale: [1, 0.9] },
    },
    placement: "upper-third",
    maxWidthFraction: 0.6,
    defaultDurationSeconds: 3.5,
    defaultText: "Your label here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.74, maxWidthFraction: 0.9 },
      "1:1": { fontScaleMultiplier: 0.88 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/floating-bubble-text.tsx",
      license: "MIT",
      note: "Spring scale-in (damping 12 / mass 0.5) plus a 2-second sine bob on a rounded plate. The rotating gradient border is not expressible on the canvas plate.",
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSITIONS  (no text — motion only)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "transition-fade-through-black",
    transitionStyle: "fade",
    name: "Fade Through Black",
    category: "transitions",
    description: "Dip to black and back — the classic scene break.",
    effectType: "transition",
    tone: "cinematic",
    tags: ["transition", "fade", "black", "dip", "scene", "break", "classic"],
    textStyle: {},
    animation: {
      // Upstream drives black opacity 0 → 0.8 → 1 → 0.8 → 0 across the window,
      // peaking dead centre. That envelope IS what a single-source transition
      // reduces to, and it is exactly the triangular dip the renderer draws.
      in: { durationSeconds: 0.4, ease: "ease-in-out", opacity: [0, 1] },
      out: { durationSeconds: 0.4, ease: "ease-in-out", opacity: [1, 0] },
    },
    placement: "full",
    defaultDurationSeconds: 0.8,
    attribution: {
      source: "remotion-templates",
      file: "templates/fade-through-black.tsx",
      license: "MIT",
      note: "The dip-to-black luminance envelope, peaking at the window centre. Upstream cross-fades two scenes; a single-source timeline has only one, so what ports is the envelope and its timing.",
    },
  },
  {
    id: "transition-cross-dissolve",
    transitionStyle: "smooth_cut",
    name: "Cross Dissolve",
    category: "transitions",
    description: "A soft, gentle dissolve between shots.",
    effectType: "transition",
    tone: "calm",
    tags: ["transition", "dissolve", "cross-fade", "soft", "gentle", "smooth"],
    textStyle: {},
    animation: {
      in: { durationSeconds: 0.3, ease: "linear", opacity: [0, 1] },
      out: { durationSeconds: 0.3, ease: "linear", opacity: [1, 0] },
    },
    placement: "full",
    defaultDurationSeconds: 0.6,
    attribution: {
      source: "remotion-templates",
      file: "templates/cross-dissolve.tsx",
      license: "MIT",
      note: "The linear cross-fade envelope and its ~0.6s duration. A true A/B dissolve needs two sources; on one timeline it reduces to a soft symmetrical dip.",
    },
  },
  {
    id: "transition-film-burn",
    transitionStyle: "flash",
    name: "Film Burn",
    category: "transitions",
    description: "A warm light-leak flash that blooms and clears.",
    effectType: "transition",
    tone: "cinematic",
    tags: ["transition", "film", "burn", "flash", "light-leak", "warm", "analog"],
    textStyle: {},
    animation: {
      // Upstream: intensity interpolates 0 → 0.85 → 0, peaking at mid-window.
      in: { durationSeconds: 0.25, ease: "ease-out", opacity: [0, 0.85] },
      out: { durationSeconds: 0.25, ease: "ease-in", opacity: [0.85, 0] },
    },
    placement: "full",
    defaultDurationSeconds: 0.5,
    attribution: {
      source: "remotion-templates",
      file: "templates/film-burn.tsx",
      license: "MIT",
      note: "The warm light-leak bloom: intensity 0 → 0.85 → 0 peaking at the window centre. The drifting multi-blob gradients are not expressible (the transition draws a uniform full-frame fill) — the bloom and its timing are what port.",
    },
  },
  {
    id: "transition-iris-close",
    transitionStyle: "zoom",
    name: "Iris Close",
    category: "transitions",
    description: "A circular iris closes to the centre and reopens.",
    effectType: "transition",
    tone: "cinematic",
    tags: ["transition", "iris", "circle", "close", "reveal", "vintage", "wipe"],
    textStyle: {},
    animation: {
      in: { durationSeconds: 0.35, ease: "ease-in-out", opacity: [0, 1] },
      out: { durationSeconds: 0.35, ease: "ease-in-out", opacity: [1, 0] },
    },
    placement: "full",
    defaultDurationSeconds: 0.7,
    attribution: {
      source: "remotion-templates",
      file: "templates/iris-transition.tsx",
      license: "MIT",
      note: "The circular-iris geometry and its close/reopen timing. Upstream masks BETWEEN two scenes with clip-path; Framevo renders it as an even-odd black frame whose circular hole closes to the centre over a single source — the same read, expressible on one timeline.",
    },
  },
  {
    id: "transition-whip-cut",
    transitionStyle: "swipe",
    name: "Whip Cut",
    category: "transitions",
    description: "A fast, hard punch between shots.",
    effectType: "transition",
    tone: "energetic",
    tags: ["transition", "whip", "fast", "punch", "hard", "cut", "snap"],
    textStyle: {},
    animation: {
      in: { durationSeconds: 0.12, ease: "ease-in", opacity: [0, 1] },
      out: { durationSeconds: 0.12, ease: "ease-out", opacity: [1, 0] },
    },
    placement: "full",
    defaultDurationSeconds: 0.25,
    attribution: {
      source: "remotion-templates",
      file: "templates/whip-pan.tsx",
      license: "MIT",
      note: "The whip's TIMING — a ~0.25s hit peaking at centre. The horizontal two-scene pan and its scaleX motion-blur stretch are not expressible on a single source; what remains is the hard, fast punch that reads as the whip's cut point.",
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // INTROS
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "intro-chapter-card",
    name: "Chapter Card",
    category: "intros",
    description: "Wide-tracked caps that tighten in — a section marker.",
    effectType: "text-overlay",
    tone: "cinematic",
    tags: ["intro", "chapter", "section", "marker", "tracked", "caps", "structure"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.07,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.2,
      lineHeight: 1.25,
      background: "none",
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.55,
      shadowBlur: 0.45,
      shadowOffsetX: 0,
      shadowOffsetY: 0.05,
    },
    animation: {
      in: {
        durationSeconds: 0.8,
        ease: "spring",
        scale: [0.72, 1],
        letterSpacing: [0.16, 0],
        opacity: [0, 1],
      },
      out: { durationSeconds: 0.45, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.82,
    defaultDurationSeconds: 3,
    defaultText: "Chapter one",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.6, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.8 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/chapter-title.tsx",
      license: "MIT",
      note: "The spring scale-in (damping 12 / stiffness 80) and 0.2em tracked uppercase treatment. The extending hairline rules, centre dot and separate subtitle line are dropped — the overlay is one text block, not a composed card.",
    },
  },
  {
    id: "intro-countdown-punch",
    name: "Countdown Punch",
    category: "intros",
    description: "One big number that punches in and clears. Stack three for a 3-2-1.",
    effectType: "hook-text",
    tone: "energetic",
    tags: ["intro", "countdown", "number", "punch", "3-2-1", "start", "beat"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.16,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0,
      lineHeight: 1,
      background: "none",
      shadow: true,
      shadowColor: "#3b82f6",
      shadowOpacity: 0.6,
      shadowBlur: 0.4,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      // Upstream gives each number a 0.8s slot: spring scale (damping 12 /
      // stiffness 200 / mass 0.5), opacity up over 5 frames and out over the
      // last 8. One moment = one number, so drop three on the timeline for a
      // 3-2-1 — which is also what makes each beat individually retimable.
      in: { durationSeconds: 0.3, ease: "back-out", scale: [0.4, 1], opacity: [0, 1] },
      out: { durationSeconds: 0.25, ease: "ease-in", opacity: [1, 0], scale: [1, 1.12] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 0.8,
    defaultText: "3",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.72 },
      "1:1": { fontScaleMultiplier: 0.88 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/countdown-timer.tsx",
      license: "MIT",
      note: "The per-number beat: a 0.8s slot with a spring scale punch (damping 12 / stiffness 200 / mass 0.5) and a fade-out tail. The progress ring is an SVG stroke-dash and is not expressible on the text overlay path.",
    },
  },
  {
    id: "intro-wordmark-drop",
    name: "Wordmark Drop",
    category: "intros",
    description: "A brand name that drops from above and overshoots on landing.",
    effectType: "text-overlay",
    tone: "playful",
    tags: ["intro", "brand", "wordmark", "drop", "bounce", "logo", "landing"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.08,
      fontWeight: 900,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.06,
      lineHeight: 1.1,
      background: "none",
      shadow: true,
      shadowColor: "#000000",
      shadowOpacity: 0.5,
      shadowBlur: 0.4,
      shadowOffsetX: 0,
      shadowOffsetY: 0.08,
    },
    animation: {
      // Upstream drops from -200px (spring, damping 8 / stiffness 120 / mass 0.8
      // — a big overshoot) then SQUASHES on landing (scaleX 1.3 / scaleY 0.7
      // easing back to 1). The canvas has ONE uniform scale, so the squash-and-
      // stretch cannot be reproduced; `back-out` keeps the overshoot landing,
      // which is what sells the weight. -200/1080 ≈ -0.185 of canvas height.
      in: { durationSeconds: 0.8, ease: "back-out", translateY: [-0.185, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.82,
    defaultDurationSeconds: 2.5,
    defaultText: "Your brand",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.62, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/logo-bounce-drop.tsx",
      license: "MIT",
      note: "Drop from -200px with an overshooting landing (damping 8 / stiffness 120 / mass 0.8), applied to a text wordmark since Framevo has no asset system. The squash-and-stretch on impact needs non-uniform scale, which the canvas animation model does not have.",
    },
  },
  {
    id: "intro-brand-typewriter",
    name: "Brand Typewriter",
    category: "intros",
    description: "A brand name typed out in monospace, letter by letter.",
    effectType: "text-overlay",
    tone: "minimal",
    tags: ["intro", "brand", "typewriter", "mono", "typed", "terminal", "dev"],
    textStyle: {
      preset: "minimal",
      fontFamily: "mono",
      fontScale: 0.06,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.04,
      lineHeight: 1.25,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      // Upstream types at 0.15 chars/frame ≈ 4.5 chars/sec after a 15-frame beat.
      in: { durationSeconds: 0.3, ease: "ease-out", opacity: [0, 1] },
      reveal: { kind: "typewriter", durationSeconds: 1.8 },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3.5,
    defaultText: "Your brand",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.66, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.84 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/logo-typewriter.tsx",
      license: "MIT",
      note: "Monospace typed reveal at ~4.5 characters/second. The spring-scaled icon disc and the blinking cursor are dropped (no asset system; no trailing-glyph channel on the canvas text path).",
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // OUTROS
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "outro-end-card",
    name: "End Card",
    category: "outros",
    description: "A plated sign-off that scales in and glows softly.",
    effectType: "text-overlay",
    tone: "professional",
    tags: ["outro", "end-card", "sign-off", "thanks", "closing", "plate", "glow"],
    textStyle: {
      preset: "shadow",
      fontFamily: "sans",
      fontScale: 0.06,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.03,
      lineHeight: 1.3,
      background: "box",
      backgroundColor: "#111827",
      backgroundOpacity: 0.85,
      paddingX: 0.9,
      paddingY: 0.6,
      borderRadius: 0.22,
      shadow: true,
      shadowColor: "#4361ee",
      shadowOpacity: 0.5,
      shadowBlur: 0.8,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      // Upstream: card scales 0.8 → 1 (spring, damping 12 / mass 0.6) and its
      // border glows on a sin(f*0.08) cycle (~2.6s at 30fps).
      in: { durationSeconds: 1, ease: "spring", scale: [0.8, 1], opacity: [0, 1] },
      loop: { kind: "pulse", amount: 0.3, periodSeconds: 2.6 },
    },
    placement: "center",
    maxWidthFraction: 0.76,
    defaultDurationSeconds: 4,
    defaultText: "Thanks for watching",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.66, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.84 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/end-card.tsx",
      license: "MIT",
      note: "The card itself: a spring scale from 0.8 (damping 12 / mass 0.6) with a slow glow cycle on a dark plate. The glowing border ring becomes a bloom shadow, and the social-icon row is dropped (no asset system).",
    },
  },
  {
    id: "outro-thanks-fade",
    name: "Soft Sign-off",
    category: "outros",
    description: "A quiet closing line that defocuses as it leaves.",
    effectType: "text-overlay",
    tone: "calm",
    tags: ["outro", "fade", "blur", "quiet", "closing", "soft", "farewell"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.055,
      fontWeight: 500,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.05,
      lineHeight: 1.35,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.8, ease: "ease-out", opacity: [0, 1], blur: [0.012, 0] },
      out: { durationSeconds: 0.8, ease: "ease-in", opacity: [1, 0], blur: [0, 0.012] },
    },
    placement: "center",
    maxWidthFraction: 0.76,
    defaultDurationSeconds: 4,
    defaultText: "Thanks for watching",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.68, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.85 },
    },
    attribution: { source: "framevo" },
  },
  {
    id: "outro-handle-card",
    name: "Handle Card",
    category: "outros",
    description: "Your handle, tracked wide and understated.",
    effectType: "text-overlay",
    tone: "minimal",
    tags: ["outro", "handle", "social", "username", "minimal", "tracked", "credit"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.042,
      fontWeight: 600,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.12,
      lineHeight: 1.3,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.7, ease: "expo-out", opacity: [0, 1], letterSpacing: [0.14, 0] },
      out: { durationSeconds: 0.5, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "lower-third",
    maxWidthFraction: 0.72,
    defaultDurationSeconds: 3.5,
    defaultText: "@yourhandle",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.74, maxWidthFraction: 0.92 },
      "1:1": { fontScaleMultiplier: 0.88 },
    },
    attribution: { source: "framevo" },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TEXT ANIMATIONS  (reusable motion, style-neutral)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "text-blur-focus",
    name: "Focus Pull",
    category: "text-animations",
    description: "Text racks from out-of-focus into sharp.",
    effectType: "text-overlay",
    tone: "cinematic",
    tags: ["text", "blur", "focus", "rack", "defocus", "sharp", "lens"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.065,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.25,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      // Upstream: blur 20px → 0 with opacity 0.3 → 1 over ~1.5s. 20/1080 ≈ 0.019
      // of canvas height — and because `blur` is a fraction of height, the rack
      // is identical at 1080p and 4K.
      in: { durationSeconds: 1.2, ease: "expo-out", blur: [0.022, 0], opacity: [0.1, 1] },
      out: { durationSeconds: 0.5, ease: "ease-in", opacity: [1, 0], blur: [0, 0.012] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3,
    defaultText: "Your text here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.66, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.84 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/logo-blur-reveal.tsx",
      license: "MIT",
      note: "The focus-pull: blur 20px → 0 alongside opacity 0.3 → 1 over ~1.5s. Applied to text (Framevo has no logo/asset system); the delayed company-name line is dropped.",
    },
  },
  {
    id: "text-spin-scale",
    name: "Spin In",
    category: "text-animations",
    description: "Text spins up from nothing and settles upright.",
    effectType: "text-overlay",
    tone: "playful",
    tags: ["text", "spin", "rotate", "scale", "entrance", "whirl", "kinetic"],
    textStyle: {
      preset: "bold",
      fontFamily: "sans",
      fontScale: 0.068,
      fontWeight: 800,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.02,
      lineHeight: 1.2,
      background: "none",
      shadow: true,
      shadowColor: "#4361ee",
      shadowOpacity: 0.5,
      shadowBlur: 0.5,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    },
    animation: {
      // Upstream: spring (damping 10 / stiffness 100 / mass 0.8) drives scale
      // 0 → 1 and rotation 0 → 360 together. Rotating -360 → 0 lands upright and
      // reads identically.
      in: { durationSeconds: 0.9, ease: "spring", scale: [0, 1], rotate: [-360, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0], scale: [1, 0.85] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3,
    defaultText: "Your text here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.64, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: {
      source: "remotion-templates",
      file: "templates/logo-scale-rotate.tsx",
      license: "MIT",
      note: "Simultaneous spring scale 0 → 1 and a full 360° rotation (damping 10 / stiffness 100 / mass 0.8). Applied to text; the glow-pulse ring and the delayed name line are dropped.",
    },
  },
  {
    id: "text-expand-tracking",
    name: "Tracking Expand",
    category: "text-animations",
    description: "Letters drift apart from tight to airy as they appear.",
    effectType: "text-overlay",
    tone: "minimal",
    tags: ["text", "tracking", "letter-spacing", "expand", "airy", "elegant", "kerning"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.055,
      fontWeight: 500,
      color: "#ffffff",
      align: "center",
      uppercase: true,
      letterSpacing: 0.18,
      lineHeight: 1.4,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      // Negative → zero: the style's own 0.18em tracking is the destination, and
      // the letters START tight (0.18 - 0.14 = 0.04em) and breathe outward.
      in: { durationSeconds: 1, ease: "expo-out", letterSpacing: [-0.14, 0], opacity: [0, 1] },
      out: { durationSeconds: 0.5, ease: "ease-in", opacity: [1, 0] },
    },
    placement: "center",
    maxWidthFraction: 0.82,
    defaultDurationSeconds: 3,
    defaultText: "Your text here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.62, maxWidthFraction: 0.96 },
      "1:1": { fontScaleMultiplier: 0.82 },
    },
    attribution: { source: "framevo" },
  },
  {
    id: "text-fade-up",
    name: "Fade Up",
    category: "text-animations",
    description: "The dependable one: a soft rise and fade.",
    effectType: "text-overlay",
    tone: "calm",
    tags: ["text", "fade", "rise", "simple", "subtle", "safe", "default"],
    textStyle: {
      preset: "minimal",
      fontFamily: "sans",
      fontScale: 0.055,
      fontWeight: 600,
      color: "#ffffff",
      align: "center",
      uppercase: false,
      letterSpacing: 0.01,
      lineHeight: 1.3,
      background: "none",
      ...READABLE_SHADOW,
    },
    animation: {
      in: { durationSeconds: 0.5, ease: "expo-out", opacity: [0, 1], translateY: [0.028, 0] },
      out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0], translateY: [0, -0.014] },
    },
    placement: "center",
    maxWidthFraction: 0.8,
    defaultDurationSeconds: 3,
    defaultText: "Your text here",
    aspects: {
      "9:16": { fontScaleMultiplier: 0.68, maxWidthFraction: 0.94 },
      "1:1": { fontScaleMultiplier: 0.85 },
    },
    attribution: { source: "framevo" },
  },
]);

// ── Lookup ──────────────────────────────────────────────────────────────────

export const PRESET_IDS: readonly string[] = Object.freeze(PRESETS.map((p) => p.id));

/**
 * Built once, not scanned per call.
 *
 * `getPreset` is on the hot path of the AI Director (which validates every id a
 * model returns) and of the preset browser's render loop, so a linear `find` over
 * the whole library on every lookup would be a needless O(n) per moment.
 */
const BY_ID: ReadonlyMap<string, FramevoPreset> = new Map(PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): FramevoPreset | undefined {
  return BY_ID.get(id);
}

/**
 * True when `id` names a preset that actually exists.
 *
 * This is the guard on model output: the AI Director is asked to pick presets by
 * id, and a language model will cheerfully invent a plausible-sounding one. An
 * unvalidated id would compile into a moment with no style and no animation —
 * an invisible edit the user cannot see, cannot explain and cannot fix.
 */
export function isValidPresetId(id: string): boolean {
  return BY_ID.has(id);
}

export function presetsByCategory(c: PresetCategory): FramevoPreset[] {
  return PRESETS.filter((p) => p.category === c);
}

/**
 * Search by name, description, tags, id and category.
 *
 * Ranked, not just filtered: an exact-ish name match must outrank a preset that
 * merely happens to carry the word in a tag, or searching "pop" surfaces six
 * presets in arbitrary registry order and the one actually called "Bold Pop" is
 * not first. An empty query with filters returns the filtered list unranked.
 */
export function searchPresets(
  query: string,
  opts?: { category?: PresetCategory; tone?: PresetTone }
): FramevoPreset[] {
  const pool = PRESETS.filter(
    (p) =>
      (!opts?.category || p.category === opts.category) &&
      (!opts?.tone || p.tone === opts.tone)
  );

  const q = query.trim().toLowerCase();
  if (!q) return [...pool];

  const terms = q.split(/\s+/).filter(Boolean);

  const scored: { preset: FramevoPreset; score: number }[] = [];
  for (const p of pool) {
    const name = p.name.toLowerCase();
    const id = p.id.toLowerCase();
    const description = p.description.toLowerCase();

    let score = 0;
    let matchedEvery = true;

    for (const term of terms) {
      let best = 0;
      if (name === term) best = 100;
      else if (name.startsWith(term)) best = 60;
      else if (name.includes(term)) best = 40;

      if (id.includes(term)) best = Math.max(best, 30);
      if (p.tags.some((t) => t === term)) best = Math.max(best, 25);
      else if (p.tags.some((t) => t.includes(term))) best = Math.max(best, 15);
      if (p.category.includes(term)) best = Math.max(best, 12);
      if (p.tone.includes(term)) best = Math.max(best, 10);
      if (description.includes(term)) best = Math.max(best, 5);

      if (best === 0) {
        matchedEvery = false;
        break;
      }
      score += best;
    }

    // Every term must hit something. Requiring ALL terms is what makes a
    // two-word query narrow the result instead of widening it — "bold caption"
    // should mean bold AND caption, which is what a user typing two words means.
    if (matchedEvery) scored.push({ preset: p, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.preset.name.localeCompare(b.preset.name))
    .map((s) => s.preset);
}
