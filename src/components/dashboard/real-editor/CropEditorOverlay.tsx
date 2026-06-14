"use client";

import * as React from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SourceCrop } from "@/lib/firebase/schema";

/**
 * Global Frame Crop editor — a CapCut-style draggable crop rectangle drawn over
 * the FULL source frame. Outputs a normalized `SourceCrop` (0..1 of the full
 * frame). Rendered inside the source-frame box while `cropEditing` is on, with
 * a dimmed-outside mask, rule-of-thirds, 8 resize handles + body-move, an
 * aspect-lock picker, and a floating Reset / Cancel / Apply bar.
 *
 * Modeled on `EditableFocusBox` but commits to the project's `sourceCrop`
 * instead of a moment, and supports aspect-ratio locking.
 */

type AspectLock = NonNullable<SourceCrop["aspectLock"]>;
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN = 0.05; // minimum crop size (normalized)

const ASPECTS: { id: AspectLock; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "source", label: "Source" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
];

const ASPECT_WH: Record<Exclude<AspectLock, "free" | "source">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Target NORMALIZED width:height ratio for an on-screen pixel ratio `R`, given
 * the full frame's aspect `naturalAspect` (W/H). On screen a normalized box is
 * `(width·W) × (height·H)`, so `(width·W)/(height·H) = R` ⇒
 * `width/height = R·H/W = R / naturalAspect`.
 */
function normRatioFor(lock: AspectLock, naturalAspect: number): number | null {
  if (lock === "free") return null;
  const px = lock === "source" ? naturalAspect : ASPECT_WH[lock];
  return px / naturalAspect; // normalized width / height
}

/** Center a max-size box of the given normalized ratio inside the frame. */
function centeredRectForRatio(normRatio: number | null): Rect {
  if (normRatio == null) return { x: 0, y: 0, width: 1, height: 1 };
  // Fit the largest box of ratio (w/h = normRatio) inside the unit square.
  let width = 1;
  let height = width / normRatio;
  if (height > 1) {
    height = 1;
    width = height * normRatio;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function CropEditorOverlay({
  aspectRef,
  initial,
  naturalAspect,
  onApply,
  onReset,
  onCancel,
}: {
  /** The full-frame box the crop is normalized against (sourceFrameRef). */
  aspectRef: React.RefObject<HTMLDivElement | null>;
  initial?: SourceCrop;
  naturalAspect: number;
  onApply: (crop: SourceCrop) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [lock, setLock] = React.useState<AspectLock>(initial?.aspectLock ?? "free");
  const [rect, setRect] = React.useState<Rect>(
    initial?.enabled
      ? {
          x: clamp01(initial.x),
          y: clamp01(initial.y),
          width: clamp01(initial.width),
          height: clamp01(initial.height),
        }
      : { x: 0, y: 0, width: 1, height: 1 }
  );
  const rectRef = React.useRef(rect);
  rectRef.current = rect;
  const dragRef = React.useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    orig: Rect;
  } | null>(null);

  const normRatio = normRatioFor(lock, naturalAspect);

  // Re-shape the box when a (non-free) lock is chosen so it matches the ratio.
  const applyLock = React.useCallback(
    (next: AspectLock) => {
      setLock(next);
      const r = normRatioFor(next, naturalAspect);
      if (r == null) return; // free — leave the box as-is
      // Keep the current center; fit the largest box of the ratio that still
      // fits the frame and isn't larger than the current box's larger extent.
      const cur = rectRef.current;
      const cx = cur.x + cur.width / 2;
      const cy = cur.y + cur.height / 2;
      const base = centeredRectForRatio(r);
      // Shrink base to fit around the current center without leaving the frame.
      let width = base.width;
      let height = base.height;
      // Clamp so the centered box stays in-frame.
      width = Math.min(width, 2 * Math.min(cx, 1 - cx) || width);
      height = width / r;
      if (height > 2 * Math.min(cy, 1 - cy)) {
        height = 2 * Math.min(cy, 1 - cy) || height;
        width = height * r;
      }
      width = clamp(width, MIN, 1);
      height = clamp(height, MIN, 1);
      const x = clamp01(cx - width / 2);
      const y = clamp01(cy - height / 2);
      setRect({
        x: round3(Math.min(x, 1 - width)),
        y: round3(Math.min(y, 1 - height)),
        width: round3(width),
        height: round3(height),
      });
    },
    [naturalAspect]
  );

  const begin = (e: React.PointerEvent, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: rectRef.current,
    };
  };

  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const box = aspectRef.current;
      if (!d || !box) return;
      const b = box.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      const dx = (e.clientX - d.startX) / b.width;
      const dy = (e.clientY - d.startY) / b.height;
      let { x, y, width, height } = d.orig;

      if (d.handle === "move") {
        x = clamp(d.orig.x + dx, 0, 1 - width);
        y = clamp(d.orig.y + dy, 0, 1 - height);
        setRect({ x: round3(x), y: round3(y), width: round3(width), height: round3(height) });
        return;
      }

      const hasW = d.handle.includes("w");
      const hasE = d.handle.includes("e");
      const hasN = d.handle.includes("n");
      const hasS = d.handle.includes("s");

      if (hasW) {
        const nx = clamp(d.orig.x + dx, 0, d.orig.x + d.orig.width - MIN);
        width = d.orig.x + d.orig.width - nx;
        x = nx;
      }
      if (hasE) {
        width = clamp(d.orig.width + dx, MIN, 1 - d.orig.x);
      }
      if (hasN) {
        const ny = clamp(d.orig.y + dy, 0, d.orig.y + d.orig.height - MIN);
        height = d.orig.y + d.orig.height - ny;
        y = ny;
      }
      if (hasS) {
        height = clamp(d.orig.height + dy, MIN, 1 - d.orig.y);
      }

      // Aspect lock: derive the dependent dimension from the dragged one,
      // anchored to the fixed edge, then clamp back into the frame.
      if (normRatio != null) {
        const horizontalDrag = hasW || hasE;
        if (horizontalDrag) {
          height = width / normRatio;
          if (height > 1) {
            height = 1;
            width = height * normRatio;
          }
          // Anchor vertically around the box's fixed edge (or center for corners).
          if (hasN) y = d.orig.y + d.orig.height - height;
          else if (hasS) y = d.orig.y;
          else y = clamp01(d.orig.y + (d.orig.height - height) / 2);
          if (hasW) x = d.orig.x + d.orig.width - width;
          else if (hasE) x = d.orig.x;
        } else {
          width = height * normRatio;
          if (width > 1) {
            width = 1;
            height = width / normRatio;
          }
          if (hasN) y = d.orig.y + d.orig.height - height;
          else if (hasS) y = d.orig.y;
          x = clamp01(d.orig.x + (d.orig.width - width) / 2);
        }
        // Final clamp so the box never leaves the frame.
        width = clamp(width, MIN, 1);
        height = clamp(height, MIN, 1);
        x = clamp(x, 0, 1 - width);
        y = clamp(y, 0, 1 - height);
      }

      setRect({ x: round3(x), y: round3(y), width: round3(width), height: round3(height) });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [aspectRef, normRatio]);

  const handles: { id: Handle; cls: string; cursor: string }[] = [
    { id: "nw", cls: "-left-1 -top-1", cursor: "nwse-resize" },
    { id: "ne", cls: "-right-1 -top-1", cursor: "nesw-resize" },
    { id: "sw", cls: "-bottom-1 -left-1", cursor: "nesw-resize" },
    { id: "se", cls: "-bottom-1 -right-1", cursor: "nwse-resize" },
    { id: "n", cls: "-top-1 left-1/2 -translate-x-1/2", cursor: "ns-resize" },
    { id: "s", cls: "-bottom-1 left-1/2 -translate-x-1/2", cursor: "ns-resize" },
    { id: "w", cls: "-left-1 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
    { id: "e", cls: "-right-1 top-1/2 -translate-y-1/2", cursor: "ew-resize" },
  ];

  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  const commitApply = () =>
    onApply({
      enabled: true,
      x: round3(rect.x),
      y: round3(rect.y),
      width: round3(rect.width),
      height: round3(rect.height),
      aspectLock: lock,
      reason: "manual",
    });

  return (
    // Root sits ABOVE the player controls (z-40). It's pointer-events-none so
    // clicks in the dim area don't get trapped; only the box + toolbar are
    // interactive.
    <div className="pointer-events-none absolute inset-0 z-50">
      {/* Dimmed-outside mask — a huge shadow around the crop rect darkens
          everything but the kept area. */}
      <div
        className="pointer-events-none absolute rounded-[2px] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ring-1 ring-white/70"
        style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
      />

      {/* Interactive crop box. */}
      <div
        onPointerDown={(e) => begin(e, "move")}
        className="pointer-events-auto absolute cursor-move"
        style={{
          left: pct(rect.x),
          top: pct(rect.y),
          width: pct(rect.width),
          height: pct(rect.height),
          touchAction: "none",
        }}
      >
        {/* Rule-of-thirds inside the crop box. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/25" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/25" />
        </div>
        {handles.map((h) => (
          <span
            key={h.id}
            onPointerDown={(e) => begin(e, h.id)}
            className={cn(
              "absolute size-3 rounded-[2px] border border-white bg-violet-500 shadow",
              h.cls
            )}
            style={{ cursor: h.cursor, touchAction: "none" }}
          />
        ))}
      </div>

      {/* Floating control bar — z-[60] + pointer-events-auto so it's always the
          top interactive layer, above the (faded) player controls. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[60] flex justify-center px-3">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-white/12 bg-ink/90 px-3 py-2 shadow-cinematic backdrop-blur-md">
          <span className="hidden text-[11px] font-medium text-fog sm:inline">Crop</span>
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => applyLock(a.id)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150",
                  lock === a.id
                    ? "bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/40"
                    : "text-fog hover:bg-white/[0.05] hover:text-white"
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={onReset}
            title="Reset to full frame"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 text-[12px] font-medium text-fog transition-colors hover:border-white/30 hover:text-white"
          >
            <RotateCcw size={12} />
            Reset
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 text-[12px] font-medium text-white/85 transition-colors hover:border-white/30 hover:text-white"
          >
            <X size={12} />
            Cancel
          </button>
          <button
            type="button"
            onClick={commitApply}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-3.5 text-[12px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(139,92,246,0.7)] transition-colors hover:from-violet-500 hover:to-violet-500"
          >
            <Check size={12} />
            Apply
          </button>
        </div>
      </div>

      {/* Helper text. */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-full border border-white/12 bg-ink/80 px-3 py-1 text-[11px] text-fog backdrop-blur-md">
        Crop the source frame. This applies to the whole video.
      </div>
    </div>
  );
}
