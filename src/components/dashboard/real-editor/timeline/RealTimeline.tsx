"use client";

import * as React from "react";
import {
  Sparkles,
  User,
  AlertTriangle,
  Trash2,
  Check,
  X as XIcon,
  Film,
  Diamond,
  Layers,
} from "lucide-react";
import { useEditorReal } from "../context";
import { cn } from "@/lib/cn";
import { distributionScore } from "@/lib/timeline-balancer";
import { CvSignalTracks } from "../CvSignalTracks";
import type { DetectedMoment } from "@/lib/firebase/schema";
import {
  EFFECT_TONES,
  GUTTER_WIDTH,
  MIN_MOMENT_LEN,
  SNAP_PX,
  CLICK_PX,
  TRACK_HEIGHTS,
  PROVENANCE_PRESENTATION,
} from "./constants";
import type { DragState, DragMode } from "./utils";
import { MomentPill } from "./MomentPill";
import { TimelineTrack, TrackLabel } from "./TimelineTrack";
import { TimelineRuler, GridLines } from "./TimelineRuler";
import { Playhead } from "./Playhead";
import { GapIndicator, emptyQuartileRanges } from "./GapIndicator";
import { TimelineHeader } from "./TimelineHeader";
import { CollapsibleSection } from "./CollapsibleSection";
import { NarrativeBand } from "./NarrativeBand";
import { DensityBar } from "./DensityBar";
import { AttentionWaveform } from "./AttentionWaveform";

/**
 * Track-based timeline orchestrator. Owns drag math, snap math, multi-select
 * state, and keyboard shortcuts. Visual structure splits across `timeline/*`
 * primitives — this file is the cinematic stage that puts chapters, the
 * attention waveform, the tracks, and the playhead together.
 */
export function RealTimeline() {
  const {
    project,
    currentTime,
    duration,
    seek,
    selectedMomentId,
    setSelectedMomentId,
    multiSelectIds,
    toggleMultiSelect,
    clearMultiSelect,
    deleteMultiSelected,
    openInspector,
    cvDebug,
    setCvDebug,
    updateMoment,
    deleteMoment,
    duplicateMoment,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const va = project.visualAnalysis;
  const total = duration > 0 ? duration : project.duration ?? 0;
  const narrativeSegments = project.analysis?.narrativeStructure ?? [];
  const attentionCurve = project.analysis?.attentionCurve;

  const aiMoments = React.useMemo(
    () => moments.filter((m) => m.source !== "user"),
    [moments]
  );
  const userMoments = React.useMemo(
    () => moments.filter((m) => m.source === "user"),
    [moments]
  );
  const provenanceCounts = React.useMemo(() => {
    const counts = { event: 0, cv: 0, ai: 0, user: 0 };
    for (const m of moments) {
      if (m.source === "user") {
        counts.user += 1;
        continue;
      }
      const p = m.provenance ?? "ai";
      if (p === "event") counts.event += 1;
      else if (p === "cv") counts.cv += 1;
      else counts.ai += 1;
    }
    return counts;
  }, [moments]);

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
  const emptyRanges = React.useMemo(
    () => emptyQuartileRanges(moments, total),
    [moments, total]
  );
  const emptyQuartiles = emptyRanges.length;
  const densityPerMin = total > 0 ? moments.length / (total / 60) : 0;
  const isClustered = moments.length >= 3 && distScore < 0.55;
  const aiCount = aiMoments.length;
  const userCount = userMoments.length;

  const snapTime = React.useCallback(
    (
      t: number,
      pxPerSec: number,
      excludeId: string
    ): { t: number; snapped: number | null } => {
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
        multiKey: e.shiftKey || e.metaKey || e.ctrlKey,
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
      } else if (drag.multiKey) {
        toggleMultiSelect(drag.id);
      } else {
        setSelectedMomentId(drag.id);
        clearMultiSelect();
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
  }, [
    draft,
    total,
    snapTime,
    updateMoment,
    setSelectedMomentId,
    toggleMultiSelect,
    clearMultiSelect,
    seek,
  ]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (multiSelectIds.length > 0) {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          void deleteMultiSelected();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          clearMultiSelect();
          return;
        }
      }
      if (!selectedMomentId) return;
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
  }, [
    selectedMomentId,
    multiSelectIds,
    deleteMoment,
    duplicateMoment,
    deleteMultiSelected,
    clearMultiSelect,
  ]);

  const withDraft = (m: DetectedMoment): DetectedMoment =>
    draft && draft.id === m.id
      ? { ...m, startTime: draft.startTime, endTime: draft.endTime }
      : m;

  if (total > 0 && moments.length === 0) {
    return <EmptyTimeline analyzed={project.analysis?.status === "complete"} />;
  }

  const showUserRow = userCount > 0;
  const showNarrative = narrativeSegments.length > 0;
  const aiHeight = TRACK_HEIGHTS.ai;
  const userHeight = TRACK_HEIGHTS.user;

  const onLaneClick = (e: React.PointerEvent) => {
    if (total <= 0 || dragRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    seek(Math.max(0, Math.min(total, pct * total)));
  };

  return (
    <div className="glass relative overflow-hidden rounded-3xl">
      <TimelineHeader
        aiCount={provenanceCounts.ai}
        userCount={provenanceCounts.user}
        eventCount={provenanceCounts.event}
        cvCount={provenanceCounts.cv}
        distScore={distScore}
        isClustered={isClustered}
        densityPerMin={densityPerMin}
        emptyQuartiles={emptyQuartiles}
        showBalanceBadge={moments.length >= 2 && total > 0}
        showDensityBadge={total > 0}
        zoom={zoom}
        onZoomOut={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
        onZoomIn={() => setZoom((z) => Math.min(8, Math.round((z + 0.5) * 2) / 2))}
        showCvDebugToggle={!!va && va.sampleCount > 0}
        cvDebug={cvDebug}
        onToggleCvDebug={() => setCvDebug(!cvDebug)}
        currentTime={currentTime}
        total={total}
        attentionCurve={attentionCurve}
      />

      {multiSelectIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-400/25 bg-rose-500/[0.08] px-6 py-2.5 text-[12px] text-rose-100">
          <span className="inline-flex items-center gap-2">
            <Check size={12} className="text-rose-300" />
            <span>
              <strong className="text-white">{multiSelectIds.length}</strong>{" "}
              moment{multiSelectIds.length === 1 ? "" : "s"} selected
            </span>
            <span className="hidden text-rose-200/70 sm:inline">
              · shift / ⌘-click pills to extend
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void deleteMultiSelected()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/45 bg-rose-500/20 px-2.5 py-1 text-[11px] font-medium text-rose-50 transition-colors duration-150 hover:border-rose-400/70 hover:bg-rose-500/30"
            >
              <Trash2 size={11} />
              Delete {multiSelectIds.length}
            </button>
            <button
              type="button"
              onClick={() => clearMultiSelect()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
            >
              <XIcon size={11} />
              Clear
            </button>
          </span>
        </div>
      )}

      {/* ── Cinematic chapters strip ─────────────────────────────────── */}
      {showNarrative && (
        <div className="border-b border-white/[0.06] px-6 pb-4 pt-5">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.2em] text-fog">
              <Layers size={11} className="text-violet-300" />
              Chapters
              <span className="rounded-full bg-white/[0.04] px-2 py-[1px] font-mono text-[9.5px] tabular-nums tracking-wider text-fog/80">
                {narrativeSegments.length}
              </span>
            </div>
            <span className="hidden text-[10.5px] uppercase tracking-[0.16em] text-fog/60 md:inline">
              AI-classified narrative beats
            </span>
          </div>
          <NarrativeBand
            segments={narrativeSegments}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        </div>
      )}

      {/* ── Tracks ───────────────────────────────────────────────────── */}
      <div className="px-6 pt-5">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `clamp(40px, 12vw, ${GUTTER_WIDTH}px) minmax(0, 1fr)`,
          }}
        >
          {/* Left gutter */}
          <div className="flex flex-col pr-3">
            <div style={{ height: TRACK_HEIGHTS.ruler }} />
            <div style={{ height: TRACK_HEIGHTS.gap }} />
            <TrackLabel
              Icon={Sparkles}
              label="AI edits"
              count={aiCount}
              height={aiHeight}
              tone="violet"
            />
            {showUserRow && (
              <TrackLabel
                Icon={User}
                label="Your edits"
                count={userCount}
                height={userHeight}
                tone="cyan"
              />
            )}
          </div>

          {/* Right side — scrollable, zoom-scaled lane viewport */}
          <div className="overflow-x-auto overflow-y-visible pb-3">
            <div
              className="relative select-none"
              style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            >
              <TimelineRuler total={total} />

              <div
                ref={trackRef}
                className="relative"
                onPointerDown={onLaneClick}
              >
                <GridLines total={total} />

                <GapIndicator ranges={emptyRanges} />

                {/* AI track — attention waveform sits behind the pills as a
                    cinematic backdrop. */}
                <TimelineTrack
                  ariaLabel="AI edits track"
                  height={aiHeight}
                  className="bg-gradient-to-b from-violet-500/[0.04] via-violet-500/[0.02] to-transparent"
                >
                  {attentionCurve && attentionCurve.length > 0 && (
                    <div className="pointer-events-none absolute inset-x-0 inset-y-0 z-0">
                      <AttentionWaveform
                        curve={attentionCurve}
                        duration={total}
                        height={aiHeight}
                        variant="full"
                        className="opacity-90"
                      />
                    </div>
                  )}
                  <div className="absolute inset-0 z-10">
                    {aiMoments.map((m0) => {
                      const m = withDraft(m0);
                      return (
                        <MomentPill
                          key={m0.id}
                          moment={m}
                          total={total}
                          selected={selectedMomentId === m0.id}
                          multiSelected={multiSelectIds.includes(m0.id)}
                          dragging={draft?.id === m0.id}
                          onBeginDrag={beginDrag}
                          onDuplicate={() => duplicateMoment(m0.id)}
                          onDelete={() => deleteMoment(m0.id)}
                          onEdit={() => {
                            setSelectedMomentId(m0.id);
                            openInspector();
                          }}
                        />
                      );
                    })}
                  </div>
                </TimelineTrack>

                {showUserRow && (
                  <TimelineTrack
                    ariaLabel="Your edits track"
                    height={userHeight}
                    className="bg-gradient-to-b from-cyan-400/[0.04] via-cyan-400/[0.02] to-transparent"
                  >
                    {userMoments.map((m0) => {
                      const m = withDraft(m0);
                      return (
                        <MomentPill
                          key={m0.id}
                          moment={m}
                          total={total}
                          selected={selectedMomentId === m0.id}
                          multiSelected={multiSelectIds.includes(m0.id)}
                          dragging={draft?.id === m0.id}
                          onBeginDrag={beginDrag}
                          onDuplicate={() => duplicateMoment(m0.id)}
                          onDelete={() => deleteMoment(m0.id)}
                          onEdit={() => {
                            setSelectedMomentId(m0.id);
                            openInspector();
                          }}
                        />
                      );
                    })}
                  </TimelineTrack>
                )}

                {snapGuide !== null && total > 0 && (
                  <span
                    className="pointer-events-none absolute inset-y-0 z-20 w-px bg-cyan-300/80 shadow-[0_0_6px_rgba(34,211,238,0.8)]"
                    style={{ left: `${(snapGuide / total) * 100}%` }}
                  />
                )}

                <Playhead
                  currentTime={currentTime}
                  total={total}
                  rulerHeight={TRACK_HEIGHTS.ruler}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Secondary band: distribution (collapsed by default) ─────────── */}
      {moments.length > 0 && total > 0 && (
        <div className="space-y-2 px-6 pb-5 pt-3">
          <CollapsibleSection
            title="Distribution"
            storageKey="adzoom.timeline.distribution.open"
            meta={<span>{moments.length}-moment histogram</span>}
          >
            <DensityBar moments={moments} duration={total} />
          </CollapsibleSection>
        </div>
      )}

      {/* CV debug signals */}
      {cvDebug && va && va.sampleCount > 0 && (
        <div className="border-t border-white/[0.06] px-6 py-4">
          <CvSignalTracks
            visualAnalysis={va}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        </div>
      )}

      {/* Cluster warning */}
      {isClustered && (
        <div className="mx-6 mb-5 flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-500/[0.06] px-4 py-3 text-[12px] text-amber-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <div className="font-semibold text-amber-200">
              Moments look clustered.
            </div>
            <p className="mt-0.5 leading-relaxed text-amber-100/85">
              Drag them apart, or try a different preset — the timeline
              re-balances automatically.
            </p>
          </div>
        </div>
      )}

      {/* ── Provenance + effect legend ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-white/[0.06] bg-white/[0.015] px-6 py-3.5 text-[11px] text-fog">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fog/70">
          Sources
        </span>
        {(["event", "cv", "ai", "ai-override", "user"] as const).map((k) => {
          const p = PROVENANCE_PRESENTATION[k];
          return (
            <span
              key={k}
              title={p.blurb}
              className="inline-flex items-center gap-1.5"
            >
              <p.Icon size={11} className="text-white/80" />
              <span className="text-white/85">{p.label}</span>
            </span>
          );
        })}
        <span aria-hidden className="hidden h-4 w-px bg-white/10 md:inline-block" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fog/70">
          Effects
        </span>
        {(Object.keys(EFFECT_TONES) as Array<keyof typeof EFFECT_TONES>).map(
          (k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block size-2.5 rounded-sm bg-gradient-to-br",
                  EFFECT_TONES[k].ai.replace(/border-[^\s]+/, "")
                )}
              />
              {EFFECT_TONES[k].label}
            </span>
          )
        )}
        <span className="inline-flex items-center gap-1.5">
          <Diamond size={10} className="text-violet-300" />
          Keyframed
        </span>
      </div>
    </div>
  );
}

function EmptyTimeline({ analyzed }: { analyzed: boolean }) {
  return (
    <div className="glass relative overflow-hidden rounded-3xl p-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 left-1/3 h-48 w-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.22),transparent_70%)] blur-2xl"
      />
      <div className="relative grid place-items-center text-center">
        <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25 shadow-[0_8px_24px_-12px_rgba(139,92,246,0.6)]">
          <Film size={22} />
        </div>
        <h3 className="mt-5 font-display text-xl font-semibold tracking-tight text-white">
          {analyzed ? "Your timeline is empty" : "Nothing on the timeline yet"}
        </h3>
        <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-fog">
          {analyzed
            ? "Use the toolbar above to add your first zoom, focus, or click highlight at the playhead."
            : "Run AI analysis to generate a first-draft edit, or add edits manually with the toolbar above."}
        </p>
      </div>
    </div>
  );
}
