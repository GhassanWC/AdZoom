"use client";

import * as React from "react";
import {
  Sparkles,
  MousePointer2,
  AlertTriangle,
  Trash2,
  Check,
  X as XIcon,
  Film,
  Diamond,
  Bug,
  Activity,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Eye,
  EyeOff,
  type LucideIcon,
} from "lucide-react";
import { useEditorReal } from "../context";
import { cn } from "@/lib/cn";
import { distributionScore } from "@/lib/timeline-balancer";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { CvSignalTracks } from "../CvSignalTracks";
import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import type { AnalysisOptions, EngineLayer } from "@/lib/analysis/engine-layers";
import {
  EFFECT_TONES,
  EFFECT_ICONS,
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
import { EditorUnifiedControlBar, type TimelineHealth } from "../EditorUnifiedControlBar";
import { NarrativeBand } from "./NarrativeBand";
import { DensityBar } from "./DensityBar";
import { AttentionWaveform } from "./AttentionWaveform";
import { useTimelineMetrics } from "./useTimelineMetrics";
import { MomentLane } from "./MomentLane";
import { InteractionsLane } from "./InteractionsLane";
import type { TimelineLaneContext, TimelineTrackTone } from "./trackModel";
import { planTimelineLanes, type LaneGroupId } from "./laneModel";

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
    seekBy,
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
    setLaneEnabled,
    deleteLane,
    undo,
    redo,
    canUndo,
    canRedo,
    interactions,
    interactionsLoading,
    startAnalyze,
    analyzing,
    scenesOpen,
  } = useEditorReal();

  const moments = project.analysis?.detectedMoments ?? [];
  const va = project.visualAnalysis;
  const total = duration > 0 ? duration : project.duration ?? 0;
  const narrativeSegments = project.analysis?.narrativeStructure ?? [];
  const attentionCurve = project.analysis?.attentionCurve;

  // ── Lane model ──────────────────────────────────────────────────────────
  // Every edit type has its OWN lane now (no single "Overlays" lane). The plan
  // groups the visible lanes (core camera/cut/speed always; overlay lanes only
  // when populated) into collapsible groups, with each lane carrying its own
  // moments. Routing is purely by effectType, so old projects load straight
  // into the right new lanes (no migration).
  const lanePlan = React.useMemo(() => planTimelineLanes(moments), [moments]);
  // Cut summary for the track header — "{active} active · {removed}s removed".
  const cutMap = React.useMemo(
    () => buildTimelineMap(moments, total),
    [moments, total]
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
  // The frozen ruler + the frozen gutter live in separate scroll boxes; the
  // lane viewport is the ONLY user-scrollable one and drives them via onScroll.
  const rulerViewportRef = React.useRef<HTMLDivElement | null>(null);
  const gutterScrollRef = React.useRef<HTMLDivElement | null>(null);
  // Keep the frozen ruler (horizontal) + frozen gutter (vertical) in lockstep
  // with the lane viewport. Direct DOM writes — no React state, no re-render.
  const onViewportScroll = React.useCallback(() => {
    const v = viewportRef.current;
    if (!v) return;
    if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = v.scrollLeft;
    if (gutterScrollRef.current) gutterScrollRef.current.scrollTop = v.scrollTop;
  }, []);
  // Scale model: percentage layout stays, but zoom + a measured px/sec are
  // derived here. `trackRef` (the content element) is what the drag math also
  // reads, so the two never disagree.
  const { zoom, pxPerSec, zoomIn, zoomOut, fitToScreen, minZoom, maxZoom } =
    useTimelineMetrics({ total, contentRef: trackRef });
  const onFit = React.useCallback(() => {
    fitToScreen();
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
    if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = 0;
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

      // ── Arrow keys → seek ∓5s (Shift = 1s fine step) ───────────────────
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !mod) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5;
        seekBy(e.key === "ArrowLeft" ? -step : step);
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
    seekBy,
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

  // ── Lane-group collapse state (persisted per group) ──────────────────────
  const [collapsedGroups, setCollapsedGroups] = React.useState<
    Partial<Record<LaneGroupId, boolean>>
  >({});
  React.useEffect(() => {
    const ids: LaneGroupId[] = ["camera", "pacing", "overlays", "canvas"];
    setCollapsedGroups(
      Object.fromEntries(
        ids.map((id) => [id, readPersistedBool(`adzoom.timeline.group.${id}.collapsed`, false)])
      )
    );
  }, []);
  const toggleGroup = React.useCallback((id: LaneGroupId) => {
    setCollapsedGroups((cur) => {
      const next = !cur[id];
      writePersistedBool(`adzoom.timeline.group.${id}.collapsed`, next);
      return { ...cur, [id]: next };
    });
  }, []);

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

  // ── Grouped lane rows ───────────────────────────────────────────────────
  // Every edit type gets its OWN lane, organised into collapsible groups
  // (Camera / Pacing / Visual overlays / Canvas). `rows` interleaves group
  // headers with lane rows so the gutter + lane columns map ONE ordered list
  // and stay perfectly aligned. Core lanes (camera/cut/speed) always show with a
  // "Run this layer" affordance; overlay lanes appear only when populated.
  const momentLane = (laneMoments: DetectedMoment[]) => (
    <MomentLane
      moments={laneMoments}
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
  );
  const RUN_LABEL: Record<"camera" | "cut" | "speed", string> = {
    camera: "Run Camera edits",
    cut: "Run Cuts",
    speed: "Run Speed",
  };

  type LaneRow = {
    kind: "lane";
    id: string;
    height: number;
    tone: TimelineTrackTone;
    label: string;
    Icon: LucideIcon;
    count: number;
    note?: string;
    interactive: boolean;
    emptyAction?: { label: string; onRun: () => void };
    /** Overlay lanes: bulk enable/disable/delete over these effect types. */
    laneControls?: {
      effectTypes: EffectType[];
      anyEnabled: boolean;
      anyDisabled: boolean;
    };
    renderLane: (ctx: TimelineLaneContext) => React.ReactNode;
  };
  type GroupRow = {
    kind: "group";
    id: LaneGroupId;
    label: string;
    count: number;
    collapsed: boolean;
  };
  type Row = LaneRow | GroupRow;

  const rows: Row[] = [];
  for (const g of lanePlan) {
    const collapsed = !!collapsedGroups[g.def.id];
    rows.push({ kind: "group", id: g.def.id, label: g.def.label, count: g.count, collapsed });
    if (collapsed) continue;
    for (const lane of g.lanes) {
      const def = lane.def;
      const isCamera = def.id === "camera";
      const engine = def.engineLayer;
      rows.push({
        kind: "lane",
        id: def.id,
        height: isCamera ? TRACK_HEIGHTS.ai : TRACK_HEIGHTS.overlay,
        tone: def.tone,
        label: def.label,
        Icon: EFFECT_ICONS[def.primaryEffect],
        count: lane.count,
        note:
          engine && layerDisabled(engine)
            ? "Disabled for this analysis"
            : def.id === "cut" && cutMap.activeCuts > 0
              ? `${cutMap.activeCuts} active · ${Math.round(cutMap.totalRemoved)}s removed`
              : undefined,
        interactive: true,
        emptyAction: engine ? { label: RUN_LABEL[engine], onRun: () => runLayer(engine) } : undefined,
        laneControls: def.overlay
          ? {
              effectTypes: def.effectTypes as EffectType[],
              anyEnabled: lane.moments.some((m) => m.enabled !== false),
              anyDisabled: lane.moments.some((m) => m.enabled === false),
            }
          : undefined,
        renderLane: () =>
          isCamera ? (
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
              {momentLane(lane.moments)}
            </>
          ) : (
            momentLane(lane.moments)
          ),
      });
    }
  }
  // Cursor / Focus — read-only cursor data, appended (ungrouped) at the bottom
  // and only when real cursor data exists.
  if (showInteractionsTrack) {
    rows.push({
      kind: "lane",
      id: "interactions",
      height: TRACK_HEIGHTS.interactions,
      tone: "fog",
      label: "Cursor / Focus",
      Icon: MousePointer2,
      count: interactionClickCount,
      interactive: false,
      renderLane: () => (
        <InteractionsLane
          interactions={interactions}
          loading={interactionsLoading}
          total={total}
          totalClicks={clickPipeline?.totalClicks}
          onSeek={seek}
        />
      ),
    });
  }

  return (
    // Bottom section of the fixed-height editor shell: fills its split pane and
    // scrolls INTERNALLY. The unified control bar + warnings + optional scene
    // strip + ruler stay frozen at the top; only the lane region scrolls
    // (vertical lanes + horizontal time), so the preview above always stays
    // visible.
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden border-t border-white/[0.06] bg-surface/50 backdrop-blur-xl">
      <div className="shrink-0">
      <EditorUnifiedControlBar
        health={health}
        zoom={zoom}
        minZoom={minZoom}
        maxZoom={maxZoom}
        onZoomOut={zoomOut}
        onZoomIn={zoomIn}
        onFit={onFit}
        insightsOpen={insightsOpen}
        onToggleInsights={toggleInsights}
        hasScenes={showNarrative}
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
      </div>

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

      {/* ── Scenes strip — collapsible, toggled from the unified bar's "Scenes"
          button. Collapsed by default after analysis (scenesOpen persisted);
          selecting a chapter still seeks the preview + timeline the same way. */}
      {showNarrative && scenesOpen && (
        <div className="shrink-0 border-b border-white/[0.04] px-6 py-2">
          <NarrativeBand
            segments={narrativeSegments}
            duration={total}
            currentTime={currentTime}
            onSeek={seek}
          />
        </div>
      )}

      {/* ── Tracks — frozen ruler + internally-scrolling lanes ─────────────
          The ruler is pinned in its own header row (horizontally synced to the
          lane viewport). The gutter (labels) and the lane viewport share ONE
          vertical scroll via onViewportScroll → the lane viewport is the only
          user-scrollable box; gutter.scrollTop + ruler.scrollLeft mirror it. */}
      <div className="relative flex min-h-0 flex-1 flex-col px-4 pt-3">
        {/* Frozen time ruler (stays visible while lanes scroll vertically). */}
        <div className="flex shrink-0">
          <div
            aria-hidden
            className="shrink-0"
            style={{ width: `clamp(44px, 13vw, ${GUTTER_WIDTH}px)` }}
          />
          <div ref={rulerViewportRef} className="min-w-0 flex-1 overflow-hidden">
            <div
              className="relative select-none"
              style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            >
              <TimelineRuler total={total} pxPerSec={pxPerSec} />
            </div>
          </div>
        </div>

        {/* Lane region — the only scroll surface (vertical lanes + horizontal
            time). Gutter is vertical-synced; lane viewport owns both scrollbars. */}
        <div className="flex min-h-0 flex-1">
          {/* Left gutter — group headers + one label per lane (v-scroll synced). */}
          <div
            ref={gutterScrollRef}
            className="flex shrink-0 flex-col overflow-hidden pr-3"
            style={{ width: `clamp(44px, 13vw, ${GUTTER_WIDTH}px)` }}
          >
            {insightsOpen && <div style={{ height: TRACK_HEIGHTS.gap }} />}
            {rows.map((r) =>
              r.kind === "group" ? (
                <GroupGutterHeader
                  key={`g-${r.id}`}
                  label={r.label}
                  count={r.count}
                  collapsed={r.collapsed}
                  onToggle={() => toggleGroup(r.id)}
                />
              ) : (
                <TrackLabel
                  key={r.id}
                  Icon={r.Icon}
                  label={r.label}
                  count={r.count}
                  height={r.height}
                  tone={r.tone}
                  note={r.note}
                  trailing={
                    r.laneControls ? (
                      <OverlayLaneMenu
                        label={r.label}
                        anyEnabled={r.laneControls.anyEnabled}
                        anyDisabled={r.laneControls.anyDisabled}
                        onEnableAll={() => void setLaneEnabled(r.laneControls!.effectTypes, true)}
                        onDisableAll={() => void setLaneEnabled(r.laneControls!.effectTypes, false)}
                        onDeleteAll={() => void deleteLane(r.laneControls!.effectTypes)}
                      />
                    ) : undefined
                  }
                />
              )
            )}
            {/* Bottom padding so the last lane clears the horizontal scrollbar. */}
            <div aria-hidden className="h-3 shrink-0" />
          </div>

          {/* Right side — scrollable, zoom-scaled lane viewport (both axes) */}
          <div
            ref={viewportRef}
            onScroll={onViewportScroll}
            className="min-w-0 flex-1 overflow-auto"
          >
            <div
              className="relative select-none"
              style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            >
              <div
                ref={trackRef}
                className="relative"
                onPointerDown={onLaneClick}
              >
                <GridLines total={total} />

                {/* Quiet-region markers live behind Insights — when the
                    panel is closed we keep the surface clean. */}
                {insightsOpen && <GapIndicator ranges={emptyRanges} />}

                {rows.map((r) => {
                  if (r.kind === "group") {
                    // A thin spacer row in the lane column keeps it aligned with
                    // the gutter's group header (same height, subtle divider).
                    return (
                      <div
                        key={`g-${r.id}`}
                        aria-hidden
                        style={{ height: TRACK_HEIGHTS.group }}
                        className="border-b border-white/[0.05] bg-white/[0.012]"
                      />
                    );
                  }
                  // Show the one-click "Run this layer" affordance on an empty
                  // lane when other tracks already have content (this layer is
                  // conspicuously empty) or it was explicitly disabled last run.
                  const showEmptyAction =
                    r.count === 0 &&
                    !!r.emptyAction &&
                    (hasMoments || !!r.note);
                  return (
                    <TimelineTrack
                      key={r.id}
                      ariaLabel={`${r.label} track`}
                      height={r.height}
                      dimmed={!r.interactive}
                    >
                      {r.renderLane({ total, pxPerSec, zoom })}
                      {showEmptyAction && (
                        <TrackEmptyAction
                          label={r.emptyAction!.label}
                          onRun={r.emptyAction!.onRun}
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

                {/* Match the gutter's bottom padding so scroll extents align. */}
                <div aria-hidden className="h-3" />
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

/** Collapsible lane-group header shown in the left gutter. */
function GroupGutterHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      style={{ height: TRACK_HEIGHTS.group }}
      className="group/gh flex w-full items-center gap-1 border-b border-white/[0.05] pr-1 text-left"
    >
      <span className="text-fog/60 transition-colors duration-150 group-hover/gh:text-white">
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      </span>
      <span className="hidden truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-fog/70 transition-colors duration-150 group-hover/gh:text-white md:inline">
        {label}
      </span>
      <span className="ml-auto hidden font-mono text-[10px] tabular-nums text-fog/45 md:inline">
        {count}
      </span>
    </button>
  );
}

/**
 * Per-overlay-lane ⋯ menu — bulk enable / disable / delete for every moment of
 * that lane's type. Non-destructive enable/disable (one undo step); delete
 * clears the lane. Closes on outside click.
 */
function OverlayLaneMenu({
  label,
  anyEnabled,
  anyDisabled,
  onEnableAll,
  onDisableAll,
  onDeleteAll,
}: {
  label: string;
  anyEnabled: boolean;
  anyDisabled: boolean;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onDeleteAll: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`${label} lane options`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-6 items-center justify-center rounded-md text-fog/55 transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        // Opens rightward (into the wide lane area) — the gutter is the leftmost
        // column inside the card's overflow-hidden, so a leftward menu would clip.
        <div className="absolute left-0 top-7 z-40 w-40 overflow-hidden rounded-lg border border-white/10 bg-ink/95 p-1 shadow-cinematic backdrop-blur-xl">
          <LaneMenuItem
            Icon={Eye}
            label="Enable all"
            disabled={!anyDisabled}
            onClick={() => {
              onEnableAll();
              setOpen(false);
            }}
          />
          <LaneMenuItem
            Icon={EyeOff}
            label="Disable all"
            disabled={!anyEnabled}
            onClick={() => {
              onDisableAll();
              setOpen(false);
            }}
          />
          <LaneMenuItem
            Icon={Trash2}
            label="Delete all"
            danger
            onClick={() => {
              onDeleteAll();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function LaneMenuItem({
  Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "text-rose-200 hover:bg-rose-500/15"
          : "text-fog hover:bg-white/[0.06] hover:text-white"
      )}
    >
      <Icon size={12} />
      {label}
    </button>
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
