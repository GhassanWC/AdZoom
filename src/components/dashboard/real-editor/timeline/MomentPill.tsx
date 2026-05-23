"use client";

import * as React from "react";
import {
  Sparkles,
  Diamond,
  Scissors,
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
  PROVENANCE_PRESENTATION,
} from "./constants";
import type { DragMode } from "./utils";
import { captureFrame } from "./thumbnails";
import { useEditorReal } from "../context";
import { AttentionWaveform } from "./AttentionWaveform";

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
  onBeginDrag,
  onDuplicate,
  onDelete,
  onEdit,
}: {
  moment: DetectedMoment;
  total: number;
  selected: boolean;
  multiSelected: boolean;
  dragging: boolean;
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { project } = useEditorReal();
  const left = (m.startTime / total) * 100;
  const widthPct = Math.max(1.2, ((m.endTime - m.startTime) / total) * 100);
  const duration = m.endTime - m.startTime;
  const Icon = EFFECT_ICONS[m.effectType] ?? Sparkles;
  const isUser = m.source === "user";
  const hasKeyframes = (m.keyframes?.length ?? 0) > 0;
  const tones = EFFECT_TONES[m.effectType] ?? EFFECT_TONES.zoom;
  const grad = isUser ? tones.user : tones.ai;
  const attention = m.attentionScore ?? m.importance ?? 0.5;
  const intensity =
    m.intensity ?? m.recommendedIntensity ?? attention ?? 0.5;
  const prov = provenanceOf(m);
  const provInfo = PROVENANCE_PRESENTATION[prov];
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
    void captureFrame(videoUrl, sampleAt).then((d) => {
      if (!cancelled && d) setThumb(d);
    });
    return () => {
      cancelled = true;
    };
  }, [videoUrl, m.startTime, m.endTime, tier]);

  return (
    <div
      className={cn(
        "group absolute touch-none transition-[opacity,filter] duration-200",
        dragging ? "z-40" : selected ? "z-30" : "hover:z-20"
      )}
      style={{
        left: `${left}%`,
        width: `${widthPct}%`,
        top: insetY,
        bottom: insetY,
        opacity: bodyOpacity,
      }}
    >
      {/* ── Floating action toolbar ─────────────────────────────────── */}
      {selected && !dragging && (
        <div className="absolute -top-10 left-0 z-50 inline-flex items-center gap-0.5 rounded-xl border border-white/15 bg-ink/95 p-1 shadow-cinematic backdrop-blur-md">
          <PillAction title="Edit moment" onClick={onEdit}>
            <Pencil size={12} />
          </PillAction>
          <PillAction title="Duplicate (⌘D)" onClick={onDuplicate}>
            <Copy size={12} />
          </PillAction>
          <PillAction title="Delete (Del)" onClick={onDelete} danger>
            <Trash2 size={12} />
          </PillAction>
        </div>
      )}

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
        title={`${m.label}\n${provInfo.label} · Confidence ${(confidence * 100).toFixed(0)}\n${
          m.confidenceReason || reasoning
        }\nAttention ${(attention * 100).toFixed(0)} · Intensity ${(intensity * 100).toFixed(0)}${
          m.uiContext ? ` · ${m.uiContext}` : ""
        }`}
        className={cn(
          "relative flex h-full w-full cursor-grab items-stretch overflow-hidden rounded-xl border bg-gradient-to-br text-left text-white backdrop-blur-sm active:cursor-grabbing",
          "shadow-[0_10px_28px_-14px_rgba(0,0,0,0.85)] transition-all duration-200",
          grad,
          dragging && cn("ring-2 ring-white/90", tones.glow),
          selected && !dragging && cn("ring-2 ring-white/95", tones.glow),
          multiSelected && !selected && !dragging && "ring-2 ring-rose-400/80",
          !selected && !multiSelected && !dragging &&
            cn(
              "ring-1 ring-white/10 hover:ring-white/55 hover:scale-[1.005]",
              tones.hoverGlow
            ),
          m.sceneChange && !selected && !multiSelected && "ring-1 ring-amber-300/80"
        )}
      >
        {/* Left accent bar — confidence height. Violet for AI, cyan for user. */}
        <span
          aria-hidden
          className={cn(
            "absolute bottom-1 left-0 w-[3px] rounded-r-full",
            isUser ? "bg-cyan-200" : "bg-violet-200"
          )}
          style={{
            top: `${Math.max(4, (1 - confidence) * 100)}%`,
            boxShadow: isUser
              ? "0 0 8px rgba(165,243,252,0.7)"
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
                isUser ? "ring-cyan-200/40" : "ring-white/20"
              )}
            >
              <Icon size={11} className="opacity-95" />
            </span>
            {tier !== "icon" && (
              <span className="truncate text-[12.5px] font-semibold leading-tight tracking-tight">
                {m.label}
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
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-lg text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white",
        danger && "hover:bg-rose-500/20 hover:text-rose-200"
      )}
    >
      {children}
    </button>
  );
}
