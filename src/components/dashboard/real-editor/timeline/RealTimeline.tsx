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
  Bug,
  Activity,
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
import { readPersistedBool, writePersistedBool } from "./utils";
import type { DragState, DragMode } from "./utils";
import { MomentPill } from "./MomentPill";
import { TimelineTrack, TrackLabel } from "./TimelineTrack";
import { TimelineRuler, GridLines } from "./TimelineRuler";
import { Playhead } from "./Playhead";
import { GapIndicator, emptyQuartileRanges } from "./GapIndicator";
import { TimelineHeader, type TimelineHealth } from "./TimelineHeader";
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

  // ── Insights state ───────────────────────────────────────────────────
  // The whole analytics block — attention waveform, balance/density/quiet
  // pills, distribution histogram, sources/effects legend, CV debug toggle,
  // and the AI/User track split — lives behind a single "Insights" toggle
  // in the header. Default closed: most users don't need it constantly
  // visible, and the editing surface stays calm.
  //
  // These hooks live ABOVE the empty-timeline early return so React's
  // call order stays stable across renders. The first render of an
  // empty project would otherwise skip these four hooks; once a moment
  // arrived the hook count would jump and React would throw "change in
  // the order of Hooks" (Rules of Hooks).
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  React.useEffect(() => {
    setInsightsOpen(readPersistedBool("adzoom.timeline.insights.open", false));
  }, []);
  const toggleInsights = () => {
    const next = !insightsOpen;
    setInsightsOpen(next);
    writePersistedBool("adzoom.timeline.insights.open", next);
  };
  // Show-separate-lanes is opt-in inside Insights so we don't surprise users
  // with two stacked tracks before they ask for the split.
  const [separateLanes, setSeparateLanes] = React.useState(false);
  React.useEffect(() => {
    setSeparateLanes(readPersistedBool("adzoom.timeline.separateLanes", false));
  }, []);
  const toggleSeparateLanes = () => {
    const next = !separateLanes;
    setSeparateLanes(next);
    writePersistedBool("adzoom.timeline.separateLanes", next);
  };

  if (total > 0 && moments.length === 0) {
    return <EmptyTimeline analyzed={project.analysis?.status === "complete"} />;
  }

  const showNarrative = narrativeSegments.length > 0;

  const showUserRow = separateLanes && userCount > 0;
  const aiHeight = TRACK_HEIGHTS.ai;
  const userHeight = TRACK_HEIGHTS.user;
  // Single merged track when not split — slightly taller than the old AI
  // track so the pills breathe with the extra spacing the brief calls for.
  const mergedHeight = TRACK_HEIGHTS.ai;

  // Single-signal AI health for the header dot. Priority:
  // empty → quiet (any empty quartile) → clustered → balanced.
  const health: TimelineHealth =
    moments.length === 0
      ? "empty"
      : emptyQuartiles > 0
        ? "quiet"
        : isClustered
          ? "clustered"
          : "balanced";

  const onLaneClick = (e: React.PointerEvent) => {
    if (total <= 0 || dragRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    seek(Math.max(0, Math.min(total, pct * total)));
  };

  // Direct read of the click-pipeline diagnostics so the timeline can
  // surface a warning bar when the recording detected clicks but the
  // pipeline failed to turn them into edits. This is the user's
  // primary signal that something is wrong before the Analysis Debug
  // panel below the timeline gets a chance to explain why.
  const clickPipeline = project.analysis?.clickPipeline;
  const showClickLossWarning =
    !!clickPipeline &&
    clickPipeline.totalClicks > 0 &&
    clickPipeline.eventKept === 0;
  const showClickPartialWarning =
    !!clickPipeline &&
    clickPipeline.totalClicks >= 4 &&
    clickPipeline.eventKept > 0 &&
    clickPipeline.eventKept < clickPipeline.totalClicks * 0.4;

  return (
    <div className="glass relative overflow-hidden rounded-3xl">
      <TimelineHeader
        health={health}
        zoom={zoom}
        onZoomOut={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
        onZoomIn={() => setZoom((z) => Math.min(8, Math.round((z + 0.5) * 2) / 2))}
        currentTime={currentTime}
        total={total}
        insightsOpen={insightsOpen}
        onToggleInsights={toggleInsights}
      />

      {showClickLossWarning && (
        <div className="flex items-start gap-2 border-b border-rose-400/25 bg-rose-500/[0.08] px-6 py-2.5 text-[12.5px] text-rose-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-300" />
          <div>
            <strong className="text-white">
              Clicks detected but not turned into zooms.
            </strong>{" "}
            <span className="text-rose-100/85">
              {clickPipeline!.totalClicks} click
              {clickPipeline!.totalClicks === 1 ? "" : "s"} in the recording,
              0 on the timeline. See <em>Analysis Debug</em> below the
              timeline to see which stage dropped them.
            </span>
          </div>
        </div>
      )}
      {!showClickLossWarning && showClickPartialWarning && (
        <div className="flex items-start gap-2 border-b border-amber-400/25 bg-amber-500/[0.08] px-6 py-2.5 text-[12.5px] text-amber-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <div>
            <strong className="text-white">
              Only {clickPipeline!.eventKept} of{" "}
              {clickPipeline!.totalClicks} clicks became zooms.
            </strong>{" "}
            <span className="text-amber-100/85">
              Check Analysis Debug for the drop reason.
            </span>
          </div>
        </div>
      )}

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

      {/* ── Chapters strip ────────────────────────────────────────────
          Simplified: no heading row, no count chip, no "AI-classified"
          caption — the band itself is self-explanatory. Slimmer top
          padding so chapters feel like a soft section divider rather
          than a primary panel. */}
      {showNarrative && (
        <div className="border-b border-white/[0.04] px-6 pb-3.5 pt-3.5">
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
          {/* Left gutter — labels only appear when separate lanes are on.
              In the merged default, the track speaks for itself. */}
          <div className="flex flex-col pr-3">
            <div style={{ height: TRACK_HEIGHTS.ruler }} />
            <div style={{ height: TRACK_HEIGHTS.gap }} />
            {separateLanes ? (
              <>
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
              </>
            ) : (
              <TrackLabel
                Icon={Film}
                label="Edits"
                count={moments.length}
                height={mergedHeight}
                tone="fog"
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

                {/* Quiet-region markers live behind Insights — when the
                    panel is closed we keep the surface clean. */}
                {insightsOpen && <GapIndicator ranges={emptyRanges} />}

                {separateLanes ? (
                  <>
                    {/* AI lane — attention waveform only renders here when
                        Insights is open, so the default surface is flat. */}
                    <TimelineTrack
                      ariaLabel="AI edits track"
                      height={aiHeight}
                    >
                      {insightsOpen &&
                        attentionCurve &&
                        attentionCurve.length > 0 && (
                          <div className="pointer-events-none absolute inset-x-0 inset-y-0 z-0">
                            <AttentionWaveform
                              curve={attentionCurve}
                              duration={total}
                              height={aiHeight}
                              variant="full"
                              className="opacity-70"
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
                  </>
                ) : (
                  // ── Merged "Edits" track ─────────────────────────────
                  // Single calm lane that holds AI + user moments together.
                  // MomentPill already differentiates source via tone (violet
                  // accent for AI, cyan for user) so the visual signal is
                  // preserved without two lanes competing for attention.
                  <TimelineTrack
                    ariaLabel="Edits track"
                    height={mergedHeight}
                  >
                    {insightsOpen &&
                      attentionCurve &&
                      attentionCurve.length > 0 && (
                        <div className="pointer-events-none absolute inset-x-0 inset-y-0 z-0">
                          <AttentionWaveform
                            curve={attentionCurve}
                            duration={total}
                            height={mergedHeight}
                            variant="full"
                            className="opacity-60"
                          />
                        </div>
                      )}
                    <div className="absolute inset-0 z-10">
                      {moments.map((m0) => {
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

      {/* ── Cluster nudge ────────────────────────────────────────────────
          Kept actionable but with neutral styling so it doesn't compete
          with the editing surface. Only shows when there's a real issue. */}
      {isClustered && (
        <div className="mx-6 mt-4 mb-4 flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-400/[0.06] px-3.5 py-2.5 text-[12px] text-amber-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <p className="leading-relaxed">
            Some moments look clustered. Drag them apart, or try a different
            preset.
          </p>
        </div>
      )}

      {/* ── Insights panel (analytics, legends, advanced toggles) ──────── */}
      {insightsOpen && (
        <InsightsPanel
          moments={moments}
          total={total}
          distScore={distScore}
          densityPerMin={densityPerMin}
          emptyQuartiles={emptyQuartiles}
          isClustered={isClustered}
          provenanceCounts={provenanceCounts}
          separateLanes={separateLanes}
          onToggleSeparateLanes={toggleSeparateLanes}
          showCvDebugToggle={!!va && va.sampleCount > 0}
          cvDebug={cvDebug}
          onToggleCvDebug={() => setCvDebug(!cvDebug)}
        />
      )}

      {/* CV debug signals — only when Insights is open AND user opted in. */}
      {insightsOpen && cvDebug && va && va.sampleCount > 0 && (
        <div className="border-t border-white/[0.06] px-6 py-4">
          <CvSignalTracks
            visualAnalysis={va}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Progressive-disclosure panel for everything that used to crowd the header
 * and the bottom strip: balance/density/quiet, distribution histogram,
 * sources legend, effects legend, separate-lanes toggle, CV debug toggle.
 *
 * Lives at the bottom of the timeline so power users can pin it open and
 * scroll past it; first-timers never see it unless they click "Insights".
 */
function InsightsPanel({
  moments,
  total,
  distScore,
  densityPerMin,
  emptyQuartiles,
  isClustered,
  provenanceCounts,
  separateLanes,
  onToggleSeparateLanes,
  showCvDebugToggle,
  cvDebug,
  onToggleCvDebug,
}: {
  moments: DetectedMoment[];
  total: number;
  distScore: number;
  densityPerMin: number;
  emptyQuartiles: number;
  isClustered: boolean;
  provenanceCounts: { event: number; cv: number; ai: number; user: number };
  separateLanes: boolean;
  onToggleSeparateLanes: () => void;
  showCvDebugToggle: boolean;
  cvDebug: boolean;
  onToggleCvDebug: () => void;
}) {
  const showBalance = moments.length >= 2 && total > 0;
  return (
    <div className="border-t border-white/[0.06] bg-white/[0.012] px-6 py-5">
      <div className="mb-4 inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-fog">
        <Activity size={11} className="text-violet-300" />
        Analytics
      </div>

      {/* Key metrics row — replaces the old header chip cluster. */}
      <div className="flex flex-wrap items-center gap-2">
        {showBalance && (
          <Metric
            label={isClustered ? "Clustered" : "Balanced"}
            value={(distScore * 100).toFixed(0)}
            tone={isClustered ? "amber" : "emerald"}
          />
        )}
        {total > 0 && (
          <Metric label="Density" value={`${densityPerMin.toFixed(1)}/min`} tone="fog" />
        )}
        {emptyQuartiles > 0 && (
          <Metric label="Quiet" value={`${emptyQuartiles}/4`} tone="amber" />
        )}
        <Metric label="Moments" value={String(moments.length)} tone="fog" />
      </div>

      {/* Distribution histogram. */}
      {moments.length > 0 && total > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-fog/85">
            Distribution
          </div>
          <DensityBar moments={moments} duration={total} />
        </div>
      )}

      {/* Sources + Effects legend. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2.5 text-[11px] text-fog">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/85">
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
              {provenanceCounts[k as keyof typeof provenanceCounts] !==
                undefined && (
                <span className="font-mono text-[10px] tabular-nums text-fog/70">
                  {provenanceCounts[k as keyof typeof provenanceCounts] ?? 0}
                </span>
              )}
            </span>
          );
        })}
        <span aria-hidden className="hidden h-4 w-px bg-white/10 md:inline-block" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/85">
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

      {/* Advanced toggles — separate lanes + CV debug. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <ToggleChip
          active={separateLanes}
          onClick={onToggleSeparateLanes}
          Icon={Layers}
          label="Split AI / user lanes"
        />
        {showCvDebugToggle && (
          <ToggleChip
            active={cvDebug}
            onClick={onToggleCvDebug}
            Icon={Bug}
            label="CV debug signals"
          />
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber" | "fog";
}) {
  const tint =
    tone === "emerald"
      ? "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-100"
      : tone === "amber"
        ? "border-amber-300/35 bg-amber-400/[0.08] text-amber-100"
        : "border-white/10 bg-white/[0.025] text-white/85";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium",
        tint
      )}
    >
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-80">
        {label}
      </span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

function ToggleChip({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-colors duration-150",
        active
          ? "border-violet-400/40 bg-violet-500/12 text-violet-100"
          : "border-white/10 bg-white/[0.025] text-fog hover:border-white/25 hover:text-white"
      )}
    >
      <Icon size={12} />
      {label}
    </button>
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
