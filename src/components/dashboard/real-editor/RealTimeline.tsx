"use client";

import * as React from "react";
import {
  Sparkles,
  MessageSquare,
  AlertTriangle,
  Activity,
  MousePointer2,
  Target,
  FastForward,
  Zap,
  Scissors,
  Bug,
  Copy,
  Trash2,
  ZoomIn,
  ZoomOut,
  Diamond,
  Film,
  User,
} from "lucide-react";
import { useEditorReal } from "./context";
import { cn } from "@/lib/cn";
import { distributionScore } from "@/lib/timeline-balancer";
import { CvSignalTracks } from "./CvSignalTracks";
import type {
  DetectedMoment,
  EffectType,
  NarrativeRole,
} from "@/lib/firebase/schema";

const EFFECT_ICONS: Record<EffectType, typeof Sparkles> = {
  zoom: Zap,
  "click-highlight": Target,
  "cursor-focus": MousePointer2,
  "speed-up": FastForward,
};

const NARRATIVE_COLORS: Record<NarrativeRole, string> = {
  intro: "bg-cyan-400/40",
  setup: "bg-indigo-400/40",
  action: "bg-violet-500/50",
  explanation: "bg-emerald-400/40",
  result: "bg-amber-400/50",
  transition: "bg-white/15",
  filler: "bg-white/[0.05]",
};

const NARRATIVE_LABEL: Record<NarrativeRole, string> = {
  intro: "Intro",
  setup: "Setup",
  action: "Action",
  explanation: "Explain",
  result: "Result",
  transition: "Transition",
  filler: "Filler",
};

const EFFECT_TONES: Record<
  EffectType,
  { ai: string; user: string; dot: string; label: string }
> = {
  zoom: {
    ai: "from-violet-500/80 to-violet-400/60 border-violet-300/50",
    user: "from-cyan-400/80 to-cyan-300/60 border-cyan-200/60",
    dot: "bg-violet-300",
    label: "Zoom",
  },
  "click-highlight": {
    ai: "from-fuchsia-500/80 to-violet-400/60 border-fuchsia-300/50",
    user: "from-cyan-400/80 to-fuchsia-400/60 border-cyan-200/60",
    dot: "bg-fuchsia-300",
    label: "Click",
  },
  "cursor-focus": {
    ai: "from-indigo-400/80 to-violet-400/60 border-indigo-200/50",
    user: "from-cyan-400/80 to-indigo-400/60 border-cyan-200/60",
    dot: "bg-indigo-300",
    label: "Focus",
  },
  "speed-up": {
    ai: "from-amber-400/80 to-amber-300/60 border-amber-200/60",
    user: "from-cyan-400/80 to-amber-400/60 border-cyan-200/60",
    dot: "bg-amber-300",
    label: "Speed",
  },
};

const SNAP_PX = 7;
const CLICK_PX = 4;
const MIN_MOMENT_LEN = 0.3;

type DragMode = "move" | "resize-l" | "resize-r";

interface DragState {
  id: string;
  mode: DragMode;
  pointerStartX: number;
  origStart: number;
  origEnd: number;
  moved: boolean;
}

export function RealTimeline() {
  const {
    project,
    currentTime,
    duration,
    seek,
    selectedMomentId,
    setSelectedMomentId,
    cvDebug,
    setCvDebug,
    updateMoment,
    deleteMoment,
    duplicateMoment,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const captions = project.analysis?.suggestedCaptions ?? [];
  const boring = project.analysis?.boringSections ?? [];
  const va = project.visualAnalysis;
  const total = duration > 0 ? duration : project.duration ?? 0;

  const [zoom, setZoom] = React.useState(1);
  const trackRef = React.useRef<HTMLDivElement | null>(null);

  const [draft, setDraft] = React.useState<{
    id: string;
    startTime: number;
    endTime: number;
  } | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const [snapGuide, setSnapGuide] = React.useState<number | null>(null);

  const distScore = React.useMemo(
    () => distributionScore(moments, total),
    [moments, total]
  );
  const quartileCoverage = React.useMemo<[boolean, boolean, boolean, boolean]>(() => {
    if (total <= 0) return [false, false, false, false];
    const q = total / 4;
    const c: [boolean, boolean, boolean, boolean] = [false, false, false, false];
    for (const m of moments) {
      const idx = Math.min(3, Math.max(0, Math.floor(m.startTime / q)));
      c[idx] = true;
    }
    return c;
  }, [moments, total]);
  const emptyQuartiles = quartileCoverage.filter((c) => !c).length;
  const densityPerMin = total > 0 ? moments.length / (total / 60) : 0;
  const isClustered = moments.length >= 3 && distScore < 0.55;

  const aiCount = moments.filter((m) => m.source !== "user").length;
  const userCount = moments.length - aiCount;

  const snapTime = React.useCallback(
    (t: number, pxPerSec: number, excludeId: string): { t: number; snapped: number | null } => {
      if (pxPerSec <= 0) return { t, snapped: null };
      const tol = SNAP_PX / pxPerSec;
      const magnets: number[] = [currentTime, 0, total];
      for (const m of moments) {
        if (m.id === excludeId) continue;
        magnets.push(m.startTime, m.endTime);
      }
      magnets.push(Math.round(t * 2) / 2);
      let best: number | null = null;
      let bestDist = tol;
      for (const mag of magnets) {
        const d = Math.abs(mag - t);
        if (d < bestDist) {
          bestDist = d;
          best = mag;
        }
      }
      return best !== null ? { t: best, snapped: best } : { t, snapped: null };
    },
    [currentTime, total, moments]
  );

  const beginDrag = React.useCallback(
    (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => {
      e.stopPropagation();
      dragRef.current = {
        id: m.id,
        mode,
        pointerStartX: e.clientX,
        origStart: m.startTime,
        origEnd: m.endTime,
        moved: false,
      };
      setDraft({ id: m.id, startTime: m.startTime, endTime: m.endTime });
    },
    []
  );

  React.useEffect(() => {
    if (!draft) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || !track || total <= 0) return;
      const pxPerSec = track.getBoundingClientRect().width / total;
      const deltaPx = e.clientX - drag.pointerStartX;
      if (Math.abs(deltaPx) > CLICK_PX) drag.moved = true;
      const deltaSec = deltaPx / pxPerSec;
      const len = drag.origEnd - drag.origStart;

      let nextStart = drag.origStart;
      let nextEnd = drag.origEnd;
      let guide: number | null = null;

      if (drag.mode === "move") {
        let s = drag.origStart + deltaSec;
        s = Math.max(0, Math.min(total - len, s));
        const snapS = snapTime(s, pxPerSec, drag.id);
        const snapE = snapTime(s + len, pxPerSec, drag.id);
        if (snapS.snapped !== null) {
          s = snapS.t;
          guide = snapS.snapped;
        } else if (snapE.snapped !== null) {
          s = snapE.t - len;
          guide = snapE.snapped;
        }
        s = Math.max(0, Math.min(total - len, s));
        nextStart = s;
        nextEnd = s + len;
      } else if (drag.mode === "resize-l") {
        let s = drag.origStart + deltaSec;
        s = Math.max(0, Math.min(drag.origEnd - MIN_MOMENT_LEN, s));
        const snap = snapTime(s, pxPerSec, drag.id);
        s = Math.max(0, Math.min(drag.origEnd - MIN_MOMENT_LEN, snap.t));
        guide = snap.snapped;
        nextStart = s;
        nextEnd = drag.origEnd;
      } else {
        let en = drag.origEnd + deltaSec;
        en = Math.min(total, Math.max(drag.origStart + MIN_MOMENT_LEN, en));
        const snap = snapTime(en, pxPerSec, drag.id);
        en = Math.min(total, Math.max(drag.origStart + MIN_MOMENT_LEN, snap.t));
        guide = snap.snapped;
        nextStart = drag.origStart;
        nextEnd = en;
      }

      setDraft({ id: drag.id, startTime: nextStart, endTime: nextEnd });
      setSnapGuide(guide);
    };

    const onUp = () => {
      const drag = dragRef.current;
      const d = draft;
      dragRef.current = null;
      setSnapGuide(null);
      if (!drag) {
        setDraft(null);
        return;
      }
      if (drag.moved && d) {
        void updateMoment(drag.id, {
          startTime: Number(d.startTime.toFixed(3)),
          endTime: Number(d.endTime.toFixed(3)),
        });
      } else {
        setSelectedMomentId(drag.id);
        seek(Math.min(drag.origEnd - 0.01, drag.origStart + 0.05));
      }
      setDraft(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [draft, total, snapTime, updateMoment, setSelectedMomentId, seek]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedMomentId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void deleteMoment(selectedMomentId);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void duplicateMoment(selectedMomentId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedMomentId, deleteMoment, duplicateMoment]);

  const withDraft = (m: DetectedMoment): DetectedMoment =>
    draft && draft.id === m.id
      ? { ...m, startTime: draft.startTime, endTime: draft.endTime }
      : m;

  // Empty state — no moments yet.
  if (total > 0 && moments.length === 0) {
    return <EmptyTimeline analyzed={project.analysis?.status === "complete"} />;
  }

  return (
    <div className="glass overflow-hidden rounded-2xl">
      {/* ── header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20">
            <Film size={14} />
          </span>
          <div>
            <h3 className="font-display text-[15px] font-semibold text-white">
              Timeline
            </h3>
            <p className="text-[11.5px] text-fog">
              <span className="text-violet-200">{aiCount} AI</span>
              {" · "}
              <span className="text-cyan-200">{userCount} yours</span>
              {" · "}
              {captions.length} caption{captions.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {moments.length >= 2 && total > 0 && (
            <span
              title={`Distribution score: ${(distScore * 100).toFixed(
                0
              )}/100. Higher = more evenly spread.`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium",
                isClustered
                  ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
                  : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
              )}
            >
              <Activity size={11} />
              {isClustered ? "Clustered" : "Balanced"} · {(distScore * 100).toFixed(0)}
            </span>
          )}
          {total > 0 && (
            <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-fog">
              {densityPerMin.toFixed(1)}/min
            </span>
          )}
          {emptyQuartiles > 0 && (
            <span
              title="Some quartiles of the video have no detected activity"
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200"
            >
              <AlertTriangle size={11} />
              {emptyQuartiles}/4 empty
            </span>
          )}

          <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
            <button
              type="button"
              aria-label="Zoom timeline out"
              onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
              disabled={zoom <= 1}
              className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomOut size={13} />
            </button>
            <span className="w-9 text-center font-mono text-[11px] tabular-nums text-fog">
              {zoom.toFixed(1)}×
            </span>
            <button
              type="button"
              aria-label="Zoom timeline in"
              onClick={() => setZoom((z) => Math.min(8, Math.round((z + 0.5) * 2) / 2))}
              disabled={zoom >= 8}
              className="inline-flex size-7 items-center justify-center rounded-md text-fog transition-colors duration-150 hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
            >
              <ZoomIn size={13} />
            </button>
          </div>
          {va && va.sampleCount > 0 && (
            <button
              type="button"
              onClick={() => setCvDebug(!cvDebug)}
              title="Toggle CV debug signals"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors duration-150",
                cvDebug
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.03] text-fog hover:border-white/25 hover:text-white"
              )}
            >
              <Bug size={11} />
              CV debug
            </button>
          )}
          <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[12px] tabular-nums text-white/85">
            {fmt(currentTime)}
            <span className="text-fog"> / {fmt(total)}</span>
          </span>
        </div>
      </div>

      {/* ── editor track ── */}
      <div className="px-5 pt-5">
        <div className="overflow-x-auto overflow-y-visible pb-2">
          <div
            ref={trackRef}
            className="relative h-32 select-none rounded-xl border border-white/[0.05] bg-gradient-to-b from-white/[0.03] to-white/[0.01]"
            style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            onPointerDown={(e) => {
              if (total <= 0 || dragRef.current) return;
              const r = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - r.left) / r.width;
              seek(Math.max(0, Math.min(total, pct * total)));
            }}
          >
            {/* quartile shading */}
            {total > 0 &&
              quartileCoverage.map((covered, i) => (
                <div
                  key={`q${i}`}
                  className={cn("absolute inset-y-0 z-0", !covered && "bg-amber-500/[0.04]")}
                  style={{ left: `${i * 25}%`, width: "25%" }}
                />
              ))}
            {total > 0 &&
              [25, 50, 75].map((pct) => (
                <span
                  key={pct}
                  className="pointer-events-none absolute inset-y-2 z-[1] w-px bg-white/[0.05]"
                  style={{ left: `${pct}%` }}
                />
              ))}

            {/* boring sections */}
            {boring.map((b, i) => {
              if (total <= 0) return null;
              return (
                <div
                  key={i}
                  title={`Idle: ${b.reason}`}
                  className="absolute inset-y-0 z-0 bg-amber-500/[0.05]"
                  style={{
                    left: `${(b.startTime / total) * 100}%`,
                    width: `${((b.endTime - b.startTime) / total) * 100}%`,
                  }}
                />
              );
            })}

            {/* moment pills — bigger, cleaner */}
            <div className="absolute inset-x-0 top-3 z-10 h-20">
              {moments.map((m0) => {
                if (total <= 0) return null;
                const m = withDraft(m0);
                return (
                  <MomentPill
                    key={m0.id}
                    moment={m}
                    total={total}
                    selected={selectedMomentId === m0.id}
                    dragging={draft?.id === m0.id}
                    onBeginDrag={beginDrag}
                    onDuplicate={() => duplicateMoment(m0.id)}
                    onDelete={() => deleteMoment(m0.id)}
                  />
                );
              })}
            </div>

            {/* caption markers */}
            <div className="absolute inset-x-0 bottom-3 z-10 h-3">
              {captions.map((c, i) => {
                if (total <= 0) return null;
                return (
                  <span
                    key={i}
                    title={`"${c.text}"`}
                    className="absolute top-0 -translate-x-1/2"
                    style={{ left: `${(c.startTime / total) * 100}%` }}
                  >
                    <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-cyan-400/30 text-cyan-200 ring-1 ring-cyan-300/30">
                      <MessageSquare size={8} />
                    </span>
                  </span>
                );
              })}
            </div>

            {/* snap guide */}
            {snapGuide !== null && total > 0 && (
              <span
                className="pointer-events-none absolute inset-y-0 z-20 w-px bg-cyan-300/80 shadow-[0_0_6px_rgba(34,211,238,0.8)]"
                style={{ left: `${(snapGuide / total) * 100}%` }}
              />
            )}

            {/* playhead */}
            {total > 0 && (
              <span
                className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-white shadow-[0_0_10px_rgba(255,255,255,0.7)]"
                style={{ left: `${(currentTime / total) * 100}%` }}
              >
                <span className="absolute -top-1.5 left-1/2 inline-block size-2.5 -translate-x-1/2 rotate-45 bg-white" />
              </span>
            )}
          </div>
        </div>

        <p className="mt-3 text-[11.5px] text-fog/80">
          Drag pills to move · drag edges to retime · click to preview ·{" "}
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
            Del
          </kbd>{" "}
          remove ·{" "}
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
            ⌘D
          </kbd>{" "}
          duplicate
        </p>
      </div>

      {/* ── secondary band: narrative + density ── */}
      <div className="space-y-3 px-5 pb-5 pt-2">
        {total > 0 && (project.analysis?.narrativeStructure?.length ?? 0) > 0 && (
          <NarrativeBand
            segments={project.analysis!.narrativeStructure!}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        )}

        {total > 0 && moments.length > 0 && (
          <DensityBar moments={moments} duration={total} />
        )}
      </div>

      {/* CV debug signals */}
      {cvDebug && va && va.sampleCount > 0 && (
        <div className="border-t border-white/[0.06] px-5 py-4">
          <CvSignalTracks
            visualAnalysis={va}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        </div>
      )}

      {/* cluster warning */}
      {isClustered && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/[0.06] px-4 py-3 text-[12px] text-amber-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <div className="font-semibold text-amber-200">
              Moments look clustered.
            </div>
            <p className="mt-0.5 leading-relaxed text-amber-100/85">
              Drag them apart, or try a different preset — the timeline re-balances
              automatically.
            </p>
          </div>
        </div>
      )}

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] bg-white/[0.01] px-5 py-3 text-[11px] text-fog">
        {(Object.keys(EFFECT_TONES) as EffectType[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block size-2.5 rounded-sm bg-gradient-to-br",
                EFFECT_TONES[k].ai.replace(/border-[^\s]+/, "")
              )}
            />
            {EFFECT_TONES[k].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <Diamond size={10} className="text-violet-300" />
          Keyframed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <User size={10} className="text-cyan-300" />
          Your edit
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-amber-500/30" />
          Empty quartile
        </span>
      </div>
    </div>
  );
}

function EmptyTimeline({ analyzed }: { analyzed: boolean }) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 left-1/3 h-48 w-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_70%)] blur-2xl"
      />
      <div className="relative grid place-items-center text-center">
        <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20">
          <Film size={20} />
        </div>
        <h3 className="mt-4 font-display text-lg font-semibold text-white">
          {analyzed ? "Your timeline is empty" : "Nothing on the timeline yet"}
        </h3>
        <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-fog">
          {analyzed
            ? "Use the toolbar above to add your first zoom, focus, or click highlight at the playhead."
            : "Run AI analysis to generate a first-draft edit, or add edits manually with the toolbar above."}
        </p>
      </div>
    </div>
  );
}

/** A draggable, resizable moment pill — bigger, prettier, AI vs user clear. */
function MomentPill({
  moment: m,
  total,
  selected,
  dragging,
  onBeginDrag,
  onDuplicate,
  onDelete,
}: {
  moment: DetectedMoment;
  total: number;
  selected: boolean;
  dragging: boolean;
  onBeginDrag: (e: React.PointerEvent, m: DetectedMoment, mode: DragMode) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const left = (m.startTime / total) * 100;
  const width = Math.max(1.2, ((m.endTime - m.startTime) / total) * 100);
  const intensity =
    m.intensity ?? m.recommendedIntensity ?? m.attentionScore ?? m.importance ?? 0.5;
  const attention = m.attentionScore ?? m.importance ?? 0.5;
  const Icon = EFFECT_ICONS[m.effectType] ?? Sparkles;
  const isUser = m.source === "user";
  const hasKeyframes = (m.keyframes?.length ?? 0) > 0;
  const tones = EFFECT_TONES[m.effectType] ?? EFFECT_TONES.zoom;
  const grad = isUser ? tones.user : tones.ai;

  // Pill height scales with intensity — gives a visual sense of impact.
  const height = 56 + Math.round(intensity * 18);

  return (
    <div
      className={cn(
        "group absolute bottom-0 touch-none transition-[box-shadow,transform] duration-200",
        dragging ? "z-40" : selected ? "z-30" : "hover:z-20"
      )}
      style={{ left: `${left}%`, width: `${width}%`, height: `${height}px` }}
    >
      {selected && !dragging && (
        <div className="absolute -top-9 left-0 flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Duplicate (⌘D)"
            className="inline-flex size-7 items-center justify-center rounded-lg border border-white/15 bg-ink/95 text-fog shadow-cinematic backdrop-blur-md transition-colors duration-150 hover:text-white"
          >
            <Copy size={11} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Delete (Del)"
            className="inline-flex size-7 items-center justify-center rounded-lg border border-white/15 bg-ink/95 text-fog shadow-cinematic backdrop-blur-md transition-colors duration-150 hover:border-rose-400/40 hover:text-rose-300"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      <button
        type="button"
        onPointerDown={(e) => onBeginDrag(e, m, "move")}
        title={`${m.label} — ${m.reason}\nAttention ${(attention * 100).toFixed(
          0
        )} · Intensity ${(intensity * 100).toFixed(0)}${
          m.uiContext ? ` · ${m.uiContext}` : ""
        }\nDrag to move · drag edges to retime`}
        className={cn(
          "relative flex h-full w-full cursor-grab flex-col justify-between overflow-hidden rounded-xl border bg-gradient-to-br px-2.5 py-2 text-left text-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur-sm active:cursor-grabbing",
          grad,
          dragging && "cursor-grabbing ring-2 ring-white shadow-violet-glow",
          selected && !dragging && "-translate-y-1 ring-2 ring-white shadow-violet-glow",
          !selected && !dragging && "ring-1 ring-transparent hover:ring-white/40",
          m.sceneChange && !selected && "ring-1 ring-amber-300/70"
        )}
        style={{ opacity: selected || dragging ? 1 : 0.78 + attention * 0.22 }}
      >
        {/* Header row: icon + label */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-black/30 backdrop-blur-sm",
              isUser ? "ring-1 ring-cyan-200/40" : "ring-1 ring-white/15"
            )}
          >
            <Icon size={11} className="opacity-95" />
          </span>
          <span className="min-w-0 truncate text-[12px] font-semibold leading-tight">
            {m.label}
          </span>
        </div>

        {/* Footer row: source + meta */}
        <div className="flex items-center justify-between gap-1.5 text-[10px] font-medium opacity-90">
          <span className="inline-flex items-center gap-1">
            {isUser ? (
              <>
                <User size={9} />
                <span className="uppercase tracking-wider">You</span>
              </>
            ) : (
              <>
                <Sparkles size={9} />
                <span className="uppercase tracking-wider">AI</span>
              </>
            )}
            {hasKeyframes && <Diamond size={9} className="ml-0.5" />}
            {m.sceneChange && (
              <Scissors
                size={9}
                className="ml-0.5 text-amber-100"
                aria-label="scene change"
              />
            )}
          </span>
          <span className="font-mono tabular-nums opacity-85">
            {(m.endTime - m.startTime).toFixed(1)}s
          </span>
        </div>

        {/* intensity fill */}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[3px] bg-white/75"
          style={{ width: `${Math.round(intensity * 100)}%` }}
        />
      </button>

      {/* resize handles */}
      <span
        onPointerDown={(e) => onBeginDrag(e, m, "resize-l")}
        className={cn(
          "absolute -left-1 top-0 h-full w-2.5 cursor-ew-resize rounded-l",
          (selected || dragging) && "bg-white/25"
        )}
      />
      <span
        onPointerDown={(e) => onBeginDrag(e, m, "resize-r")}
        className={cn(
          "absolute -right-1 top-0 h-full w-2.5 cursor-ew-resize rounded-r",
          (selected || dragging) && "bg-white/25"
        )}
      />
    </div>
  );
}

function DensityBar({
  moments,
  duration,
}: {
  moments: { startTime: number }[];
  duration: number;
}) {
  const BUCKETS = 24;
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const m of moments) {
    const idx = Math.min(
      BUCKETS - 1,
      Math.max(0, Math.floor((m.startTime / duration) * BUCKETS))
    );
    counts[idx]++;
  }
  const max = Math.max(1, ...counts);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
        <span>Distribution</span>
        <span className="font-mono normal-case tracking-normal">
          {fmt(0)} → {fmt(duration / 2)} → {fmt(duration)}
        </span>
      </div>
      <div
        className="flex h-6 items-end gap-[2px] rounded-lg border border-white/[0.06] bg-white/[0.015] px-1.5 py-1"
        aria-hidden
      >
        {counts.map((c, i) => {
          const h = (c / max) * 100;
          return (
            <span
              key={`bucket-${i}`}
              title={`${c} moment${c === 1 ? "" : "s"} in this 1/${BUCKETS} of the timeline`}
              className={cn(
                "flex-1 rounded-sm transition-colors duration-150",
                c === 0
                  ? "bg-white/[0.04]"
                  : "bg-gradient-to-t from-violet-500/70 to-cyan-400/70"
              )}
              style={{ height: `${Math.max(10, h)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

function NarrativeBand({
  segments,
  duration,
  currentTime,
  onSeek,
}: {
  segments: { startTime: number; endTime: number; role: NarrativeRole; label: string }[];
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">
        <span>Narrative structure</span>
        <span className="font-mono normal-case tracking-normal">
          {segments.length} segments
        </span>
      </div>
      <div className="relative flex h-8 gap-[2px] rounded-lg border border-white/[0.06] bg-white/[0.015] p-0.5">
        {segments.map((s, i) => {
          const width = ((s.endTime - s.startTime) / duration) * 100;
          const active = currentTime >= s.startTime && currentTime <= s.endTime;
          return (
            <button
              key={`${s.startTime}-${i}`}
              type="button"
              onClick={() => onSeek(s.startTime)}
              title={`${s.label} (${NARRATIVE_LABEL[s.role]})`}
              className={cn(
                "relative flex h-full items-center justify-center overflow-hidden rounded-md px-2 text-[10px] font-semibold uppercase tracking-wider text-white/90 transition-all duration-150",
                NARRATIVE_COLORS[s.role],
                active && "ring-1 ring-white/70"
              )}
              style={{ width: `${Math.max(2, width)}%` }}
            >
              <span className="truncate">
                {NARRATIVE_LABEL[s.role]}
                {s.label && width > 8 ? ` · ${s.label}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
