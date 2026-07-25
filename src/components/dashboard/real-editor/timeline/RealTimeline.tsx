"use client";

import * as React from "react";
import {
  Sparkles,
  AlertTriangle,
  Trash2,
  Check,
  X as XIcon,
  Scissors,
  Upload,
  Film,
  Diamond,
  Bug,
  Activity,
} from "lucide-react";
import { useEditorReal } from "../context";
import { cn } from "@/lib/cn";
import { scrollBehavior } from "@/lib/motion";
import { distributionScore } from "@/lib/timeline-balancer";
import { CvSignalTracks } from "../CvSignalTracks";
import type { DetectedMoment } from "@/lib/firebase/schema";
import type { AnalysisOptions, EngineLayer } from "@/lib/analysis/engine-layers";
import { isLayerVisible } from "@/lib/timeline/layers";
import {
  EFFECT_ICONS,
  EFFECT_TONES,
  MIN_MOMENT_LEN,
  MIN_PILL_PX,
  SNAP_PX,
  CLICK_PX,
  TRACK_HEIGHTS,
  PROVENANCE_PRESENTATION,
} from "./constants";
import { readPersistedBool, writePersistedBool, fmt } from "./utils";
import type { DragState, DragMode } from "./utils";
import { TimelineTrack } from "./TimelineTrack";
import { TimelineRuler, GridLines } from "./TimelineRuler";
import { Playhead } from "./Playhead";
import { GapIndicator, emptyQuartileRanges } from "./GapIndicator";
import {
  EditorUnifiedControlBar,
  type LayerRow,
  type TimelineHealth,
} from "../EditorUnifiedControlBar";
import { NarrativeBand } from "./NarrativeBand";
import { DensityBar } from "./DensityBar";
import { AttentionWaveform } from "./AttentionWaveform";
import { useTimelineMetrics } from "./useTimelineMetrics";
import { MomentLane } from "./MomentLane";
import { InteractionsLane } from "./InteractionsLane";
import { AudioLane } from "./AudioLane";
import { ClipsLane } from "./ClipsLane";
import type { TimelineLaneContext } from "./trackModel";
import { planTimelineLanes } from "./laneModel";

/**
 * Track-based timeline orchestrator. Owns drag math, snap math, multi-select
 * state, and keyboard shortcuts. The visual surface is a stack of DAW-style
 * track rows (Edits, Cuts, Speed, and Cursor / Focus when real
 * cursor data exists) built from an ordered row list, so new track types are
 * config, not a render-tree rewrite. Analytics chrome
 * (attention waveform, narrative chapters, density) stays behind the Insights
 * toggle.
 *
 * There is NO left label column. The classifier gutter (group bars + per-lane
 * icon / name / count / ⋯ menu) is gone entirely: it consumed a fixed slice of
 * every row's width to restate what the pills already show, and the timeline is
 * the one surface where horizontal space IS the data. Lanes now start at x=0 and
 * the whole width is time. Lane identity survives only as `aria-label` on each
 * track row (and as the ordering data in `laneModel`), never as pixels.
 */
export function RealTimeline() {
  const {
    project,
    videoRef,
    currentTime,
    playing,
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
    setMomentEnabled,
    layers,
    setLayerVisible,
    showAllLayers,
    splitAtPlayhead,
    canSplitSelection,
    addMomentAtPlayhead,
    undo,
    redo,
    canUndo,
    canRedo,
    interactions,
    interactionsLoading,
    startAnalyze,
    analyzing,
    scenesOpen,
    clips,
    focusedClipId,
    openClip,
    exitClip,
    requestClipExport,
  } = useEditorReal();

  const focusedClip = focusedClipId
    ? clips.find((c) => c.id === focusedClipId) ?? null
    : null;

  const moments = project.analysis?.detectedMoments ?? [];
  const va = project.visualAnalysis;
  const total = duration > 0 ? duration : project.duration ?? 0;
  const narrativeSegments = project.analysis?.narrativeStructure ?? [];
  const attentionCurve = project.analysis?.attentionCurve;

  // The Audio lane appears only when there is REAL audio analysis to draw. No
  // data → no lane, rather than an empty row implying the audio is silent.
  const audioAnalysis = project.analysis?.audioAnalysis;
  const hasAudioData =
    !!audioAnalysis &&
    ((audioAnalysis.loudness?.length ?? 0) > 0 ||
      (audioAnalysis.silenceSegments?.length ?? 0) > 0 ||
      (audioAnalysis.speechSegments?.length ?? 0) > 0);

  // ── Lane model ──────────────────────────────────────────────────────────
  // Every edit type has its OWN lane now (no single "Overlays" lane). The plan
  // decides which lanes are visible (core camera/cut/speed always; overlay lanes
  // only when populated) and carries each lane's moments. It still buckets them
  // into groups internally, but that is an ORDERING detail only — the timeline
  // renders lanes, never groups. Routing is purely by effectType, so old projects
  // load straight into the right lanes (no migration).
  const lanePlan = React.useMemo(() => planTimelineLanes(moments), [moments]);

  /**
   * The Layers menu's content: one row per lane the timeline is actually showing
   * (core lanes always, overlay lanes once populated) — so "one toggle per
   * layer" means exactly the layers the user can see. The lane's icon is its
   * first effect type's, which is the same icon its pills wear.
   */
  const layerRows: LayerRow[] = React.useMemo(
    () =>
      lanePlan.flatMap((g) =>
        g.lanes.map((lane) => ({
          id: lane.def.id,
          label: lane.def.label,
          count: lane.count,
          visible: isLayerVisible(layers, lane.def.id),
          Icon: EFFECT_ICONS[lane.def.effectTypes[0]] ?? Sparkles,
        }))
      ),
    [lanePlan, layers]
  );

  /**
   * Show/hide one edit. Declared HERE (not further down) because the keyboard
   * effect lists it as a dependency — see the note on `splitNote` below.
   */
  const toggleMomentEnabled = React.useCallback(
    async (id: string) => {
      const m = moments.find((x) => x.id === id);
      if (!m) return;
      await setMomentEnabled(id, m.enabled === false);
    },
    [moments, setMomentEnabled]
  );

  // Engine selection from the most recent analysis — decides whether an empty
  // lane offers its one-click "Run this layer" affordance. A targeted run enables
  // only that layer in "keep" mode, so it adds the missing layer without touching
  // anything else on the timeline.
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
  // The frozen ruler lives in its own clipped box; the lane viewport is the ONLY
  // user-scrollable one and drives the ruler's scrollLeft via onScroll. (Nothing
  // is vertically synced any more — with the gutter gone, the lane viewport is the
  // only column, so its own scrollbar IS the vertical scroll.)
  const rulerViewportRef = React.useRef<HTMLDivElement | null>(null);
  // Keep the frozen ruler horizontally in lockstep with the lane viewport.
  // Direct DOM write — no React state, no re-render.
  const onViewportScroll = React.useCallback(() => {
    const v = viewportRef.current;
    if (!v) return;
    if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = v.scrollLeft;
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

  /**
   * Bring the opened clip / selected edit INTO VIEW when it isn't already.
   *
   * Two rules keep this from becoming annoying, because selection happens
   * constantly:
   *   • If the target is already on screen we don't scroll AT ALL. Re-centring a
   *     pill the user can already see would yank the viewport out from under them
   *     — the most common way "helpful" auto-scroll turns hostile.
   *   • It only ever scrolls the minimum distance needed to clear the edge (plus
   *     a small margin), rather than centring.
   * Smooth by default; instant under prefers-reduced-motion, where a large
   * sliding viewport is exactly the movement to avoid.
   */
  const selectedMoment = selectedMomentId
    ? moments.find((m) => m.id === selectedMomentId) ?? null
    : null;
  const focusStart = focusedClip?.startTime ?? selectedMoment?.startTime ?? null;
  const focusEnd = focusedClip?.endTime ?? selectedMoment?.endTime ?? null;

  React.useEffect(() => {
    const view = viewportRef.current;
    const content = trackRef.current;
    if (!view || !content || total <= 0) return;
    if (focusStart === null || focusEnd === null) return;

    const width = content.clientWidth;
    if (width <= 0) return;
    const x0 = (focusStart / total) * width;
    const x1 = (focusEnd / total) * width;

    const left = view.scrollLeft;
    const right = left + view.clientWidth;
    const PAD = 48;

    let next = left;
    if (x0 < left + PAD) next = x0 - PAD;
    else if (x1 > right - PAD) next = x1 - view.clientWidth + PAD;
    else return; // already comfortably visible → leave the viewport alone

    next = Math.max(0, Math.min(next, content.scrollWidth - view.clientWidth));
    if (Math.abs(next - left) < 1) return;

    view.scrollTo({ left: next, behavior: scrollBehavior() });
  }, [focusStart, focusEnd, total, zoom]);

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

  /**
   * Split, with an explanation when it can't happen.
   *
   * `splitAtPlayhead` returns null on success and a human sentence on refusal
   * (playhead outside the edit, or a half would be under 0.3s). Surfacing that
   * is the difference between "the S key is broken" and "ah — my playhead is a
   * frame outside the pill".
   *
   * Declared BEFORE the keyboard effect on purpose: the effect lists it as a
   * dependency, and a dep array is evaluated during render, so a `const` further
   * down the component would be in its temporal dead zone.
   */
  const [splitNote, setSplitNote] = React.useState<string | null>(null);
  const runSplit = React.useCallback(
    async (ids?: string[]) => {
      setSplitNote(await splitAtPlayhead(ids));
    },
    [splitAtPlayhead]
  );
  React.useEffect(() => {
    if (!splitNote) return;
    const t = setTimeout(() => setSplitNote(null), 3400);
    return () => clearTimeout(t);
  }, [splitNote]);

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

      // ── Zoom (⌘/Ctrl not required — the timeline owns +/−/0) ───────────
      if (!mod && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (!mod && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (!mod && e.key === "0") {
        e.preventDefault();
        onFit();
        return;
      }

      // ── Split at the playhead (S) — the NLE convention ─────────────────
      // Works on the multi-selection when there is one, else the selected edit.
      // `runSplit` explains itself when the playhead isn't inside the edit.
      if (!mod && key === "s") {
        if (!selectedMomentId && multiSelectIds.length === 0) return;
        e.preventDefault();
        void runSplit();
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
      } else if (!mod && key === "h") {
        // H → hide/show the selected edit. Delete's non-destructive neighbour.
        e.preventDefault();
        void toggleMomentEnabled(selectedMomentId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSelectedMomentId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedMomentId,
    multiSelectIds,
    deleteMoment,
    duplicateMoment,
    toggleMomentEnabled,
    deleteMultiSelected,
    clearMultiSelect,
    setSelectedMomentId,
    runSplit,
    zoomIn,
    zoomOut,
    onFit,
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

  // Lane-group collapse is GONE along with the group header rows: with no bar to
  // click there's nothing to collapse, and the lanes are compact enough now that
  // hiding a whole group isn't the space-saver it was. (The persisted
  // `adzoom.timeline.group.*.collapsed` keys are simply left unread — harmless,
  // and nothing else reads them.)

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

  // ── Lane rows ───────────────────────────────────────────────────────────
  // Every edit type gets its OWN lane. `rows` is ONE flat ordered list rendered
  // in ONE column — there is no second (gutter) column to keep aligned with it
  // any more. Core lanes (camera/cut/speed) always show with a "Run this layer"
  // affordance; overlay lanes appear only when populated.
  const momentLane = (laneMoments: DetectedMoment[], layerHidden = false) => (
    <MomentLane
      moments={laneMoments}
      total={total}
      currentTime={currentTime}
      selectedMomentId={selectedMomentId}
      multiSelectIds={multiSelectIds}
      draftId={draft?.id ?? null}
      withDraft={withDraft}
      // The lane keeps rendering every pill while its layer is off — you can
      // still select, drag, retime and inspect them. They just don't render in
      // the video, and they say so.
      layerHidden={layerHidden}
      onBeginDrag={beginDrag}
      onDuplicate={(id) => void duplicateMoment(id)}
      onSplit={(id) => void runSplit([id])}
      onToggleEnabled={(id) => void toggleMomentEnabled(id)}
      onDelete={(id) => void deleteMoment(id)}
      onEdit={onEditMoment}
    />
  );
  const RUN_LABEL: Record<"camera" | "cut" | "speed", string> = {
    camera: "Run Camera edits",
    cut: "Run Cuts",
    speed: "Run Speed",
  };

  /**
   * ONE row type: a lane, and a lane is nothing but a strip of time.
   *
   * No group rows, no group labels, and — since the classifier gutter was
   * deleted — no lane icon, tint, count, note or ⋯ menu either. Those were the
   * gutter's fields; with no gutter to draw them in, carrying them here would be
   * dead weight that quietly invites the column back. `label` survives ONLY as
   * the row's `aria-label` (screen readers still need to know which track they
   * are in), and `count` / `engineOff` survive only because the empty-lane "Run
   * this layer" affordance keys off them.
   *
   * Grouping still exists as DATA — `planTimelineLanes` returns PlannedGroups and
   * the lane tests assert on them — but it is purely an ordering input here: we
   * flatten the groups and render their lanes.
   */
  type Row = {
    id: string;
    /** a11y only — never rendered as text. */
    label: string;
    height: number;
    count: number;
    interactive: boolean;
    /** The user switched this LAYER off — its edits render nowhere (Layers menu). */
    layerHidden?: boolean;
    /** This lane's engine layer was switched off for the last analysis run. */
    engineOff: boolean;
    emptyAction?: { label: string; onRun: () => void };
    renderLane: (ctx: TimelineLaneContext) => React.ReactNode;
  };

  const rows: Row[] = [];
  for (const g of lanePlan) {
    for (const lane of g.lanes) {
      const def = lane.def;
      const isCamera = def.id === "camera";
      const engine = def.engineLayer;
      // This LAYER is switched off: its edits are still here and still editable,
      // but none of them reach the preview or the export.
      const hidden = !isLayerVisible(layers, def.id);
      rows.push({
        id: def.id,
        label: hidden ? `${def.label} (hidden)` : def.label,
        // Camera/zoom pills render at the SAME compact height as every other edit
        // lane — so a short zoom reads as a horizontal chip (like a cut/speed pill)
        // instead of a tall vertical bar stretched to fill an 84px lane.
        height: TRACK_HEIGHTS.overlay,
        count: lane.count,
        interactive: true,
        layerHidden: hidden,
        engineOff: !!engine && layerDisabled(engine),
        emptyAction: engine ? { label: RUN_LABEL[engine], onRun: () => runLayer(engine) } : undefined,
        renderLane: () =>
          isCamera ? (
            <>
              {insightsOpen && attentionCurve && attentionCurve.length > 0 && (
                <div className="pointer-events-none absolute inset-x-0 inset-y-0 z-0">
                  <AttentionWaveform
                    curve={attentionCurve}
                    duration={total}
                    height={TRACK_HEIGHTS.overlay}
                    variant="full"
                    className="opacity-70"
                  />
                </div>
              )}
              {momentLane(lane.moments, hidden)}
            </>
          ) : (
            momentLane(lane.moments, hidden)
          ),
      });
    }
  }
  /**
   * Clips — the AI-generated short clips, as a real lane rather than something
   * you can only see once you've opened one. Read-only: a clip is a WINDOW into
   * the source, not an edit, so it has no drag handles. Clicking one opens it
   * (which is what actually scopes the preview + export to that window).
   */
  if (clips.length > 0) {
    rows.push({
      id: "clips",
      label: "Generated clips",
      height: TRACK_HEIGHTS.overlay,
      count: clips.length,
      interactive: false,
      engineOff: false,
      renderLane: () => (
        <ClipsLane
          clips={clips}
          total={total}
          focusedClipId={focusedClipId}
          onOpen={openClip}
          onSeek={seek}
        />
      ),
    });
  }

  /**
   * Audio — the real waveform, plus what the edits DO to it: cuts strike the
   * audio they remove, muted speed-ups are dimmed, silences are banded.
   *
   * Read-only on purpose. Framevo has no audio edit type (the render core has
   * no audio-clip concept in preview, browser export, the Cloud Run worker or
   * Remotion), so an audio track you could drag clips around on would be a
   * control that changes nothing in the exported file. What it CAN honestly do
   * is show you the audio and let you see exactly which of it your cuts delete —
   * which is the thing you actually need when trimming to a target length.
   */
  if (hasAudioData) {
    rows.push({
      id: "audio",
      label: "Audio",
      height: TRACK_HEIGHTS.attention,
      count: 0,
      interactive: false,
      engineOff: false,
      renderLane: () => (
        <AudioLane
          audioAnalysis={audioAnalysis}
          moments={moments}
          total={total}
          height={TRACK_HEIGHTS.attention}
          onSeek={seek}
        />
      ),
    });
  }

  // Cursor / Focus — read-only cursor data, appended (ungrouped) at the bottom
  // and only when real cursor data exists.
  if (showInteractionsTrack) {
    rows.push({
      id: "interactions",
      label: "Cursor / Focus",
      height: TRACK_HEIGHTS.interactions,
      count: interactionClickCount,
      interactive: false,
      engineOff: false,
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
        layerRows={layerRows}
        onToggleLayer={(id, visible) => void setLayerVisible(id, visible)}
        onShowAllLayers={() => void showAllLayers()}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
        hasSelection={!!selectedMomentId}
        onAdd={(effectType) => void addMomentAtPlayhead(effectType)}
        onDuplicate={() =>
          selectedMomentId && void duplicateMoment(selectedMomentId)
        }
        canSplit={canSplitSelection}
        onSplit={() => void runSplit()}
        onDelete={() => selectedMomentId && void deleteMoment(selectedMomentId)}
      />
      </div>

      {/* Focused-clip banner — set when a clip is "opened" from the Clips panel.
          The playhead has already jumped to the clip; this marks the active
          window and offers to export just this clip or exit back to the full
          timeline. */}
      {focusedClip && (
        <div className="fv-pop-in flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-violet-400/25 bg-violet-500/[0.08] px-4 py-2 text-[12px]">
          <span className="inline-flex items-center gap-2">
            <Scissors size={13} className="shrink-0 text-violet-300" />
            <span className="font-semibold text-white">Clip</span>
            <span className="min-w-0 truncate text-violet-100/90">{focusedClip.title}</span>
          </span>
          <span className="font-mono text-[11px] tabular-nums text-violet-200/70">
            {fmt(focusedClip.startTime)}–{fmt(focusedClip.endTime)} · {fmt(focusedClip.duration)}
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => requestClipExport(focusedClip)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/45 bg-violet-500/20 px-2.5 py-1 text-[11px] font-medium text-violet-50 transition-colors duration-150 hover:bg-violet-500/30"
            >
              <Upload size={11} />
              Export clip
            </button>
            <button
              type="button"
              onClick={exitClip}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
            >
              <XIcon size={11} />
              Exit
            </button>
          </span>
        </div>
      )}

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

      {/* Why a split didn't happen. Transient — it answers a question the user
          just asked by pressing S, and then gets out of the way. */}
      {splitNote && (
        <div className="fv-pop-in flex shrink-0 items-center gap-2 border-b border-amber-300/25 bg-amber-400/[0.08] px-6 py-2 text-[12px] text-amber-100">
          <AlertTriangle size={13} className="shrink-0 text-amber-300" />
          <span>{splitNote}</span>
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
          Two boxes, ONE column: the ruler is pinned above (clipped, horizontally
          mirrored from the lane viewport via onViewportScroll) and the lane
          viewport below owns BOTH scrollbars — vertical for lanes, horizontal for
          time. Both start at x=0 and share the same zoom-scaled width, which is
          what keeps the ruler, the gridlines and the playhead on the same pixel
          as the pills. No left padding: a track starts at the far left edge. */}
      <div className="relative flex min-h-0 flex-1 flex-col pt-3">
        {/* Frozen time ruler (stays visible while lanes scroll vertically). */}
        <div ref={rulerViewportRef} className="shrink-0 overflow-hidden">
          <div
            className="relative select-none"
            style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
          >
            <TimelineRuler total={total} pxPerSec={pxPerSec} />
          </div>
        </div>

        {/* Lane region — the only scroll surface (vertical lanes + horizontal
            time), full width of the card. */}
        <div
          ref={viewportRef}
          onScroll={onViewportScroll}
          // Tagged so a selected pill's action toolbar can find its clipping box
          // and flip below the pill when there's no room above it (MomentPill).
          // Without that, the toolbar on a top-lane edit renders outside this
          // scroll box and is simply invisible — the Edit button with it.
          data-timeline-scroll
          className="min-h-0 flex-1 overflow-auto"
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

              {/* FOCUSED CLIP MODE — dim everything outside the clip so the
                  clip's own moments read as the subject. Pointer-transparent:
                  the timeline stays fully editable underneath (and the main
                  timeline itself is never modified). */}
              {focusedClip && total > 0 && (
                <>
                  {focusedClip.startTime > 0 && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 left-0 z-[15] bg-ink/70"
                      style={{ width: `${(focusedClip.startTime / total) * 100}%` }}
                    />
                  )}
                  {focusedClip.endTime < total && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 right-0 z-[15] bg-ink/70"
                      style={{ left: `${(focusedClip.endTime / total) * 100}%` }}
                    />
                  )}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 z-[16] border-x-2 border-violet-400/70"
                    style={{
                      left: `${(focusedClip.startTime / total) * 100}%`,
                      width: `${((focusedClip.endTime - focusedClip.startTime) / total) * 100}%`,
                    }}
                  />
                </>
              )}

              {/* Quiet-region markers live behind Insights — when the
                  panel is closed we keep the surface clean. */}
              {insightsOpen && <GapIndicator ranges={emptyRanges} />}

              {rows.map((r) => {
                // Show the one-click "Run this layer" affordance on an empty
                // lane when other tracks already have content (this layer is
                // conspicuously empty) or it was explicitly disabled last run.
                const showEmptyAction =
                  r.count === 0 && !!r.emptyAction && (hasMoments || r.engineOff);
                return (
                  <TimelineTrack
                    key={r.id}
                    ariaLabel={`${r.label} track`}
                    height={r.height}
                    // A hidden LAYER greys its whole strip, so the timeline can
                    // never quietly show edits that the export won't contain.
                    dimmed={!r.interactive || !!r.layerHidden}
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
                videoRef={videoRef}
                currentTime={currentTime}
                playing={playing}
                total={total}
                rulerHeight={TRACK_HEIGHTS.ruler}
              />

              {/* Clearance so the last lane isn't sat on by the horizontal
                  scrollbar. */}
              <div aria-hidden className="h-3" />
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
