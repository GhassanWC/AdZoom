"use client";

import * as React from "react";
import {
  Sparkles,
  MousePointer2,
  FastForward,
  Scissors,
  AlertTriangle,
  Trash2,
  Check,
  X as XIcon,
  Film,
  Diamond,
  Bug,
  Activity,
  Layers,
} from "lucide-react";
import { useEditorReal } from "../context";
import { cn } from "@/lib/cn";
import { distributionScore } from "@/lib/timeline-balancer";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { CvSignalTracks } from "../CvSignalTracks";
import type { DetectedMoment } from "@/lib/firebase/schema";
import { isOverlayEffectType } from "@/lib/firebase/schema";
import type { AnalysisOptions, EngineLayer } from "@/lib/analysis/engine-layers";
import {
  EFFECT_TONES,
  GUTTER_WIDTH,
  MIN_MOMENT_LEN,
  MIN_PILL_PX,
  SNAP_PX,
  CLICK_PX,
  TRACK_HEIGHTS,
  PROVENANCE_PRESENTATION,
} from "./constants";
import { readPersistedBool, writePersistedBool } from "./utils";
import type { DragState, DragMode } from "./utils";
import { TimelineTrack, TrackLabel } from "./TimelineTrack";
import { TimelineRuler, GridLines } from "./TimelineRuler";
import { Playhead } from "./Playhead";
import { GapIndicator, emptyQuartileRanges } from "./GapIndicator";
import { TimelineToolbar, type TimelineHealth } from "./TimelineToolbar";
import { NarrativeBand } from "./NarrativeBand";
import { DensityBar } from "./DensityBar";
import { AttentionWaveform } from "./AttentionWaveform";
import { useTimelineMetrics } from "./useTimelineMetrics";
import { MomentLane } from "./MomentLane";
import { InteractionsLane } from "./InteractionsLane";
import type { TimelineTrackDescriptor } from "./trackModel";

/**
 * Track-based timeline orchestrator. Owns drag math, snap math, multi-select
 * state, and keyboard shortcuts. The visual surface is a stack of DAW-style
 * track rows (Edits, Cuts, Speed, and Cursor / Focus when real
 * cursor data exists) built from an ordered `TimelineTrackDescriptor[]`, so new
 * track types are config, not a render-tree rewrite. Analytics chrome
 * (attention waveform, narrative chapters, density) stays behind the Insights
 * toggle.
 */
export function RealTimeline() {
  const {
    project,
    videoRef,
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
    addMomentAtPlayhead,
    undo,
    redo,
    canUndo,
    canRedo,
    interactions,
    interactionsLoading,
    startAnalyze,
    analyzing,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const va = project.visualAnalysis;
  const total = duration > 0 ? duration : project.duration ?? 0;
  const narrativeSegments = project.analysis?.narrativeStructure ?? [];
  const attentionCurve = project.analysis?.attentionCurve;

  // Cut and Speed each live on their OWN track (any source). The unified
  // "Edits" track holds ALL camera/click effects — AI-generated AND manual —
  // so there's no redundant empty "Your edits" row (manual zoom/focus edits
  // appear here alongside AI ones, distinguished by their provenance colour).
  // Crop is demoted: any legacy crop moments are excluded from Edits but have
  // no dedicated track.
  const isOwnTrack = (m: DetectedMoment) =>
    m.effectType === "crop" ||
    m.effectType === "speed-up" ||
    m.effectType === "cut" ||
    isOverlayEffectType(m.effectType);
  const cutMoments = React.useMemo(
    () => moments.filter((m) => m.effectType === "cut"),
    [moments]
  );
  // Phase-3 overlays (captions/hook/text/callout/blur/transition/branding +
  // smart-crop) share ONE "Overlays" lane so they never crowd the Edits lane.
  const overlayMoments = React.useMemo(
    () => moments.filter((m) => isOverlayEffectType(m.effectType)),
    [moments]
  );
  // Cut summary for the track header — "{active} active · {removed}s removed".
  const cutMap = React.useMemo(
    () => buildTimelineMap(moments, total),
    [moments, total]
  );
  const speedMoments = React.useMemo(
    () => moments.filter((m) => m.effectType === "speed-up"),
    [moments]
  );
  const editMoments = React.useMemo(
    () => moments.filter((m) => !isOwnTrack(m)),
    [moments]
  );

  // Engine selection from the most recent analysis — drives the "Disabled for
  // this analysis" gutter note and the one-click "Run this layer" affordance on
  // empty lanes. A targeted run enables only that layer in "keep" mode, so it
  // adds the missing layer without touching anything else on the timeline.
  const lastRun = project.analysis?.lastRunOptions;
  const layerDisabled = React.useCallback(
    (layer: EngineLayer): boolean => {
      if (!lastRun) return false;
      if (layer === "camera") return !lastRun.generateCameraEdits;
      if (layer === "cut") return !lastRun.generateCut;
      return !lastRun.generateSpeed;
    },
    [lastRun]
  );
  const runLayer = React.useCallback(
    (layer: EngineLayer) => {
      if (analyzing) return;
      const options: AnalysisOptions = {
        generateCameraEdits: layer === "camera",
        generateCut: layer === "cut",
        generateSpeed: layer === "speed",
        existingEditMode: "keep",
        // Reuse the granularity from the last run so a targeted top-up matches.
        chunkMode: lastRun?.chunkMode ?? "balanced",
        chunkSizeSeconds: lastRun?.chunkSizeSeconds ?? 30,
      };
      void startAnalyze(options);
    },
    [analyzing, startAnalyze, lastRun]
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

  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  // Scale model: percentage layout stays, but zoom + a measured px/sec are
  // derived here. `trackRef` (the content element) is what the drag math also
  // reads, so the two never disagree.
  const { zoom, pxPerSec, zoomIn, zoomOut, fitToScreen, minZoom, maxZoom } =
    useTimelineMetrics({ total, contentRef: trackRef });
  const onFit = React.useCallback(() => {
    fitToScreen();
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
  }, [fitToScreen]);

  // Per-moment render diagnostics (req): start / end / duration / renderedWidthPx.
  // Logged once per (count, total, zoom) change so a "narrow marker" regression
  // is immediately visible (e.g. duration ~0 or renderedWidthPx ≈ MIN_PILL_PX).
  const momentDiagRef = React.useRef<string>("");
  React.useEffect(() => {
    if (moments.length === 0 || total <= 0) return;
    const sig = `${moments.length}:${total.toFixed(1)}:${Math.round(pxPerSec)}`;
    if (momentDiagRef.current === sig) return;
    momentDiagRef.current = sig;
    // eslint-disable-next-line no-console
    console.info(
      "[timeline] moment render",
      moments.map((m) => {
        const dur = m.endTime - m.startTime;
        const validDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
        return {
          id: m.id,
          startTime: Number(m.startTime?.toFixed?.(2) ?? m.startTime),
          endTime: Number(m.endTime?.toFixed?.(2) ?? m.endTime),
          duration: Number(validDur.toFixed(2)),
          renderedWidthPx: Math.round(Math.max(MIN_PILL_PX, validDur * pxPerSec)),
        };
      })
    );
  }, [moments, total, pxPerSec]);

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
  const editCount = editMoments.length;

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
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable === true;
      if (typing) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // ── Undo / redo (global — no selection required) ───────────────────
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo();
        else void undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        void redo();
        return;
      }

      // ── Space → play / pause ───────────────────────────────────────────
      if ((e.key === " " || e.code === "Space") && !mod) {
        // Defer to natively-activatable controls (the play button, toolbar
        // buttons, links) so Space doesn't toggle twice when one is focused.
        const interactive =
          tag === "BUTTON" ||
          tag === "A" ||
          el?.getAttribute("role") === "button";
        if (interactive) return;
        e.preventDefault();
        const v = videoRef.current;
        if (v) {
          if (v.paused) void v.play().catch(() => {});
          else v.pause();
        }
        return;
      }

      // ── Selection-scoped actions ───────────────────────────────────────
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
      } else if (mod && key === "d") {
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
    undo,
    redo,
    videoRef,
  ]);

  const withDraft = (m: DetectedMoment): DetectedMoment =>
    draft && draft.id === m.id
      ? { ...m, startTime: draft.startTime, endTime: draft.endTime }
      : m;

  // ── Insights state ───────────────────────────────────────────────────
  // The whole analytics block — attention waveform, balance/density/quiet
  // pills, distribution histogram, sources/effects legend, CV debug toggle —
  // lives behind a single "Insights" toggle in the toolbar. Default closed so
  // the DAW editing surface stays calm; power users pin it open.
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  React.useEffect(() => {
    setInsightsOpen(readPersistedBool("adzoom.timeline.insights.open", false));
  }, []);
  const toggleInsights = () => {
    const next = !insightsOpen;
    setInsightsOpen(next);
    writePersistedBool("adzoom.timeline.insights.open", next);
  };

  const hasMoments = moments.length > 0;
  const showNarrative = narrativeSegments.length > 0;

  // Single-signal AI health for the toolbar dot. Priority:
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

  // "Edit" = select the moment; the docked inspector reflects it, and the
  // modal fallback (small screens) opens off `inspectorOpen`.
  const onEditMoment = (id: string) => {
    setSelectedMomentId(id);
    openInspector();
  };

  // Count of discrete cursor events for the interactions-lane label.
  const interactionClickCount = interactions
    ? interactions.filter(
        (e) =>
          e.type === "click" || e.type === "dblclick" || e.type === "rightclick"
      ).length
    : clickPipeline?.totalClicks ?? 0;

  // Show the Cursor/Focus track ONLY when real interaction data exists — hide
  // the bare "No cursor data" lane for uploads / recordings without a cursor
  // sidecar. Counts hovers too (they're cursor data) and detected clicks. Kept
  // visible while a sidecar is still loading so the track doesn't pop in late.
  const cursorMarkerCount = interactions
    ? interactions.filter(
        (e) =>
          e.type === "click" ||
          e.type === "dblclick" ||
          e.type === "rightclick" ||
          e.type === "hover"
      ).length
    : 0;
  const hasCursorData =
    cursorMarkerCount > 0 || (clickPipeline?.totalClicks ?? 0) > 0;
  const showInteractionsTrack =
    hasCursorData || (interactionsLoading && !!project.interactionsPath);

  // ── Ordered DAW track stack ─────────────────────────────────────────────
  // The orchestrator maps this twice: gutter labels + lanes. Future track
  // kinds (captions, audio, transitions, real speed/crop) slot in as more
  // descriptors — no render-tree surgery.
  const tracks: TimelineTrackDescriptor[] = [
    {
      id: "ai",
      kind: "ai",
      // Unified camera-edits track — AI + manual zoom/focus/click together.
      label: "Edits",
      Icon: Sparkles,
      height: TRACK_HEIGHTS.ai,
      tone: "violet",
      interactive: true,
      count: editCount,
      note: layerDisabled("camera") ? "Disabled for this analysis" : undefined,
      emptyAction: { label: "Run Camera edits", onRun: () => runLayer("camera") },
      renderLane: () => (
        <>
          {insightsOpen && attentionCurve && attentionCurve.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 inset-y-0 z-0">
              <AttentionWaveform
                curve={attentionCurve}
                duration={total}
                height={TRACK_HEIGHTS.ai}
                variant="full"
                className="opacity-70"
              />
            </div>
          )}
          <MomentLane
            moments={editMoments}
            total={total}
            selectedMomentId={selectedMomentId}
            multiSelectIds={multiSelectIds}
            draftId={draft?.id ?? null}
            withDraft={withDraft}
            onBeginDrag={beginDrag}
            onDuplicate={(id) => void duplicateMoment(id)}
            onDelete={(id) => void deleteMoment(id)}
            onEdit={onEditMoment}
          />
        </>
      ),
    },
    {
      id: "cut",
      kind: "cut",
      label: "Cuts",
      Icon: Scissors,
      height: TRACK_HEIGHTS.user,
      tone: "rose",
      interactive: true,
      count: cutMoments.length,
      note: layerDisabled("cut")
        ? "Disabled for this analysis"
        : cutMap.activeCuts > 0
          ? `${cutMap.activeCuts} active · ${Math.round(cutMap.totalRemoved)}s removed`
          : undefined,
      emptyAction: { label: "Run Cuts", onRun: () => runLayer("cut") },
      renderLane: () => (
        <MomentLane
          moments={cutMoments}
          total={total}
          selectedMomentId={selectedMomentId}
          multiSelectIds={multiSelectIds}
          draftId={draft?.id ?? null}
          withDraft={withDraft}
          onBeginDrag={beginDrag}
          onDuplicate={(id) => void duplicateMoment(id)}
          onDelete={(id) => void deleteMoment(id)}
          onEdit={onEditMoment}
        />
      ),
    },
    {
      id: "speed",
      kind: "speed",
      label: "Speed",
      Icon: FastForward,
      height: TRACK_HEIGHTS.user,
      tone: "amber",
      interactive: true,
      count: speedMoments.length,
      note: layerDisabled("speed") ? "Disabled for this analysis" : undefined,
      emptyAction: { label: "Run Speed", onRun: () => runLayer("speed") },
      renderLane: () => (
        <MomentLane
          moments={speedMoments}
          total={total}
          selectedMomentId={selectedMomentId}
          multiSelectIds={multiSelectIds}
          draftId={draft?.id ?? null}
          withDraft={withDraft}
          onBeginDrag={beginDrag}
          onDuplicate={(id) => void duplicateMoment(id)}
          onDelete={(id) => void deleteMoment(id)}
          onEdit={onEditMoment}
        />
      ),
    },
    // Overlays — one shared lane for the Phase-3 Core AI Edit Pack. Only shown
    // once at least one overlay exists (added via the toolbar or generated), so
    // it never sits empty.
    ...(overlayMoments.length > 0
      ? ([
          {
            id: "overlays",
            kind: "overlays",
            label: "Overlays",
            Icon: Layers,
            height: TRACK_HEIGHTS.user,
            tone: "cyan",
            interactive: true,
            count: overlayMoments.length,
            renderLane: () => (
              <MomentLane
                moments={overlayMoments}
                total={total}
                selectedMomentId={selectedMomentId}
                multiSelectIds={multiSelectIds}
                draftId={draft?.id ?? null}
                withDraft={withDraft}
                onBeginDrag={beginDrag}
                onDuplicate={(id) => void duplicateMoment(id)}
                onDelete={(id) => void deleteMoment(id)}
                onEdit={onEditMoment}
              />
            ),
          },
        ] as TimelineTrackDescriptor[])
      : []),
    // Cursor / Focus — last, and only present when there's real cursor data.
    ...(showInteractionsTrack
      ? ([
          {
            id: "interactions",
            kind: "interactions",
            label: "Cursor / Focus",
            Icon: MousePointer2,
            height: TRACK_HEIGHTS.interactions,
            tone: "fog",
            interactive: false,
            count: interactionClickCount,
            renderLane: () => (
              <InteractionsLane
                interactions={interactions}
                loading={interactionsLoading}
                total={total}
                totalClicks={clickPipeline?.totalClicks}
                onSeek={seek}
              />
            ),
          },
        ] as TimelineTrackDescriptor[])
      : []),
  ];

  return (
    <div className="glass relative overflow-hidden rounded-3xl">
      <TimelineToolbar
        health={health}
        zoom={zoom}
        minZoom={minZoom}
        maxZoom={maxZoom}
        onZoomOut={zoomOut}
        onZoomIn={zoomIn}
        onFit={onFit}
        currentTime={currentTime}
        total={total}
        insightsOpen={insightsOpen}
        onToggleInsights={toggleInsights}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
        hasSelection={!!selectedMomentId}
        onAdd={(effectType) => void addMomentAtPlayhead(effectType)}
        onDuplicate={() =>
          selectedMomentId && void duplicateMoment(selectedMomentId)
        }
        onDelete={() => selectedMomentId && void deleteMoment(selectedMomentId)}
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
      <div className="px-4 pb-2 pt-4">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `clamp(44px, 13vw, ${GUTTER_WIDTH}px) minmax(0, 1fr)`,
          }}
        >
          {/* Left gutter — one always-visible label per track. */}
          <div className="flex flex-col pr-3">
            <div style={{ height: TRACK_HEIGHTS.ruler }} />
            {insightsOpen && <div style={{ height: TRACK_HEIGHTS.gap }} />}
            {tracks.map((t) => (
              <TrackLabel
                key={t.id}
                Icon={t.Icon}
                label={t.label}
                count={t.count}
                height={t.height}
                tone={t.tone}
                comingSoon={t.comingSoon}
                note={t.note}
              />
            ))}
          </div>

          {/* Right side — scrollable, zoom-scaled lane viewport */}
          <div ref={viewportRef} className="overflow-x-auto overflow-y-visible pb-2">
            <div
              className="relative select-none"
              style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            >
              <TimelineRuler total={total} pxPerSec={pxPerSec} />

              <div
                ref={trackRef}
                className="relative"
                onPointerDown={onLaneClick}
              >
                <GridLines total={total} />

                {/* Quiet-region markers live behind Insights — when the
                    panel is closed we keep the surface clean. */}
                {insightsOpen && <GapIndicator ranges={emptyRanges} />}

                {tracks.map((t) => {
                  // Show the one-click "Run this layer" affordance on an empty
                  // lane when other tracks already have content (this layer is
                  // conspicuously empty) or it was explicitly disabled last run.
                  const showEmptyAction =
                    (t.count ?? 0) === 0 &&
                    !!t.emptyAction &&
                    (hasMoments || !!t.note);
                  return (
                    <TimelineTrack
                      key={t.id}
                      ariaLabel={`${t.label} track`}
                      height={t.height}
                      dimmed={!t.interactive}
                    >
                      {t.renderLane({ total, pxPerSec, zoom })}
                      {showEmptyAction && (
                        <TrackEmptyAction
                          label={t.emptyAction!.label}
                          onRun={t.emptyAction!.onRun}
                          disabled={analyzing}
                        />
                      )}
                    </TimelineTrack>
                  );
                })}

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

        {/* Empty-state overlay — keeps the track structure visible while
            telling the user how to populate it. */}
        {!hasMoments && (
          <EmptyTimelineHint analyzed={project.analysis?.status === "complete"} />
        )}
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

      {/* Advanced toggles — CV debug. */}
      {showCvDebugToggle && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ToggleChip
            active={cvDebug}
            onClick={onToggleCvDebug}
            Icon={Bug}
            label="CV debug signals"
          />
        </div>
      )}
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

/**
 * Empty-state hint rendered inside the timeline card (over the still-visible
 * track structure) so users always see the editing surface and a clear path to
 * populate it — via the toolbar's Add menu or AI analysis.
 */
/**
 * Centered "Run this layer" affordance shown in an empty lane. One click
 * regenerates just that engine (in "keep" mode), leaving the rest of the
 * timeline untouched. `stopPropagation` keeps the lane's deselect-on-click from
 * firing underneath it.
 */
function TrackEmptyAction({
  label,
  onRun,
  disabled,
}: {
  label: string;
  onRun: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRun();
        }}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles size={11} className="text-violet-300" />
        {label}
      </button>
    </div>
  );
}

function EmptyTimelineHint({ analyzed }: { analyzed: boolean }) {
  return (
    <div className="relative mt-3 grid place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.015] px-6 py-7 text-center">
      <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25 shadow-[0_8px_24px_-12px_rgba(139,92,246,0.6)]">
        <Film size={18} />
      </div>
      <h3 className="mt-3 font-display text-[15px] font-semibold tracking-tight text-white">
        {analyzed ? "Your timeline is empty" : "Nothing on the timeline yet"}
      </h3>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-fog">
        {analyzed
          ? "Use the Add button above to insert your first zoom, focus, or click highlight at the playhead."
          : "Run AI analysis for a first-draft edit, or use the Add button above to place edits manually."}
      </p>
    </div>
  );
}
