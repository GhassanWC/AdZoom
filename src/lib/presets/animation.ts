/**
 * Preset animation — a DECLARATIVE model plus one pure evaluator.
 *
 * WHY THIS EXISTS AS DATA AND NOT AS COMPONENTS
 * The designs in this library are ported from Remotion React templates
 * (see THIRD_PARTY_LICENSES.md). Those templates render with `useCurrentFrame()`
 * + JSX + CSS. Framevo does NOT render overlays with React: `overlay-draw.ts`
 * paints them onto a 2D canvas, and that single module is what the editor
 * preview, the browser exporter, the Cloud Run worker AND the Remotion renderer
 * all call. A vendored React component would therefore draw in exactly ONE of
 * those four paths — it would be invisible in the canvas preview and in every
 * real export.
 *
 * So an animation here is DATA: a set of animated channels with timings and
 * easings. `evaluateAnimation` turns (animation, time) into a plain frame of
 * numbers, and the canvas renderer applies them. Because preview and export both
 * call the same evaluator with the same data, they cannot drift.
 *
 * It is also DETERMINISTIC on purpose. Several source templates use
 * `Math.random()` per frame; that alone makes them unusable for us, because a
 * random overlay would differ between the preview the user approves and the file
 * they export. Every "random" look here (glitch, jitter, grain) is driven by a
 * seeded hash of the frame index instead, so it looks chaotic and renders
 * identically every time.
 *
 * Pure: no DOM, no React, no Remotion. Shared by the renderer, the AI Director
 * and the tests.
 */

/** Easing curves. Named, not arbitrary — a preset can't smuggle in a function. */
export const EASINGS = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "spring",
  "back-out",
  "elastic-out",
  "expo-out",
] as const;
export type EaseName = (typeof EASINGS)[number];

/** Evaluate a named easing at progress p (0..1). Deterministic + clamped. */
export function ease(name: EaseName, p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p;
  switch (name) {
    case "linear":
      return x;
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "ease-in-out":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "expo-out":
      return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
    case "back-out": {
      // The overshoot-and-settle the source templates get from Remotion's spring
      // with low damping. c1 = 1.70158 is the standard back constant.
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    case "elastic-out": {
      if (x === 0 || x === 1) return x;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
    }
    case "spring": {
      // A critically-ish damped spring, evaluated in closed form so it is exact
      // at any time (no integration, no frame-rate dependence — the export runs
      // at a different fps than the preview and must land on the same value).
      if (x === 0 || x === 1) return x;
      const omega = 8;
      const zeta = 0.62;
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      return (
        1 -
        Math.exp(-zeta * omega * x) *
          (Math.cos(wd * x) + ((zeta * omega) / wd) * Math.sin(wd * x))
      );
    }
  }
}

/** A channel animates from `[from, to]` across the phase. */
export type Channel = readonly [number, number];

/**
 * One phase of an animation (entrance or exit).
 *
 * Units are deliberately RESOLUTION-INDEPENDENT so a preset renders the same on
 * a 1080p preview and a 4K export:
 *   translateX/Y — fraction of canvas WIDTH / HEIGHT
 *   scale        — multiplier
 *   rotate       — degrees
 *   blur         — fraction of canvas height
 *   letterSpacing — fraction of font size (matches TextStyle.letterSpacing)
 */
export interface AnimPhase {
  /** Seconds. Clamped to at most half the moment so in+out can't overlap badly. */
  durationSeconds: number;
  ease: EaseName;
  opacity?: Channel;
  translateX?: Channel;
  translateY?: Channel;
  scale?: Channel;
  rotate?: Channel;
  blur?: Channel;
  letterSpacing?: Channel;
}

export const LOOP_KINDS = ["none", "pulse", "float", "shake", "glitch"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

/** A continuous, seamless motion that runs for the whole moment. */
export interface LoopSpec {
  kind: LoopKind;
  /** 0..1 — how strong. */
  amount: number;
  /** Seconds per cycle. */
  periodSeconds: number;
}

export const REVEAL_KINDS = ["none", "typewriter", "word", "char"] as const;
export type RevealKind = (typeof REVEAL_KINDS)[number];

/**
 * Progressive text reveal. `typewriter` clips mid-word; `word` and `char` stagger
 * whole units in. The renderer turns `revealFraction` into how much of the string
 * to draw.
 */
export interface RevealSpec {
  kind: RevealKind;
  /** Seconds to reveal the whole string. */
  durationSeconds: number;
}

/** The full animation attached to a preset (and persisted on the moment). */
export interface PresetAnimation {
  in?: AnimPhase;
  out?: AnimPhase;
  loop?: LoopSpec;
  reveal?: RevealSpec;
}

/**
 * The evaluated frame. Plain numbers — the renderer applies them to the canvas
 * and nothing else needs to know how they were produced.
 */
export interface AnimationFrame {
  /** Multiplied into the draw alpha. */
  alpha: number;
  /** Fraction of canvas width / height. */
  translateX: number;
  translateY: number;
  scale: number;
  /** Degrees. */
  rotate: number;
  /** Fraction of canvas height. */
  blur: number;
  /** ADDED to the style's letterSpacing (fraction of font size). */
  letterSpacing: number;
  /** 0..1 — how much of the text to draw. 1 = all of it. */
  revealFraction: number;
}

export const IDENTITY_FRAME: AnimationFrame = {
  alpha: 1,
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
  blur: 0,
  letterSpacing: 0,
  revealFraction: 1,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function lerp(c: Channel | undefined, p: number, fallback: number): number {
  if (!c) return fallback;
  return c[0] + (c[1] - c[0]) * p;
}

/**
 * Deterministic pseudo-random in [-1, 1] from an integer step.
 *
 * This is what replaces `Math.random()` in the ported glitch/shake designs. A
 * random value would make the exported file differ from the preview the user
 * signed off on — the single most damaging kind of preview/export drift, because
 * it is invisible until someone compares frames.
 */
function seededNoise(step: number, salt: number): number {
  let h = (Math.imul(step | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h / 0xffffffff) * 2 - 1;
}

/**
 * Evaluate an animation at absolute source time `t` for a moment spanning
 * [start, end].
 *
 * Returns `IDENTITY_FRAME` when there is nothing to animate, so the caller can
 * always apply the result unconditionally.
 */
export function evaluateAnimation(
  anim: PresetAnimation | undefined,
  t: number,
  start: number,
  end: number
): AnimationFrame {
  const dur = end - start;
  if (!anim || dur <= 0) return IDENTITY_FRAME;

  const elapsed = t - start;
  const remaining = end - t;

  let alpha = 1;
  let translateX = 0;
  let translateY = 0;
  let scale = 1;
  let rotate = 0;
  let blur = 0;
  let letterSpacing = 0;

  // ── Entrance ─────────────────────────────────────────────────────────────
  // Phases are clamped to half the moment: a 3s entrance on a 1s caption would
  // otherwise mean the caption is never fully on screen.
  const half = dur / 2;

  if (anim.in) {
    const d = Math.min(Math.max(0.01, anim.in.durationSeconds), half);
    if (elapsed < d) {
      const p = ease(anim.in.ease, clamp01(elapsed / d));
      alpha *= lerp(anim.in.opacity, p, 1);
      translateX += lerp(anim.in.translateX, p, 0);
      translateY += lerp(anim.in.translateY, p, 0);
      scale *= lerp(anim.in.scale, p, 1);
      rotate += lerp(anim.in.rotate, p, 0);
      blur += lerp(anim.in.blur, p, 0);
      letterSpacing += lerp(anim.in.letterSpacing, p, 0);
    }
  }

  // ── Exit ─────────────────────────────────────────────────────────────────
  if (anim.out) {
    const d = Math.min(Math.max(0.01, anim.out.durationSeconds), half);
    if (remaining < d) {
      // Exit progress runs 0 → 1 as the moment ENDS, so a preset declares its
      // exit the same way it declares its entrance (from → to), rather than
      // having to think backwards.
      const p = ease(anim.out.ease, clamp01(1 - remaining / d));
      alpha *= lerp(anim.out.opacity, p, 1);
      translateX += lerp(anim.out.translateX, p, 0);
      translateY += lerp(anim.out.translateY, p, 0);
      scale *= lerp(anim.out.scale, p, 1);
      rotate += lerp(anim.out.rotate, p, 0);
      blur += lerp(anim.out.blur, p, 0);
      letterSpacing += lerp(anim.out.letterSpacing, p, 0);
    }
  }

  // ── Loop ─────────────────────────────────────────────────────────────────
  const loop = anim.loop;
  if (loop && loop.kind !== "none" && loop.amount > 0) {
    const period = Math.max(0.05, loop.periodSeconds);
    const phase = (elapsed / period) * Math.PI * 2;
    const a = clamp01(loop.amount);

    switch (loop.kind) {
      case "pulse":
        // Breathe around 1 — never below, so text doesn't shrink into itself.
        scale *= 1 + Math.sin(phase) * 0.06 * a;
        break;
      case "float":
        translateY += Math.sin(phase) * 0.012 * a;
        break;
      case "shake": {
        // Quantized to ~60 steps/sec so the jitter is frame-stable at ANY fps —
        // a 30fps export and a 60fps preview sample the same steps.
        const step = Math.floor(elapsed * 60);
        translateX += seededNoise(step, 1) * 0.004 * a;
        translateY += seededNoise(step, 2) * 0.004 * a;
        break;
      }
      case "glitch": {
        const step = Math.floor(elapsed * 12);
        const hit = seededNoise(step, 3) > 0.55;
        if (hit) {
          translateX += seededNoise(step, 4) * 0.012 * a;
          alpha *= 1 - 0.25 * a;
        }
        break;
      }
    }
  }

  // ── Reveal ───────────────────────────────────────────────────────────────
  let revealFraction = 1;
  if (anim.reveal && anim.reveal.kind !== "none") {
    const d = Math.max(0.05, anim.reveal.durationSeconds);
    revealFraction = clamp01(elapsed / d);
  }

  return {
    alpha: clamp01(alpha),
    translateX,
    translateY,
    // A scale that has gone negative would mirror the text — clamp at 0.
    scale: Math.max(0, scale),
    rotate,
    blur: Math.max(0, blur),
    letterSpacing,
    revealFraction,
  };
}

/**
 * How much of `text` to draw for a reveal fraction.
 *
 * `typewriter` cuts mid-word (that's the look). `word` and `char` snap to whole
 * units so text never appears half-formed. Returns the full string when there is
 * no reveal.
 */
export function revealText(
  text: string,
  kind: RevealKind,
  fraction: number
): string {
  if (kind === "none" || fraction >= 1) return text;
  const f = clamp01(fraction);
  if (f <= 0) return "";

  if (kind === "typewriter" || kind === "char") {
    const chars = [...text];
    const n = Math.floor(chars.length * f);
    return chars.slice(0, kind === "char" ? n : n).join("");
  }

  // word
  const words = text.split(/(\s+)/); // keep separators so spacing survives
  const wordCount = words.filter((w) => w.trim()).length;
  const show = Math.floor(wordCount * f);
  if (show <= 0) return "";
  let seen = 0;
  const out: string[] = [];
  for (const w of words) {
    if (w.trim()) {
      if (seen >= show) break;
      seen += 1;
    }
    out.push(w);
  }
  return out.join("").trimEnd();
}

/** Clamp a user-authored animation into sane bounds. Presets are data — validate them. */
export function sanitizeAnimation(
  anim: PresetAnimation | undefined
): PresetAnimation | undefined {
  if (!anim) return undefined;
  const phase = (p: AnimPhase | undefined): AnimPhase | undefined => {
    if (!p) return undefined;
    return {
      durationSeconds: Math.min(10, Math.max(0.05, Number(p.durationSeconds) || 0.4)),
      ease: (EASINGS as readonly string[]).includes(p.ease) ? p.ease : "ease-out",
      ...(p.opacity ? { opacity: p.opacity } : {}),
      ...(p.translateX ? { translateX: p.translateX } : {}),
      ...(p.translateY ? { translateY: p.translateY } : {}),
      ...(p.scale ? { scale: p.scale } : {}),
      ...(p.rotate ? { rotate: p.rotate } : {}),
      ...(p.blur ? { blur: p.blur } : {}),
      ...(p.letterSpacing ? { letterSpacing: p.letterSpacing } : {}),
    };
  };
  const out: PresetAnimation = {};
  const i = phase(anim.in);
  const o = phase(anim.out);
  if (i) out.in = i;
  if (o) out.out = o;
  if (anim.loop && (LOOP_KINDS as readonly string[]).includes(anim.loop.kind)) {
    out.loop = {
      kind: anim.loop.kind,
      amount: clamp01(Number(anim.loop.amount) || 0),
      periodSeconds: Math.min(20, Math.max(0.05, Number(anim.loop.periodSeconds) || 2)),
    };
  }
  if (anim.reveal && (REVEAL_KINDS as readonly string[]).includes(anim.reveal.kind)) {
    out.reveal = {
      kind: anim.reveal.kind,
      durationSeconds: Math.min(20, Math.max(0.05, Number(anim.reveal.durationSeconds) || 1)),
    };
  }
  return Object.keys(out).length ? out : undefined;
}
