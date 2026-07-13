"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Sparkles,
  Diamond,
  Scissors,
  SquareSplitHorizontal as SplitIcon,
  Copy,
  Trash2,
  Pencil,
  Check,
} from "lucide-react";
import type {
  DetectedMoment,
  MomentProvenance,
  UIContext,
} from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";
import {
  EFFECT_ICONS,
  EFFECT_TONES,
  MIN_PILL_PX,
  MIN_RENDER_DURATION,
  isDirectorEdit,
  presentationFor,
} from "./constants";
import type { DragMode } from "./utils";
import { captureFrame } from "./thumbnails";
import { useEditorReal } from "../context";
import { AttentionWaveform } from "./AttentionWaveform";
import { cropAspectLabel } from "@/lib/timeline/crop-speed";

function provenanceOf(m: DetectedMoment): MomentProvenance {
  if (m.provenance) return m.provenance;
  if (m.source === "user") return "user";
  return "ai";
}

/**
 * Short, human reasoning string. Prefers the AI editorial `reason` (set by
 * the labeling pass), then a confidence-source hint, then a derived
 * uiContext + provenance phrase. Always returns something — never empty.
 */
function shortReasoning(m: DetectedMoment): string {
  if (m.reason && m.reason.trim().length > 0) return m.reason;
  const p = provenanceOf(m);
  const ctx = m.uiContext;
  if (p === "event") {
    if (ctx === "button") return "Click on a button";
    if (ctx === "form") return "Filling a form field";
    if (ctx === "scroll") return "Scroll spike";
    return "Real interaction event";
  }
  if (p === "cv") {
    if (ctx === "modal" || ctx === "dialog") return "Modal reveal";
    if (ctx === "navigation") return "Page transition";
    if (ctx === "scroll") return "Scroll detected";
    return "Motion spike detected";
  }
  if (p === "ai" || p === "ai-override") {
    if (ctx === "result") return "Result reveal";
    if (ctx === "modal" || ctx === "dialog") return "Cinematic reveal";
    if (ctx === "code") return "Code focus moment";
    return "AI editorial pick";
  }
  return "Your manual edit";
}

const CONTEXT_LABEL: Partial<Record<UIContext, string>> = {
  button: "Button",
  modal: "Modal",
  dialog: "Dialog",
  form: "Form",
  code: "Code",
  navigation: "Nav",
  scroll: "Scroll",
  result: "Result",
  media: "Media",
  text: "Text",
  menu: "Menu",
};

// ── The selected pill's action toolbar ──────────────────────────────────────
//
// It is PORTALLED to <body> and positioned `fixed`. Two bugs forced that, and
// both are properties of where the lanes live, not of the toolbar:
//
//   1. CLIPPED. The lanes sit in an `overflow-auto` viewport, so a toolbar
//      hanging above a top-lane pill was cut off — invisible, Edit button and
//      all.
//   2. UNCLICKABLE. `MomentLane` wraps each row's pills in `absolute inset-0
//      z-10`, which is a STACKING CONTEXT: a pill's z-30/z-50 is sealed inside
//      its own lane. Flipping the toolbar below the pill therefore put it
//      underneath the NEXT row's lane container — transparent, so it still
//      looked fine, but that container is hit-testable and swallowed every
//      press (the timeline seeked instead). Raising the pill's z-index cannot
//      fix this; the cap is the ancestor.
//
// A fixed, portalled element has no clipping ancestor and no stacking cage, so
// neither failure is reachable. It tracks the pill on scroll / resize / zoom,
// and hides when the pill scrolls out of the lane viewport (a toolbar floating
// over the preview, anchored to a pill you can't see, is worse than none).

/** Toolbar box: 4 × 28px buttons + gaps + padding. Used to place, not to size. */
const TOOLBAR_W_PX = 132;
const TOOLBAR_H_PX = 36;
const TOOLBAR_GAP_PX = 8;

interface ToolbarPos {
  top: number;
  left: number;
}

/**
 * Where the selected pill's toolbar goes, in viewport coordinates — or null when
 * it shouldn't be shown at all.
 *
 * Above the pill by default (it never covers the edit you're working on), below
 * when there isn't room above inside the lane viewport. Clamped horizontally to
 * that viewport so a pill at the far right doesn't push it off the panel.
 *
 * Only ever runs for the ONE selected pill, so this is a single set of listeners,
 * not one per pill on a 400-edit timeline.
 */
function useToolbarPosition(
  ref: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  /** Changes whenever the pill's geometry does (zoom, drag commit, retime). */
  geometry: string
): ToolbarPos | null {
  const [pos, setPos] = React.useState<ToolbarPos | null>(null);

  React.useLayoutEffect(() => {
    if (!active) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest<HTMLElement>("[data-timeline-scroll]");

    const measure = () => {
      const pill = el.getBoundingClientRect();
      const clip = scroller
        ? scroller.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight);

      // Scrolled out of the lane viewport → nothing to anchor to.
      if (
        pill.bottom <= clip.top ||
        pill.top >= clip.bottom ||
        pill.right <= clip.left ||
        pill.left >= clip.right
      ) {
        setPos(null);
        return;
      }

      const roomAbove = pill.top - clip.top >= TOOLBAR_H_PX + TOOLBAR_GAP_PX;
      const top = roomAbove
        ? pill.top - TOOLBAR_H_PX - TOOLBAR_GAP_PX
        : pill.bottom + TOOLBAR_GAP_PX;
      const left = Math.max(
        clip.left + 4,
        Math.min(pill.left, clip.right - TOOLBAR_W_PX - 4)
      );

      setPos((prev) =>
        prev && prev.top === top && prev.left === left ? prev : { top, left }
      );
    };

    measure();
    // Capture: the lane viewport is the scroller that matters, but any ancestor
    // scroll moves the pill under a fixed toolbar.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [active, ref, geometry]);

  return pos;
}

/** The selected pill's actions: Edit · Split · Duplicate · Delete. */
function PillToolbar({
  anchorRef,
  active,
  geometry,
  canSplit,
  onEdit,
  onSplit,
  onDuplicate,
  onDelete,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  active: boolean;
  geometry: string;
  canSplit: boolean;
  onEdit: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const pos = useToolbarPosition(anchorRef, active, geometry);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!active || !pos || !mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      // On <body> now, outside the timeline's hold region — it has to claim the
      // attribute itself, or pressing one of these buttons reads as an
      // outside-press and dismisses the moment inspector it just opened.
      data-editor-dialog-hold
      // The lane's seek handler listens on pointerdown and REACT PORTALS STILL
      // BUBBLE THROUGH THE REACT TREE — without this, pressing a button here
      // would also scrub the playhead to wherever the pill happens to sit.
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      className="z-[60] inline-flex items-center gap-0.5 rounded-xl border border-white/15 bg-ink/95 p-1 shadow-cinematic backdrop-blur-md"
    >
      <PillAction title="Edit moment" onClick={onEdit}>
        <Pencil size={12} />
      </PillAction>
      <PillAction
        // Disabled rather than hidden when the playhead isn't inside this pill:
        // a button that appears and vanishes as you scrub is harder to hit than
        // one that's simply greyed out, and the tooltip explains it.
        title={
          canSplit
            ? "Split at the playhead (S)"
            : "Move the playhead inside this edit to split it (S)"
        }
        onClick={onSplit}
        disabled={!canSplit}
      >
        <SplitIcon size={12} />
      </PillAction>
      <PillAction title="Duplicate (⌘D)" onClick={onDuplicate}>
        <Copy size={12} />
      </PillAction>
      <PillAction title="Delete (Del)" onClick={onDelete} danger>
        <Trash2 size={12} />
      </PillAction>
    </div>,
    document.body
  );
}

/**
 * Cinematic draggable moment pill. The visual hierarchy is driven by
 * attention: high-attention pills fill their track height fully and bring
 * stronger gradients; low-attention ones are inset and dimmed. Selected /
 * hovered pills glow in their effect colour.
 *
 * Layout (when wide enough):
 *   [ Thumbnail | Icon + Title + Reasoning | Provenance + Confidence bar ]
 *
 * Drag contract (onBeginDrag) is unchanged from the previous design.
 */
export function MomentPill({
  moment: m,
  total,
  selected,
  multiSelected,
  dragging,
  canSplit,
  onBeginDrag,
  onDuplicate,
  onSplit,
  onDelete,
  onEdit,
}: {
  moment: DetectedMoment;
  total: number;
  selected: boolean;
  multiSelected: boolean;
  dragging: boolean;
  /** The playhead is inside this edit and both halves would be long enough. */
  canSplit: boolean;
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { project } = useEditorReal();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // Duration drives the clip width. Guard against missing/zero/NaN end times so
  // a moment never collapses to a zero-width sliver — it still renders as a
  // small block (and a px floor below keeps short clips from becoming hairline
  // markers). Real durations scale proportionally.
  const rawDur = m.endTime - m.startTime;
  const duration = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const renderDur = duration > 0 ? duration : MIN_RENDER_DURATION;
  const left = total > 0 ? (m.startTime / total) * 100 : 0;
  const widthPct = total > 0 ? (renderDur / total) * 100 : 2;
  const Icon = EFFECT_ICONS[m.effectType] ?? Sparkles;
  const isUser = m.source === "user";
  // An AI Director edit. It is an ORDINARY moment in every functional respect
  // (drag, resize, split, disable, delete all work on it unchanged) — this flag
  // only changes how it LOOKS, so the user can tell at a glance which edits came
  // from their prompt and which they made themselves.
  const isDirector = isDirectorEdit(m);
  const hasKeyframes = (m.keyframes?.length ?? 0) > 0;
  const tones = EFFECT_TONES[m.effectType] ?? EFFECT_TONES.zoom;
  const grad = isUser ? tones.user : tones.ai;
  const attention = m.attentionScore ?? m.importance ?? 0.5;
  const intensity =
    m.intensity ?? m.recommendedIntensity ?? attention ?? 0.5;
  const prov = provenanceOf(m);
  const provInfo = presentationFor(m);
  // A restored cut is inactive (range kept) — render it dimmed.
  const cutRestored = m.effectType === "cut" && m.cut?.active === false;
  // A disabled overlay is hidden from preview/export (kept on the timeline) —
  // render it dimmed like a restored cut so its off-state reads at a glance.
  const overlayDisabled = m.enabled === false;
  // Crop shows its target aspect (9:16); speed shows its multiplier (2×); a cut
  // shows how much it removes (or "Restored" when inactive).
  const badge =
    m.effectType === "speed-up"
      ? `${m.speed?.multiplier ?? 2}×`
      : m.effectType === "crop"
        ? cropAspectLabel(m.crop?.aspectRatio)
        : m.effectType === "cut"
          ? cutRestored
            ? "Restored"
            : `−${duration.toFixed(duration < 10 ? 1 : 0)}s`
          : null;
  // Source chip for cut/crop/speed: who generated it — you, AI (Gemini), or the
  // deterministic engine.
  const provBadge =
    m.effectType === "crop" || m.effectType === "speed-up" || m.effectType === "cut"
      ? isUser
        ? "You"
        : prov === "ai"
          ? m.effectType === "crop"
            ? "AI Reframe"
            : m.effectType === "cut"
              ? "Suggested"
              : "AI pacing"
          : "Engine"
      : null;
  const confidence = m.confidenceScore ?? attention;
  const reasoning = shortReasoning(m);
  const ctxLabel = m.uiContext ? CONTEXT_LABEL[m.uiContext] : undefined;

  // Visual weight from attention — important moments fill their lane, weak
  // ones recess slightly so they don't compete.
  const insetY = attention > 0.7 ? 2 : attention > 0.45 ? 5 : 9;
  const bodyOpacity = selected || dragging
    ? 1
    : 0.72 + Math.min(0.28, attention * 0.4);

  // Compact mode tiers: thumbnails need ~120px, full label needs ~180px.
  // We approximate by treating each 1% of timeline width as ~5px on a 500px
  // viewport — narrow pills collapse to icon-only.
  const approxPx = (widthPct / 100) * 500;
  const tier: "icon" | "label" | "thumb" =
    approxPx < 76 ? "icon" : approxPx < 168 ? "label" : "thumb";

  // ── Thumbnail capture ──────────────────────────────────────────────────
  const [thumb, setThumb] = React.useState<string | null>(null);
  const videoUrl = project.originalVideoUrl;
  React.useEffect(() => {
    if (tier !== "thumb" || !videoUrl) {
      setThumb(null);
      return;
    }
    let cancelled = false;
    // Sample at startTime + 5% of the moment so we don't always show a
    // transition frame — usually the first frame is mid-cut.
    const sampleAt = m.startTime + (m.endTime - m.startTime) * 0.05;
    void captureFrame(videoUrl, sampleAt, project.sourceCrop).then((d) => {
      if (!cancelled && d) setThumb(d);
    });
    return () => {
      cancelled = true;
    };
  }, [videoUrl, m.startTime, m.endTime, tier, project.sourceCrop]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "group absolute touch-none transition-[opacity,filter] duration-200",
        dragging ? "z-40" : selected ? "z-30" : "hover:z-20",
        // A restored cut is inactive — desaturate it so it reads as "kept".
        cutRestored && "saturate-[0.4]"
      )}
      style={{
        left: `${left}%`,
        width: `${widthPct}%`,
        // Floor the rendered width so short real-duration clips read as blocks,
        // not hairline markers, while longer clips still scale by %.
        minWidth: `${MIN_PILL_PX}px`,
        top: insetY,
        bottom: insetY,
        opacity: cutRestored || overlayDisabled ? bodyOpacity * 0.5 : bodyOpacity,
      }}
    >
      {/* ── Floating action toolbar — portalled, see useToolbarPosition ─── */}
      <PillToolbar
        anchorRef={rootRef}
        active={selected && !dragging}
        geometry={`${left}:${widthPct}`}
        canSplit={canSplit}
        onEdit={onEdit}
        onSplit={onSplit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />

      {multiSelected && (
        <span
          aria-label="Selected for bulk action"
          className="pointer-events-none absolute -right-1.5 -top-1.5 z-30 inline-flex size-4 items-center justify-center rounded-full bg-rose-500 text-white shadow-cinematic ring-2 ring-ink"
        >
          <Check size={9} strokeWidth={3} />
        </span>
      )}

      <button
        type="button"
        onPointerDown={(e) => onBeginDrag(e, m, "move")}
        // Double-click opens the edit's settings — the gesture every timeline
        // editor has, and a second way in that doesn't depend on the toolbar
        // being on-screen.
        onDoubleClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        title={`${m.label}\n${provInfo.label} · Confidence ${(confidence * 100).toFixed(0)}\n${
          m.confidenceReason || reasoning
        }\nAttention ${(attention * 100).toFixed(0)} · Intensity ${(intensity * 100).toFixed(0)}${
          m.uiContext ? ` · ${m.uiContext}` : ""
        }`}
        className={cn(
          "relative flex h-full w-full cursor-grab items-stretch overflow-hidden rounded-xl border bg-gradient-to-br text-left text-white backdrop-blur-sm active:cursor-grabbing",
          // Named properties, not `all`: a timeline can hold hundreds of these,
          // and `transition-all` makes the browser watch every animatable
          // property on every one of them. Ring/shadow carry the selected-glow
          // fade; transform carries the hover lift — both composite cheaply.
          "shadow-[0_10px_28px_-14px_rgba(0,0,0,0.85)]",
          "transition-[box-shadow,transform,--tw-ring-color,--tw-ring-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
          grad,
          dragging && cn("ring-2 ring-white/90", tones.glow),
          selected && !dragging && cn("ring-2 ring-white/95", tones.glow),
          multiSelected && !selected && !dragging && "ring-2 ring-rose-400/80",
          !selected && !multiSelected && !dragging &&
            cn(
              // Lift + brighten on hover. `fv-lift` is pointer-gated, so a tap on
              // a touch device can't leave a pill stuck in the hovered state.
              "fv-lift hover:ring-white/55",
              tones.hoverGlow,
              // A Director edit carries a standing fuchsia ring at rest, so a
              // timeline full of them reads as "the Director did this" without
              // the user having to click anything.
              isDirector ? "ring-1 ring-fuchsia-300/55" : "ring-1 ring-white/10"
            ),
          m.sceneChange && !selected && !multiSelected && !isDirector &&
            "ring-1 ring-amber-300/80"
        )}
      >
        {/* Left accent bar — confidence height. Cyan = you, fuchsia = the
            Director, violet = the analysis engines. */}
        <span
          aria-hidden
          className={cn(
            "absolute bottom-1 left-0 w-[3px] rounded-r-full",
            isUser ? "bg-cyan-200" : isDirector ? "bg-fuchsia-200" : "bg-violet-200"
          )}
          style={{
            top: `${Math.max(4, (1 - confidence) * 100)}%`,
            boxShadow: isUser
              ? "0 0 8px rgba(165,243,252,0.7)"
              : isDirector
                ? "0 0 8px rgba(240,171,252,0.75)"
                : "0 0 8px rgba(196,181,253,0.7)",
          }}
        />

        {/* ── Body grid: thumb / content / meta ───────────────────── */}
        {tier === "thumb" && (
          <ThumbCell thumb={thumb} duration={duration} />
        )}

        <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "relative inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-black/30 ring-1",
                isUser
                  ? "ring-cyan-200/40"
                  : isDirector
                    ? "ring-fuchsia-200/50"
                    : "ring-white/20"
              )}
            >
              <Icon size={11} className="opacity-95" />
            </span>
            {tier !== "icon" && (
              <span className="truncate text-[12.5px] font-semibold leading-tight tracking-tight">
                {m.label}
              </span>
            )}
            {badge && (
              <span className="ml-0.5 shrink-0 rounded bg-black/40 px-1 py-[1px] text-[9.5px] font-bold tabular-nums leading-none ring-1 ring-white/25">
                {badge}
              </span>
            )}
            {tier !== "icon" && provBadge && (
              <span className="shrink-0 rounded bg-white/10 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide leading-none text-white/80 ring-1 ring-white/15">
                {provBadge}
              </span>
            )}
            {tier !== "icon" && hasKeyframes && (
              <Diamond
                size={9}
                className="ml-0.5 shrink-0 text-white/85"
                aria-label="Has keyframes"
              />
            )}
            {tier !== "icon" && m.sceneChange && (
              <Scissors
                size={9}
                className="ml-0.5 shrink-0 text-amber-100"
                aria-label="Scene change"
              />
            )}
          </div>

          {tier !== "icon" && (
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[9.5px] font-medium leading-none",
                  provInfo.chip
                )}
              >
                <provInfo.Icon size={8.5} strokeWidth={2.5} />
                {provInfo.short}
              </span>
              {ctxLabel && tier === "thumb" && (
                <span className="rounded-full bg-black/30 px-1.5 py-[1px] text-[9.5px] font-medium leading-none text-white/75 ring-1 ring-white/10">
                  {ctxLabel}
                </span>
              )}
              <span className="truncate text-[10.5px] leading-tight text-white/80">
                {reasoning}
              </span>
            </div>
          )}
        </div>

        {/* Right meta column — duration + attention mini sparkline. */}
        {tier === "thumb" && (
          <div className="relative flex w-[58px] shrink-0 flex-col items-end justify-between border-l border-white/10 bg-black/15 px-1.5 py-1.5">
            <span className="font-mono text-[10px] tabular-nums leading-none text-white/85">
              {duration.toFixed(1)}s
            </span>
            <AttentionSpark
              moment={m}
              project={project.analysis?.attentionCurve}
              total={total}
            />
            <span className="font-mono text-[9px] uppercase tracking-wider leading-none text-white/65">
              ATN {Math.round(attention * 100)}
            </span>
          </div>
        )}
        {tier === "label" && (
          <span className="relative ml-auto self-center pr-2 font-mono text-[10px] tabular-nums text-white/80">
            {duration.toFixed(1)}s
          </span>
        )}

        {/* Intensity ribbon at the bottom — width = intensity. */}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-white/85 via-white/65 to-white/40"
          style={{ width: `${Math.round(intensity * 100)}%` }}
        />
      </button>

      {/* ── Resize handles ───────────────────────────────────────── */}
      <span
        onPointerDown={(e) => onBeginDrag(e, m, "resize-l")}
        className="absolute inset-y-0 -left-1 z-10 w-2.5 cursor-ew-resize"
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-150",
            selected || dragging
              ? "bg-white opacity-100 shadow-[0_0_8px_rgba(255,255,255,0.6)]"
              : "bg-white/60 opacity-0 group-hover:opacity-100"
          )}
        />
      </span>
      <span
        onPointerDown={(e) => onBeginDrag(e, m, "resize-r")}
        className="absolute inset-y-0 -right-1 z-10 w-2.5 cursor-ew-resize"
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 top-1/2 h-8 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-150",
            selected || dragging
              ? "bg-white opacity-100 shadow-[0_0_8px_rgba(255,255,255,0.6)]"
              : "bg-white/60 opacity-0 group-hover:opacity-100"
          )}
        />
      </span>
    </div>
  );
}

function ThumbCell({
  thumb,
  duration,
}: {
  thumb: string | null;
  duration: number;
}) {
  return (
    <div className="relative ml-1 my-1 hidden h-[calc(100%-0.5rem)] w-[64px] shrink-0 overflow-hidden rounded-lg bg-black/30 ring-1 ring-white/10 lg:block">
      {thumb ? (
        // Using a plain <img>: thumbnails are runtime-generated data URLs, so
        // next/image's optimizer can't help here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-white/[0.06] to-white/[0.02]"
        />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 text-right font-mono text-[9px] tabular-nums text-white/80">
        {duration.toFixed(1)}s
      </span>
    </div>
  );
}

function AttentionSpark({
  moment,
  project,
  total,
}: {
  moment: DetectedMoment;
  project: number[] | undefined;
  total: number;
}) {
  if (!project || project.length === 0 || total <= 0) {
    return <span className="h-3 w-full" aria-hidden />;
  }
  return (
    <AttentionWaveform
      curve={project}
      duration={total}
      window={{ start: moment.startTime, end: moment.endTime }}
      variant="spark"
      height={16}
      className="opacity-95"
    />
  );
}

function PillAction({
  children,
  title,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white",
        danger && "hover:bg-rose-500/20 hover:text-rose-200",
        "disabled:pointer-events-none disabled:opacity-35"
      )}
    >
      {children}
    </button>
  );
}
