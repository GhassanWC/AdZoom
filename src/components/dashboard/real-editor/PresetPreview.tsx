"use client";

import * as React from "react";
import {
  IDENTITY_FRAME,
  ease,
  evaluateAnimation,
  revealText,
  type AnimationFrame,
  type RevealKind,
} from "@/lib/presets/animation";
import { resolvePresetStyle, safeAreaFor } from "@/lib/presets/layout";
import type { FramevoPreset } from "@/lib/presets/types";
import { DEFAULT_TEXT_STYLE, rgba, type TextStyleValues } from "@/lib/render/text-style";
import type { TransitionStyle } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";

/**
 * The animated preview on a preset card.
 *
 * WHAT IT IS
 * A faithful-enough DOM mirror of what `overlay-draw.ts` will paint: the SAME
 * resolved `TextStyle` (via `resolvePresetStyle`, the module the renderer uses)
 * and the SAME motion (via `evaluateAnimation` / `revealText`, the pure evaluator
 * the preview canvas, the browser exporter and the Cloud Run worker all call).
 * Nothing here re-derives a design — a card that animated differently from the
 * edit it produces would be worse than no preview at all.
 *
 * WHY DOM AND NOT A CANVAS
 * 38 canvases, each with its own 2D context, is a lot of GPU memory for a browse
 * grid. The units survive the move because the preset system is deliberately
 * resolution-independent: `fontScale` is a fraction of canvas HEIGHT and every
 * padding / stroke / shadow / letter-spacing is a fraction of FONT SIZE. Inside a
 * CSS *size container* those become `cqh` and `em` exactly — no measuring, no
 * ResizeObserver, and the preview stays correct at any card width.
 *
 * PERFORMANCE — THE POINT OF THIS FILE
 * A rAF loop per card would mean 38 loops fighting the video decoder for the main
 * thread, which is precisely how a preset browser makes the actual editor stutter.
 * So a loop runs only when the card is BOTH on screen (IntersectionObserver) AND
 * hovered/focused — at most one at a time — and never at all under
 * `prefers-reduced-motion`. Every other card shows its resting frame, statically,
 * for zero per-frame cost.
 *
 * The loop writes styles STRAIGHT TO THE DOM (the same discipline as the
 * playhead). Driving 60fps through `setState` would re-render the card — and its
 * siblings' memo checks — sixty times a second for a decoration.
 */

/** Preview frames are 16:9 — the design's base aspect, so no adaptation is implied. */
const PREVIEW_ASPECT = "16:9" as const;

/** Where a static (non-animating) transition is sampled. Mid-dip, mid-wipe: enough
 *  to read WHAT it does without a black rectangle where a preview should be. */
const STATIC_INTENSITY = 0.6;
const STATIC_SWEEP = 0.3;

/** UI-side stacks for the curated families. The renderer resolves script-aware
 *  Noto stacks; a browse card only needs the same *shape* of type. */
const FAMILY_STACK: Record<NonNullable<TextStyleValues["fontFamily"]>, string> = {
  auto: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
  sans: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export function PresetPreview({
  preset,
  /** Hovered / keyboard-focused. One of the two gates on the rAF loop. */
  active = false,
  className,
}: {
  preset: FramevoPreset;
  active?: boolean;
  className?: string;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const inView = useInView(rootRef);
  const reduced = usePrefersReducedMotion();

  // BOTH gates. Off-screen cards cost nothing; a reduced-motion user gets a still.
  const animating = inView && active && !reduced;

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn(
        "relative isolate overflow-hidden rounded-lg ring-1 ring-inset ring-white/[0.06]",
        className
      )}
      // `container-type: size` turns this frame into the preset's "canvas": the
      // design's height-relative units resolve against it verbatim.
      style={{ aspectRatio: "16 / 9", containerType: "size" }}
    >
      <FrameBackdrop />
      {preset.effectType === "transition" ? (
        <TransitionLayer preset={preset} animating={animating} />
      ) : (
        <TextLayer preset={preset} animating={animating} />
      )}
    </div>
  );
}

/**
 * The stand-in for the video underneath.
 *
 * Deliberately mid-tone with structure in it, not flat black: half the library's
 * design decisions (the outline on Bold Pop, the plate on Clean Lift, the shadow
 * on Minimal Fade) exist ONLY to keep text readable over real footage. On a black
 * card they'd look like pointless decoration, and the user would pick the wrong
 * preset.
 */
function FrameBackdrop() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 -z-10"
      style={{
        backgroundImage: [
          "radial-gradient(120% 90% at 20% 15%, rgba(139,92,246,0.20), transparent 60%)",
          "radial-gradient(90% 80% at 85% 90%, rgba(56,189,248,0.14), transparent 55%)",
          "linear-gradient(160deg, #2b3245 0%, #171b28 55%, #0d1018 100%)",
        ].join(", "),
      }}
    >
      {/* A faint UI grid — it reads as "a screen recording" rather than a swatch. */}
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)",
          backgroundSize: "14px 14px",
        }}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Text presets
// ════════════════════════════════════════════════════════════════════════════

function TextLayer({
  preset,
  animating,
}: {
  preset: FramevoPreset;
  animating: boolean;
}) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);

  // The SAME resolver the applied moment goes through, so the card shows the
  // design as it will actually be persisted — placement, safe area and all.
  const style: TextStyleValues = React.useMemo(
    () => ({ ...DEFAULT_TEXT_STYLE, ...resolvePresetStyle(preset, PREVIEW_ASPECT) }),
    [preset]
  );

  const text = preset.defaultText ?? "Your text here";
  const revealKind: RevealKind = preset.animation?.reveal?.kind ?? "none";
  const duration = Math.max(0.3, preset.defaultDurationSeconds);

  // Anchor to match the canvas: a left-aligned design grows right from its x,
  // a right-aligned one grows left, a centred one straddles it.
  const anchorX =
    style.align === "left" ? "0%" : style.align === "right" ? "-100%" : "-50%";

  const maxWidthPct = React.useMemo(() => {
    const frac =
      preset.aspects?.[PREVIEW_ASPECT]?.maxWidthFraction ?? preset.maxWidthFraction ?? 1;
    // A fraction of the SAFE box, never of the raw frame — the same rule
    // `resolveMaxWidthPx` applies, so a design that wraps on the timeline wraps
    // here too instead of running edge to edge.
    const safe = safeAreaFor(PREVIEW_ASPECT);
    const safeWidthFraction = Math.max(0.1, 1 - safe.left - safe.right);
    return Math.max(10, Math.min(100, frac * safeWidthFraction * 100));
  }, [preset]);

  /** Push one evaluated frame straight into the DOM. No React in the hot path. */
  const applyFrame = React.useCallback(
    (f: AnimationFrame) => {
      const w = wrapRef.current;
      if (w) {
        w.style.opacity = f.alpha.toFixed(3);
        w.style.transform = [
          `translate(${anchorX}, -50%)`,
          `translate(${(f.translateX * 100).toFixed(3)}cqw, ${(f.translateY * 100).toFixed(3)}cqh)`,
          `scale(${f.scale.toFixed(4)})`,
          `rotate(${f.rotate.toFixed(2)}deg)`,
        ].join(" ");
        w.style.filter =
          f.blur > 0.0005 ? `blur(${(f.blur * 100).toFixed(3)}cqh)` : "none";
      }
      const t = textRef.current;
      if (t) {
        t.style.letterSpacing = `${((style.letterSpacing ?? 0) + f.letterSpacing).toFixed(4)}em`;
        const shown = revealText(text, revealKind, f.revealFraction);
        // Never collapse the line box to nothing mid-reveal — the plate would
        // pop from zero width, which is a flicker the renderer doesn't have.
        t.textContent = shown.length > 0 ? shown : "\u200B";
      }
    },
    [anchorX, revealKind, style.letterSpacing, text]
  );

  // Resting frame — what every non-animating card shows, and what an animating
  // one is restored to when the pointer leaves.
  React.useLayoutEffect(() => {
    if (!animating) applyFrame(IDENTITY_FRAME);
  }, [animating, applyFrame]);

  React.useEffect(() => {
    if (!animating) return;
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = ((now - startedAt) / 1000) % duration;
      applyFrame(evaluateAnimation(preset.animation, t, 0, duration));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      applyFrame(IDENTITY_FRAME);
    };
  }, [animating, applyFrame, duration, preset.animation]);

  return (
    <div
      ref={wrapRef}
      className="absolute"
      style={{
        left: `${(style.customX ?? 0.5) * 100}%`,
        top: `${(style.customY ?? 0.82) * 100}%`,
        maxWidth: `${maxWidthPct}%`,
        transform: `translate(${anchorX}, -50%)`,
        willChange: animating ? "transform, opacity, filter" : undefined,
      }}
    >
      <span
        ref={textRef}
        style={{
          display: "inline-block",
          fontFamily: FAMILY_STACK[style.fontFamily ?? "auto"],
          // fontScale is a fraction of canvas height → 1cqh IS 1% of the frame.
          fontSize: `${((style.fontScale ?? 0.05) * 100).toFixed(4)}cqh`,
          fontWeight: style.fontWeight,
          color: style.color,
          opacity: style.textOpacity,
          lineHeight: style.lineHeight,
          textAlign: style.align,
          textTransform: style.uppercase ? "uppercase" : "none",
          letterSpacing: `${(style.letterSpacing ?? 0).toFixed(4)}em`,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          background:
            style.background === "none"
              ? "transparent"
              : rgba(style.backgroundColor ?? "#000000", style.backgroundOpacity ?? 0.55),
          padding:
            style.background === "none"
              ? 0
              : `${style.paddingY ?? 0.28}em ${style.paddingX ?? 0.55}em`,
          borderRadius:
            style.background === "pill"
              ? "999px"
              : style.background === "box"
                ? `${style.borderRadius ?? 0.28}em`
                : 0,
          // Both are fractions of font size in the model — so both are `em` here.
          WebkitTextStroke:
            (style.strokeWidth ?? 0) > 0
              ? `${style.strokeWidth}em ${style.strokeColor ?? "#000000"}`
              : undefined,
          // Stroke UNDER fill, as the canvas paints it. Without this the outline
          // eats into the glyph and heavy designs (Bold Pop, Impact Pop) read thin.
          paintOrder: "stroke fill",
          textShadow: style.shadow
            ? `${style.shadowOffsetX ?? 0}em ${style.shadowOffsetY ?? 0.05}em ${
                style.shadowBlur ?? 0.28
              }em ${rgba(style.shadowColor ?? "#000000", style.shadowOpacity ?? 0.6)}`
            : undefined,
        }}
      >
        {text}
      </span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Transition presets (no text — motion only)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors `drawTransition` in overlay-draw.ts exactly: a TRIANGULAR intensity
 * (0 at the window's edges, 1 at its centre) plus a linear sweep, fed into the
 * same five styles. Reproducing the envelope rather than approximating it is what
 * makes "Iris Close" look like an iris on the card and an iris in the export.
 */
function TransitionLayer({
  preset,
  animating,
}: {
  preset: FramevoPreset;
  animating: boolean;
}) {
  const dipRef = React.useRef<HTMLDivElement | null>(null);
  const style: TransitionStyle = preset.transitionStyle ?? "fade";
  const duration = Math.max(0.2, preset.defaultDurationSeconds);

  const applyDip = React.useCallback(
    (intensity: number, sweep: number) => {
      const el = dipRef.current;
      if (!el) return;
      el.style.left = "0%";
      el.style.width = "100%";

      switch (style) {
        case "flash":
          el.style.background = "#ffffff";
          el.style.opacity = (intensity * 0.85).toFixed(3);
          break;

        case "smooth_cut":
          el.style.background = "#000000";
          el.style.opacity = (ease("ease-out", intensity) * 0.55).toFixed(3);
          break;

        case "swipe": {
          // A hard bar wiping left→right: the leading half covers, the trailing
          // half uncovers. Same arithmetic as the renderer's `edge`.
          el.style.background = "#000000";
          el.style.opacity = "0.95";
          if (sweep <= 0.5) {
            el.style.left = "0%";
            el.style.width = `${Math.min(1, sweep * 2) * 100}%`;
          } else {
            el.style.left = `${(sweep * 2 - 1) * 100}%`;
            el.style.width = "100%";
          }
          break;
        }

        case "zoom": {
          // The iris: a black frame with a genuinely transparent circular hole
          // that closes to the centre. `farthest-corner` makes 100% of the
          // gradient ray equal the renderer's `hypot(w,h)/2`.
          const r = (1 - intensity) * 100;
          el.style.background = `radial-gradient(circle farthest-corner at 50% 50%, rgba(0,0,0,0) ${r.toFixed(
            2
          )}%, rgba(0,0,0,0.95) ${r.toFixed(2)}%)`;
          el.style.opacity = "1";
          break;
        }

        case "fade":
        default:
          el.style.background = "#000000";
          el.style.opacity = (intensity * 0.95).toFixed(3);
          break;
      }
    },
    [style]
  );

  React.useLayoutEffect(() => {
    if (!animating) applyDip(STATIC_INTENSITY, STATIC_SWEEP);
  }, [animating, applyDip]);

  React.useEffect(() => {
    if (!animating) return;
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      // Loop the window with a short beat of clear frame either side, so the dip
      // reads as an event rather than a strobe.
      const cycle = duration + 0.5;
      const t = ((now - startedAt) / 1000) % cycle;
      if (t > duration) {
        applyDip(0, 0);
      } else {
        const half = duration / 2;
        const intensity = Math.max(0, Math.min(1, 1 - Math.abs(t - half) / half));
        applyDip(intensity, Math.max(0, Math.min(1, t / duration)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      applyDip(STATIC_INTENSITY, STATIC_SWEEP);
    };
  }, [animating, applyDip, duration]);

  return (
    <div
      ref={dipRef}
      className="absolute inset-y-0"
      style={{ willChange: animating ? "opacity" : undefined }}
    />
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Gates
// ════════════════════════════════════════════════════════════════════════════

/** True while the element is on screen. The hard prerequisite for any rAF work. */
function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting);
      },
      // A sliver counts: a card being scrolled into view should be ready to play
      // the moment the pointer lands on it.
      { threshold: 0.01 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return inView;
}

/** Live — the OS setting can change while the editor is open. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
