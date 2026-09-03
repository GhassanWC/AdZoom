"use client";

import * as React from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
// Document writes go through the platform port, NOT the Firestore SDK directly:
// on the web it is the same `setDoc(ref, patch, {merge:true})` as before, on the
// desktop it is the local SQLite library. The sentinels below are the shared
// vocabulary both backends understand (see lib/platform/field-value.ts).
import { usePlatform } from "@/lib/platform";
import { arrayRemove, arrayUnion, deleteField, serverTimestamp } from "@/lib/platform";
import type { DocPatch, ProjectWriteOptions } from "@/lib/platform";
import type {
  AiSuggestion,
  Analysis,
  AnalysisErrorKind,
  DetectedMoment,
  EffectsSettings,
  EffectType,
  GeneratedClip,
  LayerVisibility,
  Preset,
  ProjectDoc,
  SelectedVideoType,
  TextStyle,
  TimelineLayerId,
} from "@/lib/firebase/schema";
import {
  hiddenLayerIds,
  isLayerVisible,
  normalizeLayerVisibility,
  visibleMoments,
} from "@/lib/timeline/layers";
import { generateClips as computeClips } from "@/lib/clips/clip-generator";
import {
  createClipGenerationController,
  type ClipGenMode,
  type ClipGenTrigger,
  type ClipGenerationController,
  type ClipGenerationResult,
} from "@/lib/clips/clip-generation";
import {
  clipPreviewMoments,
  clipEffects,
  applyClipEditsToTimeline,
} from "@/lib/clips/clip-edits";
import {
  withClipExportEvent,
  replaceClip,
  type ClipExportEvent,
} from "@/lib/clips/clip-export-status";
import { toRenderableClips, type DroppedClip } from "@/lib/clips/clip-render";
import { trackEvent } from "@/lib/analytics/trackEvent";
import {
  normalizeSelectedVideoType,
} from "@/lib/analysis/video-type";
import { isOverlayEffectType, DEFAULT_BLUR_STRENGTH } from "@/lib/firebase/schema";
import { applyPresetToSettings } from "@/lib/presets";
import { useInteractions } from "./useInteractions";
import {
  readPersistedString,
  writePersistedString,
  readPersistedNumber,
  writePersistedNumber,
  readPersistedBool,
  writePersistedBool,
} from "./timeline/utils";
import {
  SPLIT_FRACTION_KEY,
  MODE_FRACTION,
  clampSplitFraction,
} from "./workspace-split";
import type { Interaction } from "@/lib/recording/types";
import {
  normalizePlan,
  planMeetsMinimum,
  exceedsUploadDuration,
  FREE_VIDEO_DURATION_LIMIT_MESSAGE,
} from "@/lib/usage/plan";
import { usePlanTier } from "@/lib/usage/useStoragePlan";
import {
  runVisualAnalysis,
  CvAbortError,
  CvTaintedError,
} from "@/lib/cv/pipeline";
import {
  runChunkedAnalysis,
  ChunkedAnalysisError,
  type ChunkedRunResult,
} from "@/lib/analysis/chunk-orchestrator";
import {
  type AnalysisOptions,
  computeCarryOver,
  DEFAULT_ANALYSIS_OPTIONS,
} from "@/lib/analysis/engine-layers";
import type { TranscriptLanguageMode } from "@/lib/transcript/language";
import { getActiveJobForProject } from "@/lib/firebase/analysis-jobs";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import {
  enqueueProjectWrite,
  isAnalysisActive,
} from "@/lib/firebase/project-writer";
import { isProcessing } from "@/lib/analysis-stages";
import {
  cropBoxFor,
  snapOutOfActiveCut,
  DEFAULT_CROP,
  DEFAULT_CUT,
  DEFAULT_SPEED,
} from "@/lib/timeline/crop-speed";
import {
  canSplit,
  splitBlockedMessage,
  splitMomentsAt,
  splitReason,
} from "@/lib/timeline/split";
import { clampZoomWindow, zoomPreset } from "@/lib/timeline/zoom-presets";
import {
  resolveSourceRect,
  remapRegion,
  croppedToSource,
  sourceToCropped,
  sanitizeSourceCrop,
  FULL_FRAME_CROP,
} from "@/lib/timeline/source-crop";
import { quantize, dequantize } from "@/lib/cv/resample";
import type { CaptionActionResult } from "@/lib/analysis/ai-caption-status";
import type { DirectorRequestForm } from "@/lib/director/request";
import type { DirectorBrief } from "@/lib/director/types";
import type {
  AnalysisJob,
  CaptionPosition,
  OverlayTextPreset,
  SourceCrop,
  VisualAnalysis,
} from "@/lib/firebase/schema";
import { useNotifications } from "@/lib/notifications/store";
import { useRenderCount } from "@/lib/perf/render-probe";
import {
  createClockStore,
  PlaybackClockProvider,
  useClockSelector,
} from "./playback-clock";
import { activeMomentIdAt, canSplitAt } from "./clock-selectors";


import { apiFetch } from "@/lib/platform/api";
// ── Frame-crop coordinate remap (best-effort) ────────────────────────────────
// Downstream coords (focusRegion, keyframes, CV cursor/centroid) are normalized
// to the EFFECTIVE (cropped) frame. When the crop changes, re-express existing
// coords from the OLD crop space into the NEW one so auto-generated edits keep
// pointing at the same real content. `undefined`/disabled = full frame.

/** True when the two crops describe a materially different effective rect. */
function cropChanged(a?: SourceCrop, b?: SourceCrop): boolean {
  const ea = a?.enabled ? a : null;
  const eb = b?.enabled ? b : null;
  if (!ea && !eb) return false;
  if (!ea || !eb) return true;
  const eps = 0.001;
  return (
    Math.abs(ea.x - eb.x) > eps ||
    Math.abs(ea.y - eb.y) > eps ||
    Math.abs(ea.width - eb.width) > eps ||
    Math.abs(ea.height - eb.height) > eps
  );
}

function remapMomentForCrop(
  m: DetectedMoment,
  oldCrop: SourceCrop | undefined,
  newCrop: SourceCrop | undefined
): DetectedMoment {
  const focusRegion = remapRegion(m.focusRegion, oldCrop, newCrop);
  const next: DetectedMoment = { ...m, focusRegion };
  if (m.keyframes && m.keyframes.length > 0) {
    next.keyframes = m.keyframes.map((k) => {
      const nc = sourceToCropped(
        croppedToSource({ x: k.x, y: k.y }, oldCrop),
        newCrop
      );
      return { ...k, x: nc.x, y: nc.y };
    });
  }
  return next;
}

function remapVisualAnalysisForCrop(
  va: VisualAnalysis,
  oldCrop: SourceCrop | undefined,
  newCrop: SourceCrop | undefined
): VisualAnalysis {
  const remapPair = (xs?: number[], ys?: number[]) => {
    if (!xs || !ys) return null;
    const nx = xs.slice();
    const ny = ys.slice();
    const n = Math.min(nx.length, ny.length);
    for (let i = 0; i < n; i++) {
      const full = croppedToSource(
        { x: dequantize(xs[i]), y: dequantize(ys[i]) },
        oldCrop
      );
      const nc = sourceToCropped(full, newCrop);
      nx[i] = quantize(nc.x);
      ny[i] = quantize(nc.y);
    }
    return { x: nx, y: ny };
  };
  const cur = remapPair(va.cursorX, va.cursorY);
  const cen = remapPair(va.centroidX, va.centroidY);
  return {
    ...va,
    ...(cur ? { cursorX: cur.x, cursorY: cur.y } : {}),
    ...(cen ? { centroidX: cen.x, centroidY: cen.y } : {}),
  };
}

/**
 * The right-rail tools that open a docked inspector panel (one at a time).
 * Crop is NOT here — it edits directly on the preview via CropEditorOverlay
 * (no side panel needed); the rail's Crop button toggles `cropEditing` instead.
 */
export type RightTool =
  /** The AI chat — the primary way edits get asked for. */
  | "ai-chat"
  | "canvas"
  | "captions"
  /**
   * The ONE presets surface: the LIBRARY (captions/titles/hooks/CTAs/transitions
   * from `src/lib/presets/registry.ts`, each compiling to a real timeline edit)
   * AND the whole-recording Looks (BUILTIN_PRESETS), which are a tab inside it
   * rather than a rail button of their own.
   */
  | "presets-library"
  | "insights"
  | "clips";

/** Stable empty-array identity so this doesn't churn consumers each render. */
const EMPTY_MOMENTS: DetectedMoment[] = [];
/** Same, for the layer map: "nothing hidden" must be one stable reference. */
const EMPTY_LAYERS: LayerVisibility = {};

/**
 * One undo step. Both halves of the editable state travel together — the edits,
 * and which layers are hidden — so ⌘Z unwinds a mixed sequence of edit changes
 * and layer toggles in the exact order the user made them.
 */
interface EditorSnapshot {
  moments: DetectedMoment[];
  layers: LayerVisibility;
}

interface EditorRealContextValue {
  project: ProjectDoc;
  /**
   * Firebase uid, or null when no one is signed in. A LOCAL desktop project is
   * editable and exportable signed-out; the cloud-only actions (AI analysis,
   * captions, reframe, plan-gated presets) check `cloudAvailable` first.
   */
  uid: string | null;
  /** True when cloud features can run: signed in AND the project lives in the cloud. */
  cloudAvailable: boolean;
  /**
   * Persist a merge patch to whichever backend owns this project. The ONE write
   * path — components must never build a Firestore reference themselves.
   */
  writeProject: (patch: DocPatch, options?: ProjectWriteOptions) => Promise<void>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * NOTE: the playhead time is deliberately NOT on this context.
   *
   * It changes several times a second during playback and on every pointermove
   * while scrubbing; keeping it here meant every tick produced a new context
   * value and re-rendered all ~30 consumers (the whole timeline, the inspector,
   * the export panel). Read it from the dedicated clock instead:
   *
   *   usePlaybackTime()   — reactive, for components that RENDER the time
   *   useClockSelector()  — reactive on a derived value (e.g. "active chapter")
   *   useClockRef()       — non-reactive, for drag/snap math in event handlers
   *
   * See playback-clock.tsx.
   */
  playing: boolean;
  setPlaying: (p: boolean) => void;
  /** True while a client-side export render is running. The preview pauses its
   *  rAF loops so it doesn't compete with the exporter for the main thread. */
  exporting: boolean;
  setExporting: (v: boolean) => void;
  duration: number;
  setDuration: (d: number) => void;
  selectedMomentId: string | null;
  setSelectedMomentId: (id: string | null) => void;
  /** Extra moments selected via shift/ctrl/cmd-click for bulk operations. */
  multiSelectIds: string[];
  toggleMultiSelect: (id: string) => void;
  clearMultiSelect: () => void;
  deleteMultiSelected: () => Promise<void>;
  /** Modal "moment editor" — opens on add or via the pill's Edit button. */
  inspectorOpen: boolean;
  openInspector: () => void;
  closeInspector: () => void;
  /**
   * Before/After compare: while set, the LIVE PREVIEW renders as if this
   * moment didn't exist (hold-to-compare in the moment editor). Strictly a
   * preview-side override — never persisted, never seen by export.
   */
  compareBypassId: string | null;
  setCompareBypassId: (id: string | null) => void;
  /**
   * The single active right-rail tool / docked inspector (null = closed).
   * ONE source of truth for which docked panel is open. Persisted across
   * sessions. `canvasOpen`/`openCanvas`/`closeCanvas` below are derived from it.
   */
  activeTool: RightTool | null;
  setActiveTool: (t: RightTool | null) => void;
  /**
   * Preview-vs-timeline vertical split ratio (fraction of height given to the
   * preview, 0..1). Owned here (not locally in EditorSplitWorkspace) so the
   * unified control bar's Preview/Balanced/Timeline buttons — rendered inside
   * the timeline, far from the split's DOM — can read/set the same value.
   * Persisted; EditorSplitWorkspace still owns the live pointer-drag mechanics
   * and only calls this setter on commit (drag itself mutates the DOM directly
   * for performance, no re-render mid-drag).
   */
  splitFraction: number;
  setSplitFraction: (f: number) => void;
  /** Collapsible scene/chapter strip below the unified control bar — closed by
   *  default after analysis; remembers the user's last open/closed choice. */
  scenesOpen: boolean;
  toggleScenes: () => void;

  // ── Smart Clip Generation ───────────────────────────────────────────────
  /**
   * AI-suggested clips (from ProjectDoc.clips), normalized for rendering. THE
   * single source of truth — count, list, cards and empty state all read this.
   */
  clips: GeneratedClip[];
  /** How many clips are persisted, INCLUDING any we couldn't render. */
  clipsStoredCount: number;
  /** Persisted entries with no usable time window (shown, never hidden). */
  clipsDropped: DroppedClip[];
  /** True while (re)generating clips from analysis. */
  clipsGenerating: boolean;
  /**
   * Outcome of the last generation run this session (null before the first).
   * Carries the REASON for an empty/failed run so the panel can explain itself
   * instead of falling back to a vague "No clips yet".
   */
  clipsLastRun: ClipGenerationResult | null;
  /**
   * Compute clips from the current analysis signals + persist them. Returns the
   * outcome; a click while a run is in flight is a no-op (`status: "busy"`), so
   * a double-click can't write two clip sets.
   */
  generateClips: (opts?: {
    mode?: ClipGenMode;
    trigger?: ClipGenTrigger;
  }) => Promise<ClipGenerationResult>;
  /** Re-roll ONE clip (keeps its id; resets only its export state). */
  regenerateClip: (id: string) => Promise<void>;
  renameClip: (id: string, title: string) => Promise<void>;
  deleteClip: (id: string) => Promise<void>;
  /** The clip currently "opened" in the editor, or null. */
  focusedClipId: string | null;
  focusedClip: GeneratedClip | null;
  /** Open a clip: seek to its start + enter focused clip mode. */
  openClip: (id: string) => void;
  /** Exit clip focus (back to the full timeline). */
  exitClip: () => void;
  /**
   * FOCUSED CLIP MODE render overrides. While a clip is open the preview renders
   * its smart edits (hook text, restyled captions, emphasis zoom, CTA, aspect)
   * WITHOUT writing anything — these are the moments/effects the player should
   * use instead of `project.analysis.detectedMoments` / `project.effectsSettings`.
   * Identical (same reference) to the base values when no clip is focused.
   */
  previewMoments: DetectedMoment[];
  previewEffects: EffectsSettings;
  /**
   * The ONLY path that lets a clip mutate the project: bakes the clip's edits
   * into the real timeline (undoable) + adopts its aspect. Confirm with the user.
   */
  applyClipToTimeline: (clip: GeneratedClip) => Promise<void>;
  /**
   * The clip a pending export is scoped to. When set, the export panel renders
   * ONLY that clip's range WITH its smart edits + aspect — the full-video export
   * path is untouched. Cleared when the export dialog closes.
   */
  clipExport: GeneratedClip | null;
  /** Open the export dialog scoped to a clip. */
  requestClipExport: (clip: GeneratedClip) => void;
  /** Persist a clip's export lifecycle (queued → rendering → completed/failed). */
  updateClipExport: (clipId: string, event: ClipExportEvent) => Promise<void>;
  /** Export dialog open state (lifted here so the Clips panel can open it). */
  exportModalOpen: boolean;
  openExportModal: () => void;
  closeExportModal: () => void;

  /** Global "Canvas / Format" panel — derived from `activeTool === "canvas"`. */
  canvasOpen: boolean;
  openCanvas: () => void;
  closeCanvas: () => void;
  /**
   * Global "Frame Crop" editing mode. When true the preview shows the FULL
   * source frame with a draggable crop rectangle (camera + Canvas Fit + the
   * applied crop are bypassed) and a floating control bar.
   */
  cropEditing: boolean;
  openCropEditor: () => void;
  closeCropEditor: () => void;
  previewMode: boolean;
  setPreviewMode: (v: boolean) => void;
  /** Developer overlay: CV signal curves, scene markers, centroid path. */
  cvDebug: boolean;
  setCvDebug: (v: boolean) => void;
  updateMoment: (id: string, patch: Partial<DetectedMoment>) => Promise<void>;
  deleteMoment: (id: string) => Promise<void>;
  addMoment: (m: DetectedMoment) => Promise<void>;
  /**
   * Show/hide ONE edit non-destructively (any effect type). The edit stays on
   * the timeline, selectable and editable, and renders nothing in preview or
   * export while off. Its own undo step — never coalesced into a neighbouring
   * gesture, because a toggle is a decision, not a drag.
   */
  setMomentEnabled: (id: string, enabled: boolean) => Promise<void>;
  /**
   * Which timeline LAYERS are hidden (absent = visible). Read it through
   * `isLayerVisible` / `visibleMoments` — never index it raw.
   */
  layers: LayerVisibility;
  /**
   * Show/hide a whole layer (Zooms & focus, Cuts, Captions, …). Hides every edit
   * in that lane from preview + export WITHOUT touching the edits themselves, so
   * re-showing restores them exactly. Persisted on the project doc; undoable.
   */
  setLayerVisible: (layer: TimelineLayerId, visible: boolean) => Promise<void>;
  /** Un-hide every layer in ONE undoable step (never a toggle-per-layer loop). */
  showAllLayers: () => Promise<void>;
  /**
   * Set the shared `textStyle` on EVERY moment of `effectType` at once (e.g.
   * "apply this caption's style to all captions in the track"). Replaces each
   * moment's textStyle with `style` so the whole lane renders identically.
   */
  applyTextStyleToType: (effectType: EffectType, style: TextStyle) => Promise<void>;
  /** Delete every moment of these effect types (lane-level "clear"). */
  deleteLane: (effectTypes: EffectType[]) => Promise<void>;
  /** Duplicate a moment just after itself, as a fresh user-owned edit. */
  duplicateMoment: (id: string) => Promise<void>;
  /**
   * Split the selected edit(s) at the playhead into two independent edits.
   *
   * Goes through the same `commitMoments` funnel as every other mutation, so it
   * is one undo step and writes to the same `detectedMoments` array preview and
   * export read. Returns a human-readable reason when nothing could be split
   * (playhead outside the edit, or a half would be too short) — the caller shows
   * it rather than leaving the user with a button that silently does nothing.
   */
  splitAtPlayhead: (ids?: string[]) => Promise<string | null>;
  /** Manually insert an edit of the given effect at the current playhead. */
  addMomentAtPlayhead: (effectType: EffectType) => Promise<void>;
  /** Mint a stable unique id for a user-created moment. */
  newMomentId: () => string;
  /** Accept an AI suggestion — applies its insert/patch, then dismisses it. */
  acceptSuggestion: (s: AiSuggestion) => Promise<void>;
  /** Dismiss an AI suggestion without applying it. */
  dismissSuggestion: (id: string) => Promise<void>;
  updateEffects: <K extends keyof EffectsSettings>(
    key: K,
    value: EffectsSettings[K]
  ) => Promise<void>;
  /** Reset the output canvas to "Source / full frame" (removes outputCanvas). */
  clearOutputCanvas: () => Promise<void>;
  /** The video type the user picked before analysis (Auto Detect by default). */
  selectedVideoType: SelectedVideoType;
  /** Persist a new video type on the project (used before Generate AI Edit). */
  setSelectedVideoType: (t: SelectedVideoType) => Promise<void>;
  /**
   * Set (or update) the global source-frame crop. Instant + non-destructive —
   * the source bytes are untouched. If `visualAnalysis` exists and the crop
   * changed, existing moment focus regions/keyframes + CV cursor/centroid
   * coords are remapped from the old crop space into the new one.
   */
  setSourceCrop: (crop: SourceCrop) => Promise<void>;
  /** Remove the global source crop entirely (full frame). */
  clearSourceCrop: () => Promise<void>;
  /**
   * Toggle the browser-tab sharing-bar removal on/off (flips
   * `sourceCrop.enabled`, only when `reason === "browser-bar-cleanup"`).
   * Instant + non-destructive. No-op when the project has no such crop.
   */
  setRemoveSharingBar: (remove: boolean) => Promise<void>;
  applyPreset: (preset: Preset) => Promise<void>;
  clearSelectedPreset: () => Promise<void>;
  startAnalyze: (options: AnalysisOptions) => Promise<void>;
  /**
   * "Generate AI Captions" — the ONE automatic caption entry point (never runs
   * analysis / Gemini). Reuses a valid transcript when possible, else reserves
   * quota + dispatches ASR. Server-side duplicate protection guarantees a
   * repeated call can't charge twice or duplicate caption moments.
   */
  generateCaptions: (opts: {
    mode: TranscriptLanguageMode;
    code?: string;
    stylePreset?: OverlayTextPreset;
    position?: CaptionPosition;
    force?: boolean;
  }) => Promise<CaptionActionResult>;
  /** "Wrong language?" / change language — captions-only FORCED regeneration. */
  retranscribe: (opts: { mode: TranscriptLanguageMode; code?: string }) => Promise<void>;

  // ── AI Director ─────────────────────────────────────────────────────────
  /**
   * Persist the Director brief on the project.
   *
   * The brief is an INPUT to analysis, not a record of a run: the analyze route
   * reads it back off the project document and runs the Director as analysis's
   * final stage. There is no standalone Director run any more — the brief is
   * written by the Framevo AI panel (setup card or composer, via the canonical
   * run-request builder) and saved right before the run it belongs to starts.
   */
  saveDirectorBrief: (prompt: string, form: DirectorRequestForm) => Promise<void>;
  /** Delete AI-generated captions (manual captions survive). */
  deleteAiCaptions: () => Promise<void>;
  cancelAnalyze: () => Promise<void>;
  /**
   * Re-derive `focusRegion` for every non-user-positioned moment from the
   * project's stored interactions + visual analysis. Cheap (no Gemini call,
   * no balancer selection) — meant for users with projects analyzed before
   * directional framing existed. Returns the number of moments updated.
   */
  refineFraming: () => Promise<{ changedCount: number; totalCount: number }>;
  /** True while `refineFraming` is in flight. */
  refiningFraming: boolean;
  analyzing: boolean;
  analyzeError: string | null;
  /** 0..1 progress of the client-side CV pass, or null when not scanning. */
  cvProgress: number | null;
  /** Local flag: user clicked "minimize" — keep the analysis running but hide the modal. */
  processingMinimized: boolean;
  setProcessingMinimized: (v: boolean) => void;
  seek: (t: number) => void;
  /**
   * Toggle playback of the live preview. Drives the <video> element directly
   * (the single source of truth) — if the playhead is parked at the end, play
   * restarts from 0. Shared by the playback control bar, the fullscreen overlay
   * and keyboard shortcuts so there is ONE play/pause implementation.
   */
  togglePlay: () => void;
  /** Seek relative to the current time (e.g. -5 / +5 seconds), clamped + cut-safe. */
  seekBy: (delta: number) => void;

  // ── Preview volume — a LOCAL playback preference, never an exported edit ──
  /** Preview mute state (applies to the live <video> only; export audio is untouched). */
  muted: boolean;
  /** Preview volume 0..1 (applies to the live <video> only; export audio is untouched). */
  volume: number;
  /** Toggle preview mute. */
  toggleMute: () => void;
  /** Set preview volume 0..1 (0 also mutes; a positive value unmutes). */
  setPreviewVolume: (v: number) => void;

  /**
   * Live handle to the preview's smart-rebuffer hold (RealVideoPlayer writes
   * it; see useSmartBuffering). While a hold is active the <video> element is
   * PAUSED by the player — deliberately, until a real buffer builds — but the
   * user's intent is still "playing", so `togglePlay` must read this to tell
   * "paused because buffering" (toggle ⇒ genuinely pause) from "paused by the
   * user" (toggle ⇒ play). Null when no player is mounted.
   */
  bufferHoldRef: React.MutableRefObject<{
    active: boolean;
    cancel: () => void;
  } | null>;

  // ── Fullscreen (the preview/editor-preview container) ──
  /** Ref the preview attaches to the element that should go fullscreen. */
  previewFullscreenRef: React.RefObject<HTMLDivElement | null>;
  /** True while the preview container is the document's fullscreen element. */
  isFullscreen: boolean;
  /** Enter fullscreen on the preview container, or exit if already fullscreen. */
  toggleFullscreen: () => void;

  // ── Edit history (session-only, in-memory) ──────────────────────────────
  /** Revert the last moment mutation. No-op when the undo stack is empty. */
  undo: () => Promise<void>;
  /** Re-apply the last undone moment mutation. No-op when redo is empty. */
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;

  // ── Recording interactions (lazy-loaded sidecar, shared) ────────────────
  /** Cursor/click/focus events for tab recordings, or null when unavailable. */
  interactions: Interaction[] | null;
  /** True while the interactions sidecar is being fetched. */
  interactionsLoading: boolean;

  // ── Progressive chunked analysis ────────────────────────────────────────
  /** Live job state when a long video is analyzing in chunks, else null. */
  chunkedJob: AnalysisJob | null;
}

const Ctx = React.createContext<EditorRealContextValue | null>(null);

/**
 * Firestore rejects writes that contain `undefined` *values* anywhere in
 * the document. Spreading existing moments (or any doc previously read from
 * Firestore) preserves their explicit-`undefined` optional fields, which is
 * how a copy/duplicate write blows up with "Unsupported field value:
 * undefined". This recursively scrubs them.
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

const DEFAULT_EFFECT_LABEL: Record<EffectType, string> = {
  zoom: "Zoom",
  "click-highlight": "Click emphasis",
  "cursor-focus": "Focus",
  "speed-up": "Speed",
  cut: "Cut",
  crop: "Crop / Reframe",
  captions: "Captions",
  "hook-text": "Hook text",
  "text-overlay": "Text overlay",
  "smart-crop": "Smart crop",
  callout: "Callout",
  "blur-redaction": "Blur / Redaction",
  transition: "Transition",
  "branding-cta": "Branding / CTA",
};

function isGoodDuration(d: number | undefined | null): d is number {
  return typeof d === "number" && Number.isFinite(d) && d > 0;
}

/**
 * Resolve a RELIABLE video duration for the analysis-path decision. The stored
 * `project.duration` can be missing or `0` on old projects (and `??` won't fall
 * through a `0`), and `video.duration` is `NaN` until metadata loads — both
 * cases previously mis-routed long videos to the direct path. Prefer the loaded
 * element, then the stored value, and as a last resort wait for `loadedmetadata`
 * before giving up. Returns `0` only when nothing yields a real duration.
 */
async function resolveReliableDuration(
  video: HTMLVideoElement | null,
  project: ProjectDoc
): Promise<number> {
  if (video && isGoodDuration(video.duration)) return video.duration;
  if (isGoodDuration(project.duration)) return project.duration;
  if (video && video.readyState < 1 /* HAVE_METADATA */) {
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener("loadedmetadata", done);
        resolve();
      };
      video.addEventListener("loadedmetadata", done);
      window.setTimeout(done, 4000);
    });
    if (isGoodDuration(video.duration)) return video.duration;
  }
  return 0;
}

type AnalysisMode = "chunked" | "direct";

/** Explicit debug fallback to the legacy direct flow. */
function debugForceDirect(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URL(window.location.href).searchParams.get("debug") === "direct")
      return true;
    return window.localStorage.getItem("framevo:forceDirect") === "1";
  } catch {
    return false;
  }
}

/**
 * Single source of truth for the analysis architecture. Chunked progressive
 * analysis is the ONLY normal path for every video (short or long, new or old)
 * — it runs the CV/zoom/crop/speed engines on-device per 30s window, streams
 * results immediately, and finalizes with Gemini in the background. The legacy
 * direct (whole-video → Gemini) flow is reserved EXCLUSIVELY for an explicit
 * debug escape hatch (`?debug=direct` / localStorage `framevo:forceDirect`).
 * There is NO automatic fallback to direct: if chunked fails at runtime or no
 * duration is resolvable, `startAnalyze` HARD FAILS with the exact reason
 * (it never silently runs direct). Duration is NOT a routing factor.
 */
function selectAnalysisMode(
  _project: ProjectDoc,
  _video: HTMLVideoElement | null
): { mode: AnalysisMode; reason: string } {
  if (debugForceDirect()) return { mode: "direct", reason: "debug-fallback" };
  return { mode: "chunked", reason: "default" };
}

/**
 * How the editor persists: one merge patch at a time, through the platform's
 * `ProjectStorage`. Cloud (Firestore) and local (SQLite) both accept the same
 * patch — including the ./field-value sentinels — so nothing below this line
 * knows which backend it is writing to.
 */
type ProjectWriter = (patch: DocPatch, options?: ProjectWriteOptions) => Promise<void>;

/**
 * Write a terminal "failed" state for a chunked run. Mirrors the analyze
 * route's `bail()` shape so the overlay's existing `status: "failed"` handling
 * renders `errorMessage` verbatim — no schema change needed. This is used
 * INSTEAD of silently dropping to the legacy direct path: a chunked failure
 * must be loud + attributed in production, persisted where it's inspectable
 * (Firestore `analysis.errorMessage` + `activity[]`) without devtools.
 */
async function writeChunkFailure(
  writeProject: ProjectWriter,
  { errorKind, errorMessage }: { errorKind: AnalysisErrorKind; errorMessage: string }
): Promise<void> {
  await writeProject({
      status: "failed",
      analysis: {
        status: "failed",
        stage: "Chunked analysis failed",
        errorKind,
        errorMessage,
        cancelRequested: false,
        completedAt: Date.now(),
        activity: arrayUnion({ ts: Date.now(), kind: "error", text: errorMessage }),
      },
      updatedAt: serverTimestamp(),
    }).catch(() => {});
}

/**
 * Phase-accurate failure text for a chunked run.
 *
 * `runChunkedAnalysis` tags what it throws with the phase it died in, so a LATE
 * failure is never reported as a failure to start — a finalize-stage 404 once
 * read as "Chunked analysis failed to start", which points debugging at the
 * setup code when the fault was at the very end of the pipeline. An untagged
 * throw really is the start (duration resolve, engine selection, job creation);
 * a taint is always detected mid-decode, i.e. while chunking.
 */
function chunkFailureText(err: unknown, verb: "start" | "resume"): string {
  const reason = err instanceof Error ? err.message : String(err);
  const phase =
    err instanceof ChunkedAnalysisError
      ? err.phase
      : err instanceof CvTaintedError
        ? "chunking"
        : "start";
  if (phase === "chunking") {
    return `Chunked analysis failed while processing the video: ${reason}`;
  }
  if (phase === "finalizing") {
    return `Chunked analysis failed while finishing up: ${reason}`;
  }
  return `Chunked analysis failed to ${verb}: ${reason}`;
}

/**
 * A finalize failure is a DEGRADE, not a failure — the progressive edits are
 * already on the timeline, so the run completed and we stay quiet. The one case
 * worth surfacing is a run that added NOTHING: completing silently with nothing
 * to show for the run is exactly how a real regression hides.
 *
 * Worded as "this run added no new edits", NOT "produced no edits" —
 * `momentsAdded` counts only what THIS run appended, so the timeline can be
 * full of carry-over from earlier runs while this one added zero. Claiming
 * otherwise contradicts what the user is looking at.
 */
function finalizeDegradeText(result: ChunkedRunResult): string | null {
  if (!result.finalizeError || result.momentsAdded > 0) return null;
  return `Analysis finished, but this run added no new edits — the AI refinement step failed: ${result.finalizeError}`;
}

export function EditorRealProvider({
  uid,
  project,
  idTokenGetter,
  children,
}: {
  /** Null when signed out — legal for a local desktop project. */
  uid: string | null;
  project: ProjectDoc;
  idTokenGetter: () => Promise<string | null>;
  children: React.ReactNode;
}) {
  useRenderCount("provider");

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const { tier: planTier } = usePlanTier();
  // ── Playhead clock ────────────────────────────────────────────────────────
  // NOT React state. It ticks several times a second during playback and on
  // every pointermove while scrubbing; as provider state it re-rendered the
  // entire editor at that rate. As an external store the tick re-renders only
  // the components that subscribe (see playback-clock.tsx), and this provider
  // reads it through `clock.get()` inside callbacks — no subscription, no
  // re-render, and no stale-closure dependency to thread through useCallback.
  const [clock] = React.useState(() => createClockStore(0));
  const setCurrentTime = React.useMemo(
    () => (t: number) => clock.set(t),
    [clock]
  );
  const [playing, setPlaying] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [duration, setDuration] = React.useState(project.duration ?? 0);
  // User-selected video type (chosen before analysis). Seeds from the project
  // (default "auto") and stays in sync as the live doc updates.
  const [selectedVideoType, setSelectedVideoTypeState] = React.useState<SelectedVideoType>(
    () => normalizeSelectedVideoType(project.selectedVideoType)
  );
  React.useEffect(() => {
    setSelectedVideoTypeState(normalizeSelectedVideoType(project.selectedVideoType));
  }, [project.selectedVideoType]);
  const [selectedMomentId, setSelectedMomentId] = React.useState<string | null>(null);
  const [multiSelectIds, setMultiSelectIds] = React.useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const openInspector = React.useCallback(() => setInspectorOpen(true), []);
  const closeInspector = React.useCallback(() => setInspectorOpen(false), []);
  // Before/After hold-to-compare — preview-only, cleared by the moment editor
  // on release/close. Never persisted.
  const [compareBypassId, setCompareBypassId] = React.useState<string | null>(null);

  // ── Caption analytics — the transcription lifecycle is SEPARATE from the
  // AI-edit lifecycle (ANALYSIS_*). Watch the transcript's status transitions
  // (background ASR lands via the realtime subscription) and log the caption
  // events distinctly: completed / failed / quota-blocked.
  const prevTranscriptStatusRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const t = project.analysis?.transcript;
    const status = t?.status ?? null;
    const prev = prevTranscriptStatusRef.current;
    prevTranscriptStatusRef.current = status;
    if (!status || prev === status || prev === null) return;
    if (status === "complete") {
      logFramevoEvent(EVENTS.CAPTION_TRANSCRIPTION_COMPLETED, {
        language: t?.language ?? t?.requestedLanguageCode ?? "unknown",
        segments: t?.segments?.length ?? 0,
      });
    } else if (status === "failed") {
      logFramevoEvent(EVENTS.CAPTION_TRANSCRIPTION_FAILED);
    } else if (
      status === "unavailable" &&
      (t?.skipReason === "quota_exhausted" || t?.skipReason === "per_video_limit")
    ) {
      logFramevoEvent(EVENTS.CAPTION_QUOTA_BLOCKED, { reason: t.skipReason });
    }
  }, [project.analysis?.transcript]);
  // ONE source of truth for the docked right-rail inspector. Persisted so the
  // editor reopens to the tool the user left open. `canvasOpen`/open/close are
  // derived so existing callers (e.g. the Export panel's "Open Canvas") keep
  // working unchanged.
  const [activeTool, setActiveTool] = React.useState<RightTool | null>(() => {
    // A user whose last-open tool was the retired "effects" or "presets" (Looks)
    // fails this whitelist and simply reopens with no panel — which is right:
    // those panels no longer exist.
    const v = readPersistedString<RightTool | "">(
      "framevo:editor-tool",
      ["canvas", "captions", "presets-library", "insights", "clips", ""],
      ""
    );
    return v === "" ? null : v;
  });
  React.useEffect(() => {
    writePersistedString("framevo:editor-tool", activeTool ?? "");
  }, [activeTool]);
  const canvasOpen = activeTool === "canvas";
  const openCanvas = React.useCallback(() => setActiveTool("canvas"), []);
  const closeCanvas = React.useCallback(
    () => setActiveTool((t) => (t === "canvas" ? null : t)),
    []
  );

  // Preview/timeline split ratio — see workspace-split.ts for the shared
  // constants/clamp. EditorSplitWorkspace's live drag mutates the DOM directly
  // for performance and only calls this setter once, on release.
  const [splitFraction, setSplitFractionState] = React.useState<number>(() =>
    clampSplitFraction(readPersistedNumber(SPLIT_FRACTION_KEY, MODE_FRACTION.balanced))
  );
  const setSplitFraction = React.useCallback((f: number) => {
    const c = clampSplitFraction(f);
    setSplitFractionState(c);
    writePersistedNumber(SPLIT_FRACTION_KEY, c);
  }, []);

  // Collapsible scene/chapter strip — closed by default after analysis;
  // remembers the user's last open/closed choice.
  const [scenesOpen, setScenesOpen] = React.useState(() =>
    readPersistedBool("framevo:editor-scenes-open", false)
  );
  const toggleScenes = React.useCallback(() => {
    setScenesOpen((v) => {
      const next = !v;
      writePersistedBool("framevo:editor-scenes-open", next);
      return next;
    });
  }, []);

  const [cropEditing, setCropEditing] = React.useState(false);
  const openCropEditor = React.useCallback(() => setCropEditing(true), []);
  const closeCropEditor = React.useCallback(() => setCropEditing(false), []);
  const [previewMode, setPreviewMode] = React.useState(true);
  const [cvDebug, setCvDebug] = React.useState(false);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeError, setAnalyzeError] = React.useState<string | null>(null);
  const [processingMinimized, setProcessingMinimized] = React.useState(false);
  const [cvProgress, setCvProgress] = React.useState<number | null>(null);
  const [chunkedJob, setChunkedJob] = React.useState<AnalysisJob | null>(null);
  const cvAbortRef = React.useRef<AbortController | null>(null);
  // Single-flight: only one chunked orchestrator may run per editor session.
  // Prevents the double-run that resets `project.status` back to "analyzing"
  // after a run already finalized (the "stuck processing" bug).
  const chunkRunningRef = React.useRef(false);

  // ── Analysis completion → notification ─────────────────────────────────
  // `startAnalyze` kicks off the server route and returns immediately;
  // the completion arrives later via the Firestore snapshot updating
  // `project.analysis.status`. Watch for the transition into "complete"
  // / "failed" here and push the navbar notification at the transition
  // edge so a re-render of the same status doesn't re-notify.
  const notifications = useNotifications();
  const lastAnalysisStatusRef = React.useRef<string | undefined>(
    project.analysis?.status
  );
  React.useEffect(() => {
    const prev = lastAnalysisStatusRef.current;
    const curr = project.analysis?.status;
    if (prev === curr) return;
    lastAnalysisStatusRef.current = curr;
    if (curr === "complete" && prev !== "complete") {
      const momentCount = project.analysis?.detectedMoments?.length ?? 0;
      notifications.push({
        id: `analysis-completed:${project.id}:${project.analysis?.completedAt ?? "current"}`,
        kind: "analysis-completed",
        title: "AI analysis ready",
        body: `${project.title || "Untitled"} — ${momentCount} moment${momentCount === 1 ? "" : "s"} detected`,
        href: `/dashboard/projects/${project.id}`,
      });
    } else if (curr === "failed" && prev !== "failed") {
      notifications.push({
        id: `analysis-failed:${project.id}:${project.analysis?.completedAt ?? Date.now()}`,
        kind: "analysis-failed",
        title: "AI analysis failed",
        body: `${project.title || "Untitled"} — open the project to retry`,
        href: `/dashboard/projects/${project.id}`,
      });
    }
  }, [
    project.id,
    project.title,
    project.analysis?.status,
    project.analysis?.completedAt,
    project.analysis?.detectedMoments?.length,
    notifications,
  ]);

  // NOTE: "the moment under the playhead" and "can the selection be split here"
  // deliberately do NOT live in this provider — see `useActiveMoment` and
  // `useCanSplitSelection` at the bottom of this file. Both were
  // `useSyncExternalStore(clock.subscribe, …)` HERE, which meant that crossing an
  // edit boundary re-rendered the provider, rebuilt the one context value, and
  // re-rendered all ~30 consumers — the timeline with every pill, the export
  // panel, the control bar — to update an overlay and one button's disabled
  // state. Measured: 3s of playback cost 15 provider renders and 9 apiece of the
  // timeline, the preview and the control bar. As hooks, the subscription lands
  // only in the handful of components that actually read the value.

  const seek = React.useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    // Snap seeks out of active cuts (removed ranges) so the playhead can't land
    // inside removed time. Covers timeline clicks + moment click-to-seek.
    const snapped = snapOutOfActiveCut(momentsRef.current, t);
    v.currentTime = Math.max(0, Math.min(v.duration || snapped, snapped));
    setCurrentTime(v.currentTime);
  }, [setCurrentTime]);

  // Smart-rebuffer hold handle, written by RealVideoPlayer (useSmartBuffering).
  // A ref on purpose: it flips with buffering state and nothing should
  // re-render on it — togglePlay reads it at call time.
  const bufferHoldRef = React.useRef<{ active: boolean; cancel: () => void } | null>(null);

  const togglePlay = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const hold = bufferHoldRef.current;
    if (v.paused && !hold?.active) {
      // Parked at the end (the browser paused on 'ended') → restart from 0 so
      // pressing Play again replays the video instead of doing nothing.
      if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.05) {
        v.currentTime = 0;
        setCurrentTime(0);
      }
      // Swallow the AbortError browsers throw when play() races a pause().
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      // Playing — or paused by the rebuffer hold, which the UI (correctly)
      // still presents as playing. Either way the user's intent is "pause":
      // cancel the hold so it can't auto-resume, and make the paused state
      // explicit (no `pause` event fires when the element is already paused).
      hold?.cancel();
      v.pause();
      setPlaying(false);
    }
  }, [setCurrentTime]);

  // Reads the clock at call time rather than closing over it, so this keeps ONE
  // identity for the life of the editor. Arrow-key seeking used to rebuild this
  // callback on every tick, which invalidated every keyboard handler that
  // depended on it.
  const seekBy = React.useCallback(
    (delta: number) => {
      const v = videoRef.current;
      const base = v ? v.currentTime : clock.get();
      seek(base + delta);
    },
    [seek, clock]
  );

  // ── Preview volume + fullscreen (local playback prefs, shared by the
  //    playback bar + the fullscreen overlay; the <video> element itself is
  //    kept in sync by RealVideoPlayer, which owns the element). ──
  const [muted, setMuted] = React.useState(false);
  const [volume, setVolume] = React.useState(1);
  const toggleMute = React.useCallback(() => setMuted((m) => !m), []);
  const setPreviewVolume = React.useCallback((v: number) => {
    const x = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    setVolume(x);
    setMuted(x === 0); // dragging to 0 mutes; any positive value unmutes
  }, []);

  const previewFullscreenRef = React.useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  React.useEffect(() => {
    // Fires for both our requestFullscreen AND the browser's native Escape exit,
    // so `isFullscreen` (and the icon) always reflect reality.
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === previewFullscreenRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = React.useCallback(() => {
    const el = previewFullscreenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  }, []);

  // THE write path. `storage` is Firestore in the browser; in the desktop app
  // it is whichever backend owns THIS document — the local SQLite library for a
  // project imported here, Firestore for one that came from the account. The
  // document names its own home (`userId`), so this cannot disagree with where
  // the editor read it from. The patches below are identical either way.
  const platform = usePlatform();
  const storage = platform.storageFor(project);
  // Live handle on the current document for callbacks that need to READ it at
  // call time. Depending on `project` directly (as several mutators used to)
  // gave every one of them a new identity on every write, which defeated
  // memoization all the way down the tree — the write echoes back a new
  // `project`, so the callbacks rebuilt on exactly the path that most needed
  // them to be stable.
  // Mirrored in an effect (not during render) to match `momentsRef`/`layersRef`
  // below. Effects flush before the next user interaction, so a callback fired
  // from an event always sees the current document.
  const projectRef = React.useRef(project);
  React.useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const writeProject = React.useCallback<ProjectWriter>(
    (patch, options) => storage.write(projectRef.current.id, patch, options),
    [storage]
  );
  // AI analysis, transcription and reframe run on Framevo's servers against the
  // uploaded source, so they need BOTH a signed-in user and a cloud project. A
  // local desktop project has neither — every other editing tool still works.
  const cloudAvailable = storage.kind === "cloud" && !!uid;
  const requireCloud = React.useCallback(
    (action: string): string => {
      if (!uid) throw new Error(`Sign in to ${action}.`);
      if (storage.kind !== "cloud") {
        throw new Error(
          `${action[0].toUpperCase()}${action.slice(1)} runs in the cloud — turn on cloud sync for this project first.`
        );
      }
      return uid;
    },
    [uid, storage.kind]
  );

  // ── Smart Clip Generation ───────────────────────────────────────────────
  /**
   * THE source of truth for clips: the persisted `ProjectDoc.clips`, normalized
   * for rendering. Every consumer (panel, cards, count, empty state, export)
   * reads this ONE list, so a count can never disagree with what's on screen.
   *
   * `clipsDropped` are entries we couldn't render at all (no usable time window)
   * — surfaced in the panel rather than silently filtered. They're excluded from
   * `clips`, so a later write (rename/delete/regenerate) drops them for good;
   * that's a repair, not a loss — a clip with no window can't be opened, previewed
   * or exported by anything.
   */
  const { clips, dropped: clipsDropped } = React.useMemo(
    () => toRenderableClips(project.clips),
    [project.clips]
  );
  const clipsStoredCount = project.clips?.length ?? 0;
  const [clipsGenerating, setClipsGenerating] = React.useState(false);
  const [clipsLastRun, setClipsLastRun] = React.useState<ClipGenerationResult | null>(null);
  const [focusedClipId, setFocusedClipId] = React.useState<string | null>(null);
  const [exportModalOpen, setExportModalOpen] = React.useState(false);
  /** The clip a pending export is scoped to (the whole clip — its edits ride along). */
  const [clipExport, setClipExport] = React.useState<GeneratedClip | null>(null);

  const baseMoments = project.analysis?.detectedMoments ?? EMPTY_MOMENTS;
  const focusedClip = React.useMemo(
    () => (focusedClipId ? clips.find((c) => c.id === focusedClipId) ?? null : null),
    [clips, focusedClipId]
  );

  /**
   * FOCUSED CLIP MODE — the preview renders the clip's smart edits (hook text,
   * restyled captions, emphasis zoom, CTA) and its suggested aspect. This is a
   * RENDER-SIDE override only: `project.analysis.detectedMoments` and
   * `project.effectsSettings` are never written. The original timeline is
   * untouched until the user explicitly runs `applyClipToTimeline`.
   * Falls back to the exact base objects (same reference) when no clip is
   * focused, so nothing downstream re-renders on the normal path.
   */
  /**
   * Layer visibility is applied HERE, on the way to the renderer — not on the
   * timeline. The timeline keeps drawing every edit (dimmed when its layer is
   * off, so you can still select, edit and un-hide it); the PLAYER is handed a
   * list with the hidden layers' edits removed entirely, which is why a hidden
   * Cuts layer stops cutting and a hidden Captions layer stops drawing: the
   * selectors downstream never see those moments at all.
   */
  const layers = project.timelineLayers ?? EMPTY_LAYERS;
  const previewMoments = React.useMemo(
    () =>
      visibleMoments(
        focusedClip ? clipPreviewMoments(baseMoments, focusedClip) : baseMoments,
        layers
      ),
    [baseMoments, focusedClip, layers]
  );
  const previewEffects = React.useMemo(
    () =>
      focusedClip
        ? clipEffects(
            project.effectsSettings,
            focusedClip,
            project.width ?? 0,
            project.height ?? 0
          )
        : project.effectsSettings,
    [project.effectsSettings, project.width, project.height, focusedClip]
  );

  const writeClips = React.useCallback(
    async (next: GeneratedClip[]) => {
      await writeProject({ clips: next, updatedAt: serverTimestamp() });
    },
    [writeProject]
  );

  const clipGenInput = React.useCallback(
    () => ({
      duration: project.duration ?? 0,
      selectedVideoType: project.selectedVideoType,
      analysis: project.analysis,
      visualAnalysis: project.visualAnalysis,
    }),
    [project.duration, project.selectedVideoType, project.analysis, project.visualAnalysis]
  );

  /**
   * The generation flow lives in a plain controller (src/lib/clips/clip-generation.ts)
   * so the whole thing — one-run-at-a-time, the empty/failure reasons, the
   * export-preserving regenerate, the six clips_* events — is testable without
   * React. This ref keeps it reading FRESH clips/analysis on every run while
   * staying identity-stable, so `generateClips` never changes identity and the
   * panel's auto-run effect can't re-fire.
   */
  const clipDepsRef = React.useRef({
    clips,
    clipGenInput,
    writeClips,
    analysisComplete: project.analysis?.status === "complete",
    projectId: project.id,
  });
  clipDepsRef.current = {
    clips,
    clipGenInput,
    writeClips,
    analysisComplete: project.analysis?.status === "complete",
    projectId: project.id,
  };

  const clipControllerRef = React.useRef<ClipGenerationController | null>(null);
  if (!clipControllerRef.current) {
    clipControllerRef.current = createClipGenerationController({
      buildInput: () => clipDepsRef.current.clipGenInput(),
      readClips: () => clipDepsRef.current.clips,
      writeClips: (next) => clipDepsRef.current.writeClips(next),
      isAnalyzed: () => clipDepsRef.current.analysisComplete,
      // COUNTS ONLY — the controller builds these payloads from ClipGenStats and
      // never sees transcript text.
      emit: (event, payload) => {
        if (process.env.NODE_ENV !== "production") {
          console.debug(`[clips] ${event}`, payload);
        }
        void trackEvent(event, payload, { projectId: clipDepsRef.current.projectId });
      },
      onRunningChange: setClipsGenerating,
    });
  }

  const generateClips = React.useCallback(
    async (opts?: { mode?: ClipGenMode; trigger?: ClipGenTrigger }) => {
      const res = await clipControllerRef.current!.run(opts);
      // A `busy` run did nothing — keep the previous outcome on screen.
      if (res.status !== "busy") setClipsLastRun(res);
      if (res.status === "failed" && res.error) {
        console.error("[clips] generation failed:", res.error);
      }
      return res;
    },
    []
  );

  /**
   * Re-roll ONE clip, keeping its id (so focus/export references stay valid) and
   * leaving every other clip — including their export state — untouched. The
   * content changes, so its own export state resets: the old render no longer
   * represents this clip.
   */
  const regenerateClip = React.useCallback(
    async (id: string) => {
      const target = clips.find((c) => c.id === id);
      if (!target) return;
      setClipsGenerating(true);
      try {
        const fresh = computeClips(clipGenInput());
        const others = clips.filter((c) => c.id !== id);
        const overlap = (a: GeneratedClip, b: GeneratedClip) =>
          Math.max(
            0,
            Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime)
          );
        // Prefer a fresh window that isn't already covered by another clip;
        // among those, the one closest to what this clip was.
        const candidate =
          fresh
            .filter((f) => !others.some((o) => overlap(o, f) > 0.5 * Math.min(o.duration, f.duration)))
            .sort((a, b) => overlap(target, b) - overlap(target, a) || b.score - a.score)[0] ??
          fresh.sort((a, b) => b.score - a.score)[0];
        if (!candidate) return;
        const replaced: GeneratedClip = {
          ...candidate,
          id: target.id,
          exportStatus: "idle",
          updatedAt: Date.now(),
        };
        delete replaced.exportJobId;
        delete replaced.exportUrl;
        delete replaced.exportError;
        delete replaced.exportSettingsHash;
        delete replaced.exportSourceFingerprint;
        await writeClips(clips.map((c) => (c.id === id ? replaced : c)));
      } finally {
        setClipsGenerating(false);
      }
    },
    [clips, clipGenInput, writeClips]
  );

  const renameClip = React.useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      await writeClips(
        clips.map((c) => (c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c))
      );
    },
    [clips, writeClips]
  );

  const deleteClip = React.useCallback(
    async (id: string) => {
      setFocusedClipId((cur) => (cur === id ? null : cur));
      setClipExport((cur) => (cur?.id === id ? null : cur));
      await writeClips(clips.filter((c) => c.id !== id));
    },
    [clips, writeClips]
  );

  /** Persist a clip's export lifecycle (queued → rendering → completed/failed). */
  const updateClipExport = React.useCallback(
    async (clipId: string, event: ClipExportEvent) => {
      const cur = clips.find((c) => c.id === clipId);
      if (!cur) return;
      const next = withClipExportEvent(cur, event);
      await writeClips(replaceClip(clips, next));
    },
    [clips, writeClips]
  );

  const openClip = React.useCallback(
    (id: string) => {
      const clip = clips.find((c) => c.id === id);
      if (!clip) return;
      setFocusedClipId(id);
      seek(Math.max(0, clip.startTime + 0.01));
    },
    [clips, seek]
  );
  const exitClip = React.useCallback(() => setFocusedClipId(null), []);

  const openExportModal = React.useCallback(() => setExportModalOpen(true), []);
  const closeExportModal = React.useCallback(() => {
    setExportModalOpen(false);
    // A clip export is a per-export intent — never let it linger onto the next
    // (full-video) export.
    setClipExport(null);
  }, []);
  const requestClipExport = React.useCallback((clip: GeneratedClip) => {
    setClipExport(clip);
    setExportModalOpen(true);
  }, []);

  // ── Shared interactions sidecar ─────────────────────────────────────────
  // Lazy-loaded once here (instead of per-consumer) so the inspector's
  // "Follow cursor" preset and the timeline's cursor/click lane share a
  // single fetch + cache for the lifetime of the project view.
  const { interactions, loading: interactionsLoading } = useInteractions({
    interactionsPath: project.interactionsPath,
    scope: project.interactionScope,
  });

  // ── Edit history (session-only, in-memory) ──────────────────────────────
  // Every mutation funnels through `commitSnapshot`, which pushes the PRIOR
  // snapshot onto an undo stack before writing. `undo`/`redo` move whole
  // snapshots between the two stacks and persist via the same `setDoc` path — so
  // the camera/export contract (which only reads the moment array) is never
  // touched. History is in-memory: a refresh starts fresh, matching
  // editor-session expectations and keeping the Firestore doc lean.
  //
  // A snapshot is BOTH editable states, because both are things the user can
  // change and therefore expects ⌘Z to take back: the moments, and which layers
  // are hidden. They travel together so a mixed sequence (hide a layer → move a
  // clip → hide another layer) unwinds in the exact order it was made.
  const HISTORY_LIMIT = 50;
  const momentsRef = React.useRef<DetectedMoment[]>(
    project.analysis?.detectedMoments ?? []
  );
  React.useEffect(() => {
    momentsRef.current = project.analysis?.detectedMoments ?? [];
  }, [project.analysis?.detectedMoments]);

  const layersRef = React.useRef<LayerVisibility>(project.timelineLayers ?? {});
  React.useEffect(() => {
    layersRef.current = project.timelineLayers ?? {};
  }, [project.timelineLayers]);

  const undoStackRef = React.useRef<EditorSnapshot[]>([]);
  const redoStackRef = React.useRef<EditorSnapshot[]>([]);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  // The single funnel: persist a whole snapshot (moments + layer visibility).
  // `stripUndefined` runs on every write (Firestore rejects literal
  // `undefined` anywhere in the doc) — centralising it here removes the
  // earlier inconsistency where only some mutators scrubbed.
  const writeSnapshot = React.useCallback(
    async (snap: EditorSnapshot, coalesce = false) => {
      // Serialize through the per-project write queue so a user edit can't
      // collide with a chunk append / finalize write ("Another write batch or
      // compaction is already active").
      //
      // `coalesce` (used by high-frequency edits like slider / colour drags)
      // tags the write so that while one sits un-started in the queue, a newer
      // one supersedes it and the older is skipped. This is SAFE here because
      // every write persists the FULL snapshot (never a partial merge), so the
      // latest one subsumes the ones it replaces. Without this, a fast drag
      // enqueues dozens of setDocs and Firestore throws "Write stream exhausted
      // maximum allowed queued writes"; the local cache still updates on each
      // write that DOES run, so the preview stays live.
      //
      // Both fields go in every write. `timelineLayers` is tiny (11 booleans),
      // and writing it unconditionally is what lets undo/redo restore a snapshot
      // with ONE call — no "which half changed?" bookkeeping to get wrong.
      //
      // It is NORMALIZED (every layer, explicit boolean) because `merge: true`
      // deep-merges maps: a sparse map can add a `false` but can never take one
      // away, so re-showing a layer — or undoing a hide — would write a map that
      // merges to no change at all. See normalizeLayerVisibility.
      // Reads the live document from the ref rather than closing over it: this
      // callback is the root of every moment mutator, so a dependency on
      // `project.analysis` (a fresh object after each write) rebuilt
      // updateMoment/addMoment/split/… on every single edit. Now the whole
      // mutator surface keeps one identity for the life of the editor.
      const current = projectRef.current;
      await enqueueProjectWrite(
        current.id,
        "user-moments-write",
        () =>
          writeProject({
              analysis: stripUndefined({
                ...(projectRef.current.analysis ?? {}),
                detectedMoments: snap.moments,
              }),
              timelineLayers: normalizeLayerVisibility(snap.layers),
              updatedAt: serverTimestamp(),
            }),
        coalesce ? { coalesceTag: "user-moments-write" } : undefined
      );
    },
    [writeProject]
  );

  // Group rapid successive edits (a single slider/colour drag) into ONE undo
  // step, so a drag doesn't evict 50 real edits from the bounded history.
  const lastLiveCommitAtRef = React.useRef(0);
  const GESTURE_COALESCE_MS = 600;

  const commitSnapshot = React.useCallback(
    async (next: EditorSnapshot, opts?: { coalesce?: boolean }) => {
      const now = Date.now();
      // Only skip the undo snapshot when this commit continues an in-progress
      // gesture (coalesced edits arriving within the window); a single undo
      // then reverts the whole drag to its pre-gesture state.
      const continuesGesture =
        opts?.coalesce === true && now - lastLiveCommitAtRef.current < GESTURE_COALESCE_MS;
      if (!continuesGesture) {
        undoStackRef.current.push({
          moments: momentsRef.current,
          layers: layersRef.current,
        });
        if (undoStackRef.current.length > HISTORY_LIMIT) {
          undoStackRef.current.shift();
        }
        redoStackRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
      }
      if (opts?.coalesce) lastLiveCommitAtRef.current = now;
      // Optimistic ref update so two rapid edits chain off each other's
      // result instead of both reading the same (now stale) snapshot.
      momentsRef.current = next.moments;
      layersRef.current = next.layers;
      await writeSnapshot(next, opts?.coalesce);
    },
    [writeSnapshot]
  );

  /** Commit new moments, carrying the CURRENT layer visibility unchanged. */
  const commitMoments = React.useCallback(
    async (next: DetectedMoment[], opts?: { coalesce?: boolean }) => {
      await commitSnapshot({ moments: next, layers: layersRef.current }, opts);
    },
    [commitSnapshot]
  );

  const undo = React.useCallback(async () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push({
      moments: momentsRef.current,
      layers: layersRef.current,
    });
    momentsRef.current = prev.moments;
    layersRef.current = prev.layers;
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
    await writeSnapshot(prev);
  }, [writeSnapshot]);

  const redo = React.useCallback(async () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push({
      moments: momentsRef.current,
      layers: layersRef.current,
    });
    momentsRef.current = next.moments;
    layersRef.current = next.layers;
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
    await writeSnapshot(next);
  }, [writeSnapshot]);

  /**
   * Show/hide a whole LAYER. Writes only `timelineLayers` — the lane's moments
   * are not read, not rewritten, not marked edited. That is the guarantee: hide
   * Captions, then show it again, and every caption comes back exactly as it was,
   * including any that the user had individually hidden (those stay hidden,
   * because their own `enabled: false` was never overwritten).
   */
  const setLayerVisible: EditorRealContextValue["setLayerVisible"] =
    React.useCallback(
      async (layer, visible) => {
        if (isLayerVisible(layersRef.current, layer) === visible) return;
        const nextLayers: LayerVisibility = {
          ...layersRef.current,
          [layer]: visible,
        };
        await commitSnapshot({ moments: momentsRef.current, layers: nextLayers });
      },
      [commitSnapshot]
    );

  const showAllLayers: EditorRealContextValue["showAllLayers"] =
    React.useCallback(async () => {
      const hidden = hiddenLayerIds(layersRef.current);
      if (hidden.length === 0) return;
      // ONE commit, so "Show all layers" is ONE ⌘Z — not one per layer. The write
      // is normalized to explicit booleans, so this genuinely clears every `false`.
      const next: LayerVisibility = { ...layersRef.current };
      for (const id of hidden) next[id] = true;
      await commitSnapshot({ moments: momentsRef.current, layers: next });
    }, [commitSnapshot]);

  // A fresh analysis replaces the entire moment set, so any captured
  // snapshots become meaningless — clear both stacks at that transition.
  const lastCompletedAtRef = React.useRef(project.analysis?.completedAt);
  React.useEffect(() => {
    if (project.analysis?.completedAt !== lastCompletedAtRef.current) {
      lastCompletedAtRef.current = project.analysis?.completedAt;
      undoStackRef.current = [];
      redoStackRef.current = [];
      setCanUndo(false);
      setCanRedo(false);
    }
  }, [project.analysis?.completedAt]);

  // Write helpers — all merge-safe writes that the security rules allow.
  const updateMoment: EditorRealContextValue["updateMoment"] = React.useCallback(
    async (id, patch) => {
      const next = momentsRef.current.map((m) =>
        m.id === id ? ({ ...m, ...patch, edited: true } as DetectedMoment) : m
      );
      // Coalesce: inspector sliders / colour pickers / numeric fields fire this
      // continuously during a drag. Latest-wins write coalescing + gesture-level
      // undo grouping keep a drag from flooding Firestore's write stream while
      // the preview stays live off each write that runs.
      await commitMoments(next, { coalesce: true });
    },
    [commitMoments]
  );

  // `selectedMomentId` is read through the functional setter rather than closed
  // over, so this keeps ONE identity across selection changes. Closing over it
  // rebuilt `deleteMoment` on every selection, which rebuilt the lane's
  // `onDelete` prop, which re-rendered every pill on the timeline — for a click.
  const deleteMoment: EditorRealContextValue["deleteMoment"] = React.useCallback(
    async (id) => {
      const next = momentsRef.current.filter((m) => m.id !== id);
      await commitMoments(next);
      setSelectedMomentId((current) => (current === id ? null : current));
      setMultiSelectIds((ids) => ids.filter((x) => x !== id));
    },
    [commitMoments]
  );

  // Per-edit show/hide. Deliberately NOT routed through `updateMoment`: that one
  // coalesces (for slider drags) and stamps `edited: true`. Hiding an edit
  // changes no edit content, and each toggle should be one clean undo step you
  // can take back on its own.
  const setMomentEnabled: EditorRealContextValue["setMomentEnabled"] =
    React.useCallback(
      async (id, enabled) => {
        let changed = false;
        const next = momentsRef.current.map((m) => {
          if (m.id !== id) return m;
          if ((m.enabled !== false) === enabled) return m; // already in state
          changed = true;
          return { ...m, enabled };
        });
        if (changed) await commitMoments(next);
      },
      [commitMoments]
    );

  // NOTE: `setCaptionsEnabled` / `setLaneEnabled` (bulk `enabled: false` sweeps
  // across a lane's moments) are GONE — `setLayerVisible` replaces both. They
  // couldn't satisfy "re-enabling restores the edits exactly": stamping every
  // caption with `enabled: false` overwrites the flag of any caption the user had
  // hidden ONE BY ONE, so switching the lane back on would resurrect it. Layer
  // visibility is its own field precisely so a layer toggle never writes to an
  // edit. Don't reintroduce a lane-wide moment sweep for visibility.

  // Apply one text style to every moment of a type in ONE undoable step. Used by
  // the caption inspector's "Apply to all captions" action. `edited: true` marks
  // them as user-tuned so the balancer/regeneration won't silently overwrite.
  const applyTextStyleToType: EditorRealContextValue["applyTextStyleToType"] =
    React.useCallback(
      async (effectType, style) => {
        let changed = false;
        const next = momentsRef.current.map((m) => {
          if (m.effectType !== effectType) return m;
          changed = true;
          return { ...m, textStyle: { ...style }, edited: true } as DetectedMoment;
        });
        if (changed) await commitMoments(next);
      },
      [commitMoments]
    );

  // Lane-level clear — deletes every moment of these effect types in ONE step.
  const deleteLane: EditorRealContextValue["deleteLane"] = React.useCallback(
    async (effectTypes) => {
      const types = new Set<EffectType>(effectTypes);
      const cur = momentsRef.current;
      const next = cur.filter((m) => !types.has(m.effectType));
      if (next.length === cur.length) return;
      await commitMoments(next);
      const survives = new Set(next.map((m) => m.id));
      if (selectedMomentId && !survives.has(selectedMomentId)) setSelectedMomentId(null);
      setMultiSelectIds((ids) => ids.filter((x) => survives.has(x)));
    },
    [commitMoments, selectedMomentId]
  );

  const toggleMultiSelect = React.useCallback((id: string) => {
    setMultiSelectIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  }, []);

  const clearMultiSelect = React.useCallback(() => setMultiSelectIds([]), []);

  const deleteMultiSelected: EditorRealContextValue["deleteMultiSelected"] =
    React.useCallback(async () => {
      if (multiSelectIds.length === 0) return;
      const kill = new Set(multiSelectIds);
      const next = momentsRef.current.filter((m) => !kill.has(m.id));
      await commitMoments(next);
      if (selectedMomentId && kill.has(selectedMomentId)) setSelectedMomentId(null);
      setMultiSelectIds([]);
    }, [commitMoments, multiSelectIds, selectedMomentId]);

  const addMoment: EditorRealContextValue["addMoment"] = React.useCallback(
    async (m) => {
      const next = [...momentsRef.current, m].sort(
        (a, b) => a.startTime - b.startTime
      );
      await commitMoments(next);
    },
    [commitMoments]
  );

  // Stable unique ids for user-created moments — never collide with the
  // balancer's `m1, m2…` ids (which get re-issued on re-balance).
  const idCounterRef = React.useRef(0);
  const newMomentId = React.useCallback((): string => {
    idCounterRef.current += 1;
    return `u${Date.now().toString(36)}${idCounterRef.current.toString(36)}`;
  }, []);

  const duplicateMoment: EditorRealContextValue["duplicateMoment"] =
    React.useCallback(
      async (id) => {
        const moments = momentsRef.current;
        const src = moments.find((m) => m.id === id);
        if (!src) return;
        const dur = Math.max(0.4, src.endTime - src.startTime);
        const maxEnd = duration || src.endTime + dur;
        const start = Math.min(src.endTime + 0.2, Math.max(0, maxEnd - dur));
        const copy: DetectedMoment = stripUndefined({
          ...src,
          id: newMomentId(),
          startTime: start,
          endTime: Math.min(maxEnd, start + dur),
          label: `${src.label} copy`,
          source: "user",
          edited: true,
          // Conditional spread keeps `keyframes` off the object entirely when
          // the source has none — Firestore rejects literal `undefined`.
          ...(src.keyframes && src.keyframes.length > 0
            ? { keyframes: src.keyframes.map((k) => ({ ...k })) }
            : {}),
        });
        const next = [...moments, copy].sort((a, b) => a.startTime - b.startTime);
        await commitMoments(next);
        setSelectedMomentId(copy.id);
      },
      [commitMoments, duration, newMomentId]
    );

  /**
   * The edits a split would apply to: the multi-selection when there is one,
   * otherwise the single selected edit.
   */
  const splitTargetIds = React.useMemo(
    () =>
      multiSelectIds.length > 0
        ? multiSelectIds
        : selectedMomentId
          ? [selectedMomentId]
          : [],
    [multiSelectIds, selectedMomentId]
  );

  const splitAtPlayhead: EditorRealContextValue["splitAtPlayhead"] =
    React.useCallback(
      async (ids) => {
        // Explicit ids (a pill's own Split button) override the selection, so a
        // pill can split itself without first waiting for a selection state
        // update to land — which wouldn't have happened by the time we read it.
        const targets = ids?.length ? ids : splitTargetIds;
        if (targets.length === 0) return "Select an edit to split.";

        const current = momentsRef.current;
        const at = clock.get();
        const res = splitMomentsAt(current, targets, at, newMomentId);

        if (!res) {
          // Nothing split — say WHY. A Split button that silently does nothing
          // when the playhead is a hair outside the pill is the most confusing
          // possible outcome, so we surface the actual reason.
          const first = current.find((m) => targets.includes(m.id));
          const reason = first ? splitReason(first, at) : null;
          return reason
            ? splitBlockedMessage(reason)
            : "Move the playhead inside the edit to split it.";
        }

        await commitMoments(res.moments.map((m) => stripUndefined(m)));
        // Select the RIGHT half: the user just cut at the playhead, and the part
        // AFTER the cut is what they're about to act on (trim, delete, restyle).
        setSelectedMomentId(res.newIds[res.newIds.length - 1]);
        clearMultiSelect();
        return null;
      },
      [splitTargetIds, clock, newMomentId, commitMoments, clearMultiSelect]
    );

  const addMomentAtPlayhead: EditorRealContextValue["addMomentAtPlayhead"] =
    React.useCallback(
      async (effectType) => {
        const isCrop = effectType === "crop";
        const isSpeed = effectType === "speed-up";
        const isCut = effectType === "cut";
        const isOverlay = isOverlayEffectType(effectType);
        const span = isSpeed
          ? 2.6
          : isCrop
            ? 3
            : isCut
              ? 2
              : effectType === "transition"
                ? 0.6
                : effectType === "branding-cta"
                  ? 4
                  : effectType === "hook-text"
                    ? 2.2
                    : isOverlay
                      ? 2.4
                      : 1.8;
        const total = duration || project.duration || 0;
        const at = clock.get();
        const start = total > 0 ? Math.min(at, Math.max(0, total - span)) : at;
        // Source aspect drives the initial crop box shape — use the EFFECTIVE
        // (Frame Crop) dims so a manual crop box starts at the same aspect the
        // preview + export frame the source at.
        const rawW =
          project.width || videoRef.current?.videoWidth || 0;
        const rawH =
          project.height || videoRef.current?.videoHeight || 0;
        const sc = resolveSourceRect(rawW, rawH, project.sourceCrop);
        const sourceAspect =
          sc.sWidth > 0 && sc.sHeight > 0 ? sc.sWidth / sc.sHeight : 16 / 9;
        const focusRegion = isCrop
          ? cropBoxFor(
              DEFAULT_CROP.aspectRatio,
              DEFAULT_CROP.position,
              DEFAULT_CROP.scale,
              sourceAspect
            )
          : { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
        const rawEnd = total > 0 ? Math.min(total, start + span) : start + span;
        // A hand-placed zoom lands inside the same duration window the AI pass
        // obeys, so a manual edit and a generated one feel like the same tool.
        const window =
          effectType === "zoom" || effectType === "cursor-focus"
            ? clampZoomWindow(
                start,
                rawEnd,
                zoomPreset(project.effectsSettings?.zoomPreset),
                total > 0 ? total : Infinity
              )
            : { startTime: start, endTime: rawEnd };
        const m: DetectedMoment = {
          id: newMomentId(),
          startTime: window.startTime,
          endTime: window.endTime,
          label: DEFAULT_EFFECT_LABEL[effectType],
          reason: "Manually added.",
          focusRegion,
          effectType,
          intensity: 0.7,
          attentionScore: 0.6,
          source: "user",
          // Stamp as user-positioned so the focal-region refinement pass in
          // `fuseMomentsWithCv` doesn't later overwrite this with a derived
          // region. The user explicitly added this moment; their initial
          // centered framing is intentional until they drag the focus box.
          targetRegionSource: "user",
          edited: true,
          // Manual-effect settings (only the matching one is attached).
          ...(isCrop ? { crop: { ...DEFAULT_CROP } } : {}),
          ...(isSpeed ? { speed: { ...DEFAULT_SPEED } } : {}),
          ...(isCut ? { cut: { ...DEFAULT_CUT } } : {}),
          // Overlays default ON (non-destructively disable-able later).
          ...(isOverlay ? { enabled: true } : {}),
          // Phase-3 overlay settings (only the matching one is attached).
          ...(effectType === "captions"
            ? { captions: { text: "Caption", stylePreset: "clean" as const, position: "bottom" as const } }
            : {}),
          ...(effectType === "hook-text"
            ? { hookText: { text: "Your hook here", stylePreset: "bold" as const, position: "center" as const, animation: "pop" as const } }
            : {}),
          ...(effectType === "text-overlay"
            ? { textOverlay: { text: "Add text", position: "bottom-center" as const, size: "medium" as const, alignment: "center" as const, backgroundStyle: "pill" as const, animation: "fade" as const } }
            : {}),
          ...(effectType === "callout"
            ? { callout: { text: "Look here", style: "box" as const } }
            : {}),
          ...(effectType === "blur-redaction"
            ? { blurRedaction: { blurStrength: DEFAULT_BLUR_STRENGTH, reasonType: "manual" as const } }
            : {}),
          ...(effectType === "transition"
            ? { transition: { style: "fade" as const } }
            : {}),
          ...(effectType === "branding-cta"
            ? { brandingCta: { ctaText: "Follow for more", position: "bottom-right" as const, stylePreset: "creator" as const } }
            : {}),
          ...(effectType === "smart-crop"
            ? { smartCrop: { aspectRatio: "9:16" as const, focusTarget: "center" as const } }
            : {}),
        };
        const next = [...momentsRef.current, m].sort(
          (a, b) => a.startTime - b.startTime
        );
        await commitMoments(next);
        // Select the new moment so the docked inspector surfaces it; the modal
        // fallback (small screens) keys off inspectorOpen.
        setSelectedMomentId(m.id);
        setInspectorOpen(true);
      },
      [
        commitMoments,
        project.duration,
        project.effectsSettings,
        clock,
        duration,
        newMomentId,
      ]
    );

  const dismissSuggestion: EditorRealContextValue["dismissSuggestion"] =
    React.useCallback(
      async (id) => {
        await writeProject({
            analysis: { dismissedSuggestionIds: arrayUnion(id) },
            updatedAt: serverTimestamp(),
          });
      },
      [writeProject]
    );

  const acceptSuggestion: EditorRealContextValue["acceptSuggestion"] =
    React.useCallback(
      async (s) => {
        const moments = project.analysis?.detectedMoments ?? [];
        let nextMoments = moments;
        let focusId: string | null = null;

        if (s.insert) {
          const inserted: DetectedMoment = {
            ...s.insert,
            id: newMomentId(),
            edited: true, // survives a preset re-balance
          };
          focusId = inserted.id;
          nextMoments = [...moments, inserted].sort(
            (a, b) => a.startTime - b.startTime
          );
        } else if (s.momentId && s.patch) {
          focusId = s.momentId;
          nextMoments = moments.map((m) =>
            m.id === s.momentId
              ? ({ ...m, ...s.patch, edited: true } as DetectedMoment)
              : m
          );
        }

        // One write: apply the change AND record the dismissal together.
        await writeProject({
            analysis: {
              ...(project.analysis ?? {}),
              detectedMoments: nextMoments,
              dismissedSuggestionIds: arrayUnion(s.id),
            },
            updatedAt: serverTimestamp(),
          });
        if (focusId) setSelectedMomentId(focusId);
      },
      [project.analysis, writeProject, newMomentId]
    );

  const updateEffects: EditorRealContextValue["updateEffects"] = React.useCallback(
    async (key, value) => {
      await writeProject({
          effectsSettings: { ...project.effectsSettings, [key]: value },
          // Editing any slider/toggle drops the "applied" tie to the preset.
          selectedPresetId: null,
          updatedAt: serverTimestamp(),
        });
    },
    [project.effectsSettings, writeProject]
  );

  /**
   * "Apply edits to full timeline" — the ONLY path that lets a clip mutate the
   * project. Bakes the clip's smart edits into the real timeline (as user-owned,
   * undoable moments) and adopts its suggested output aspect. Everything else
   * about clips is render-side only. The caller MUST confirm with the user first.
   */
  const applyClipToTimeline = React.useCallback(
    async (clip: GeneratedClip) => {
      const base = project.analysis?.detectedMoments ?? [];
      await commitMoments(applyClipEditsToTimeline(base, clip));
      const nextEffects = clipEffects(
        project.effectsSettings,
        clip,
        project.width ?? 0,
        project.height ?? 0
      );
      if (nextEffects.outputCanvas !== project.effectsSettings.outputCanvas) {
        await updateEffects("outputCanvas", nextEffects.outputCanvas);
      }
    },
    [
      project.analysis?.detectedMoments,
      project.effectsSettings,
      project.width,
      project.height,
      commitMoments,
      updateEffects,
    ]
  );

  // Reset the global output canvas to "Source / full frame" by removing the
  // field — `resolveOutputCanvas` then returns null and the export/preview use
  // the source-aspect, no-crop path. `deleteField()` is the only safe way to
  // drop a single nested key under a `{merge:true}` write.
  const clearOutputCanvas: EditorRealContextValue["clearOutputCanvas"] =
    React.useCallback(async () => {
      await writeProject({
          effectsSettings: { outputCanvas: deleteField() },
          selectedPresetId: null,
          updatedAt: serverTimestamp(),
        });
    }, [writeProject]);

  // Persist a global source crop. Writes the top-level `sourceCrop` field (a
  // property of the source bytes — NOT an effects setting, so it must not touch
  // `effectsSettings` / `selectedPresetId`). When `visualAnalysis` exists and
  // the crop actually changed, remap existing moment focus regions/keyframes +
  // CV cursor/centroid coords from the OLD crop space into the new one so
  // auto-generated edits keep pointing at the same content (best-effort).
  const setSourceCrop: EditorRealContextValue["setSourceCrop"] =
    React.useCallback(
      async (rawCrop) => {
        // Clamp/repair before persisting: an out-of-range or non-finite crop is
        // reset to the full frame so a bad rect can never blank the preview or
        // export. The editor already floors crop size, but this guards every
        // writer (and any legacy/imported value).
        const crop = sanitizeSourceCrop(rawCrop) ?? FULL_FRAME_CROP;
        const oldCrop = project.sourceCrop;
        const patch: Record<string, unknown> = {
          sourceCrop: crop,
          updatedAt: serverTimestamp(),
        };
        if (
          project.visualAnalysis &&
          cropChanged(oldCrop, crop)
        ) {
          const moments = project.analysis?.detectedMoments;
          if (moments && moments.length > 0) {
            patch["analysis"] = {
              ...(project.analysis ?? {}),
              detectedMoments: moments.map((m) =>
                remapMomentForCrop(m, oldCrop, crop)
              ),
            };
          }
          patch["visualAnalysis"] = remapVisualAnalysisForCrop(
            project.visualAnalysis,
            oldCrop,
            crop
          );
        }
        await writeProject(patch);
      },
      [writeProject, project.sourceCrop, project.visualAnalysis, project.analysis]
    );

  const clearSourceCrop: EditorRealContextValue["clearSourceCrop"] =
    React.useCallback(async () => {
      // A disabled full-frame crop is equivalent to "no crop"; persist that so
      // the (now full-frame) → (old crop) remap below still has an old crop to
      // map FROM if the user re-enables. We DELETE rather than disable so the
      // doc stays clean. Remap moments back to full-frame first.
      const oldCrop = project.sourceCrop;
      const patch: Record<string, unknown> = {
        sourceCrop: deleteField(),
        updatedAt: serverTimestamp(),
      };
      if (project.visualAnalysis && cropChanged(oldCrop, undefined)) {
        const moments = project.analysis?.detectedMoments;
        if (moments && moments.length > 0) {
          patch["analysis"] = {
            ...(project.analysis ?? {}),
            detectedMoments: moments.map((m) =>
              remapMomentForCrop(m, oldCrop, undefined)
            ),
          };
        }
        patch["visualAnalysis"] = remapVisualAnalysisForCrop(
          project.visualAnalysis,
          oldCrop,
          undefined
        );
      }
      await writeProject(patch);
    }, [writeProject, project.sourceCrop, project.visualAnalysis, project.analysis]);

  // Flip the browser-tab sharing-bar removal — a convenience for the
  // auto-detected crop. Only acts on a `browser-bar-cleanup` crop so it can't
  // stomp a manual Frame Crop. No-op when nothing was detected.
  const setRemoveSharingBar: EditorRealContextValue["setRemoveSharingBar"] =
    React.useCallback(
      async (remove) => {
        const existing = project.sourceCrop;
        if (!existing || existing.reason !== "browser-bar-cleanup") return;
        await setSourceCrop({ ...existing, enabled: remove });
      },
      [project.sourceCrop, setSourceCrop]
    );

  const applyPreset: EditorRealContextValue["applyPreset"] = React.useCallback(
    async (preset) => {
      // Defensive plan gate — the calling UI (the Presets panel's Looks tab /
      // standalone page) already hides locked presets, but this catches
      // direct programmatic calls and surface bugs. Reads the live plan from
      // Firestore so a recent webhook upgrade is honoured.
      if (preset.requiredPlan) {
        const planUid = requireCloud(`apply the ${preset.name} preset`);
        const { db } = getFirebase();
        const userSnap = await getDoc(doc(db, "users", planUid));
        const plan = normalizePlan(
          (userSnap.data() as { plan?: unknown } | undefined)?.plan
        );
        if (!planMeetsMinimum(plan, preset.requiredPlan)) {
          throw new Error(
            `${preset.name} requires the ${preset.requiredPlan} plan. Upgrade in /pricing.`
          );
        }
      }

      const nextSettings = applyPresetToSettings(project.effectsSettings, preset);

      // A preset is a STYLE layer (zoom defaults, cursor glow, callout
      // style, pacing target, export theme). It must NOT touch the AI's
      // `detectedMoments`. The previous implementation called
      // `balanceTimeline` here with the new preset's pacing — in the worst
      // case that produced a stricter selection that dropped every moment,
      // which then collapsed `hasAnalysis` in RealEditor and bounced the
      // workflow stepper back to "analyze" (= "redo your analysis"). In
      // the not-worst case it silently rewrote any non-`edited` moment,
      // throwing away tuning the user had done by dragging the timeline
      // even when no inspector-edit flag was set.
      //
      // Pacing is still captured in `effectsSettings.pacing`. A future
      // explicit "Re-balance timeline" action can consume it; that path
      // must be a deliberate user choice, not a side-effect of style apply.
      await writeProject({
          effectsSettings: nextSettings,
          selectedPresetId: preset.id,
          updatedAt: serverTimestamp(),
        });
    },
    [project.effectsSettings, writeProject, uid]
  );

  const clearSelectedPreset: EditorRealContextValue["clearSelectedPreset"] =
    React.useCallback(async () => {
      await writeProject({ selectedPresetId: null, updatedAt: serverTimestamp() });
    }, [writeProject]);

  // Persist the pre-analysis video-type choice. Optimistic local update so the
  // picker highlights instantly; the doc write makes it survive reloads + feeds
  // the analysis pipeline.
  const setSelectedVideoType: EditorRealContextValue["setSelectedVideoType"] =
    React.useCallback(
      async (t) => {
        setSelectedVideoTypeState(t);
        await writeProject({ selectedVideoType: t, updatedAt: serverTimestamp() });
      },
      [writeProject]
    );

  const startAnalyze = React.useCallback(async (rawOptions: AnalysisOptions) => {
    // AI analysis reads the source from Framevo's servers, so it needs a signed
    // in user and a cloud project. Fails with a plain explanation rather than a
    // permission error from deep inside the orchestrator.
    let analyzeUid: string;
    try {
      analyzeUid = requireCloud("run AI analysis");
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "AI analysis is unavailable.");
      return;
    }
    // Attach the user's video type so the whole pipeline (orchestrator →
    // finalize route → balancer/prompt) applies the matching edit recipe. The
    // dialog now owns the type picker and passes its choice in `rawOptions` —
    // honor that first (the context state may not have re-rendered yet), falling
    // back to the persisted project type when a caller doesn't specify one.
    const options: AnalysisOptions = {
      ...rawOptions,
      selectedVideoType: rawOptions.selectedVideoType ?? selectedVideoType,
    };
    // Free-plan duration gate — block (re)analysis of >3-min videos before any
    // state change or on-device CV work. `resolveReliableDuration` probes the
    // real <video>, so a stale/missing `project.duration` on an old project
    // can't slip past; an unknown duration (0) is never blocked here.
    const gateDuration = await resolveReliableDuration(videoRef.current, project);
    if (exceedsUploadDuration(planTier, gateDuration)) {
      setAnalyzeError(FREE_VIDEO_DURATION_LIMIT_MESSAGE);
      return;
    }
    // What survives this run (per `existingEditMode`). `project` is the
    // live-subscribed prop, so `detectedMoments` is the current timeline. The
    // selected engines re-append their fresh output on top of this set.
    const carryOver = computeCarryOver(
      project.analysis?.detectedMoments ?? [],
      options
    );
    setAnalyzeError(null);
    setAnalyzing(true);
    setProcessingMinimized(false); // fresh run → show overlay

    const abort = new AbortController();
    cvAbortRef.current = abort;

    try {
      // ── Centralized analysis-mode decision ─────────────────────────────
      // Chunked progressive analysis is the DEFAULT for every video — short or
      // long, new or old. Resolve a RELIABLE duration (chunking needs one);
      // direct is reached only on an explicit debug fallback, when no duration
      // is resolvable, or when chunked fails on-device at runtime (below).
      const resolvedDuration = await resolveReliableDuration(
        videoRef.current,
        project
      );
      const decision = selectAnalysisMode(project, videoRef.current);
      const wantChunked = decision.mode === "chunked" && resolvedDuration > 0;
      const selectedMode: AnalysisMode = wantChunked ? "chunked" : "direct";
      // Production-safe diagnostics (console.* is NOT stripped — next.config.ts
      // has no `compiler.removeConsole`). These ship to framevo.app so the
      // chosen path + the reason are always inspectable in prod devtools.
      console.info("[analysis-mode]", {
        projectId: project.id,
        duration: resolvedDuration,
        selectedMode,
        reason:
          decision.mode === "direct"
            ? decision.reason
            : resolvedDuration > 0
              ? "default"
              : "unknown-duration",
        debugForceDirect: decision.reason === "debug-fallback",
        storedDuration: project.duration ?? null,
        videoReadyState: videoRef.current?.readyState ?? null,
      });
      console.info("[analysis-options]", {
        projectId: project.id,
        generateCameraEdits: options.generateCameraEdits,
        generateCut: options.generateCut,
        generateSpeed: options.generateSpeed,
        existingEditMode: options.existingEditMode,
        chunkMode: options.chunkMode,
        chunkSizeSeconds: options.chunkSizeSeconds,
        chunkCount: options.chunkCount ?? null,
      });

      // ── Progressive chunked path — the ONLY normal path for ALL videos ──
      // CV/zoom/crop/speed engines run per 30s window (a short video is one
      // chunk), streaming onto the timeline as each chunk finishes, with the
      // Gemini finalize in the background. If chunked can't run on-device
      // (canvas taint, no readable frames, engine unsupported), we HARD FAIL
      // with the exact reason — we never silently drop to the legacy direct
      // flow (doing so is what hid the prod CORS/stale-build regression).
      if (wantChunked) {
        // Single-flight: ignore a re-trigger while a chunked run is in flight.
        if (chunkRunningRef.current) return;
        chunkRunningRef.current = true;
        // Chunked runs in the background by default so the user can edit the
        // sections that have already streamed in while later chunks process.
        setProcessingMinimized(true);
        // One write that both (a) migrates a missing/0 duration on old projects
        // so future loads route correctly, and (b) flips the overlay to
        // "Analyzing in chunks" immediately so the old "Uploading to Gemini"
        // stages never flash.
        await writeProject({
            ...(isGoodDuration(project.duration)
              ? {}
              : { duration: resolvedDuration }),
            status: "analyzing",
            analysis: { status: "analyzing", stage: "Analyzing in chunks" },
            updatedAt: serverTimestamp(),
          });
        try {
          const result = await runChunkedAnalysis({
            uid: analyzeUid,
            // Feed the resolved duration so the orchestrator never throws
            // "Unknown duration" on an old project with a missing field.
            project: { ...project, duration: resolvedDuration },
            interactions,
            idTokenGetter,
            signal: abort.signal,
            onJob: setChunkedJob,
            options,
            carryOver,
          });
          const degrade = finalizeDegradeText(result);
          if (degrade) setAnalyzeError(degrade);
          return;
        } catch (chunkErr) {
          // User cancelled mid-run — not a failure (the orchestrator wrote its
          // own `markCancelled`). Stop here, no failed state.
          if (abort.signal.aborted) return;
          // HARD FAIL — chunked is the ONLY normal path. We do NOT silently
          // drop to the legacy direct flow (that masked prod CORS/build issues).
          // Surface the exact reason loudly: console.error for prod devtools,
          // plus a terminal `failed` state persisted to Firestore (errorMessage
          // + activity) so the cause is inspectable without devtools. `name`
          // distinguishes e.g. CvTaintedError (→ prod-bucket CORS).
          const message = chunkFailureText(chunkErr, "start");
          console.error("[analysis-mode] chunked run failed", {
            projectId: project.id,
            name: chunkErr instanceof Error ? chunkErr.name : "Unknown",
            phase:
              chunkErr instanceof ChunkedAnalysisError ? chunkErr.phase : "start",
            message: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
          });
          await writeChunkFailure(writeProject, {
            errorKind: "unknown",
            errorMessage: message,
          });
          setAnalyzeError(message);
          return; // never fall through to the legacy direct path
        } finally {
          chunkRunningRef.current = false;
        }
      }

      // ── Reaching here means chunked was NOT run (wantChunked === false) ────
      // Two cases:
      //   1. decision.mode === "direct" — the explicit debug escape hatch
      //      (`?debug=direct` / localStorage `framevo:forceDirect=1`). This is
      //      the ONLY route to the legacy direct flow below.
      //   2. decision.mode === "chunked" but resolvedDuration <= 0 — chunking is
      //      impossible without a duration. Do NOT silently run direct; hard
      //      fail loudly so the (usually CORS/load-related) cause is surfaced.
      if (decision.mode !== "direct") {
        console.error("[analysis-mode] duration unresolved → hard fail", {
          projectId: project.id,
          storedDuration: project.duration ?? null,
          videoDuration: Number.isFinite(videoRef.current?.duration ?? NaN)
            ? videoRef.current?.duration
            : null,
          videoReadyState: videoRef.current?.readyState ?? null,
        });
        await writeChunkFailure(writeProject, {
          errorKind: "unknown",
          errorMessage:
            "Chunked analysis failed to start: could not resolve the video's duration.",
        });
        setAnalyzeError(
          "Chunked analysis failed to start: could not resolve the video's duration."
        );
        return;
      }

      // ── Legacy DIRECT flow (debug escape hatch only) ───────────────────
      // Only reachable via `?debug=direct` / localStorage `framevo:forceDirect`
      // (decision.mode === "direct"). Kept for debugging the old whole-video →
      // Gemini path; it is NOT part of normal production routing.
      //
      // Phase 0: client-side computer-vision pass. Runs in the browser (the
      // server route has no pixels). The result is persisted top-level so the
      // route's `analysis` reset can't clobber it, then the route reads it back
      // and fuses it in the balancer.
      const video = videoRef.current;
      const cvDuration = resolvedDuration;
      if (video && cvDuration > 0) {
        try {
          await writeProject({
              status: "scanning_frames",
              analysis: {
                status: "analyzing",
                stage: "Scanning frames",
                startedAt: Date.now(),
                activity: [
                  {
                    ts: Date.now(),
                    kind: "info",
                    text: "Scanning frames on-device (computer vision)",
                  },
                ],
                cancelRequested: false,
                errorKind: null,
                errorMessage: null,
              },
              updatedAt: serverTimestamp(),
            });
          setCvProgress(0);
          const va = await runVisualAnalysis(video, {
            duration: cvDuration,
            signal: abort.signal,
            sourceCrop: project.sourceCrop,
            onProgress: (p) => setCvProgress(p.done),
          });
          await writeProject({
              visualAnalysis: va,
              analysis: {
                activity: arrayUnion({
                  ts: Date.now(),
                  kind: "ok",
                  text: `Frame scan complete in ${(va.computeMs / 1000).toFixed(
                    1
                  )}s — ${va.sceneChanges.length} scene changes, ${
                    va.clickEvents.length
                  } interactions`,
                }),
              },
              updatedAt: serverTimestamp(),
            });
        } catch (cvErr) {
          if (cvErr instanceof CvAbortError) {
            // Cancelled mid-scan — mark cancelled and stop here.
            await writeProject({
                status: "cancelled",
                analysis: {
                  status: "cancelled",
                  stage: "Cancelled",
                  cancelRequested: false,
                },
                updatedAt: serverTimestamp(),
              });
            return;
          }
          // Tainted canvas or any other CV failure → degrade gracefully and
          // continue with a Gemini-only analysis.
          const msg =
            cvErr instanceof CvTaintedError
              ? "Frame scan skipped — video not readable on-device (CORS). Continuing with Gemini only."
              : "Frame scan skipped — CV pass failed. Continuing with Gemini only.";
          await writeProject({
              analysis: {
                activity: arrayUnion({ ts: Date.now(), kind: "warn", text: msg }),
              },
              updatedAt: serverTimestamp(),
            });
        } finally {
          setCvProgress(null);
        }
      }

      // ── Phase 1+: server analysis (Gemini + balancer fusion) ───────────
      const token = await idTokenGetter();
      if (!token) throw new Error("Not signed in.");
      const res = await apiFetch(`/api/projects/${project.id}/analyze`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        // Direct fallback: the route seeds the carry-over (instead of clearing
        // to []) and applies the same disabled-layer filter the finalize pass
        // uses, so the user's engine selection is honored here too.
        body: JSON.stringify({
          mode: "direct",
          analysisOptions: options,
          carryOver: stripUndefined(carryOver),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "Analysis failed" }));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Analysis failed.";
      setAnalyzeError(msg);
    } finally {
      cvAbortRef.current = null;
      setCvProgress(null);
      setAnalyzing(false);
    }
  }, [idTokenGetter, uid, project, writeProject, videoRef, interactions, planTier, selectedVideoType]);

  // Client → the DEDICATED captions endpoint. Captions are generated ONLY here
  // (analysis never touches them). Returns the server's structured outcome so
  // the dialog can react (exists / processing / blocked / …).
  const postCaptions = React.useCallback(
    async (body: Record<string, unknown>): Promise<CaptionActionResult> => {
      // Transcription runs server-side against the uploaded source, so a local
      // (desktop) project has nothing for it to read. Say that instead of
      // returning an opaque 404 from the route.
      if (!cloudAvailable) {
        return {
          status: "error",
          message:
            "Automatic captions run in the cloud — turn on cloud sync for this project first.",
        };
      }
      const token = await idTokenGetter();
      if (!token) return { status: "error", message: "Not signed in." };
      try {
        const res = await apiFetch(`/api/projects/${project.id}/captions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<CaptionActionResult>;
        return {
          status: (data.status as CaptionActionResult["status"]) ?? (res.ok ? "processing" : "error"),
          message: data.message ?? (res.ok ? "" : "Caption request failed."),
          captionCount: data.captionCount,
        };
      } catch (err) {
        return { status: "error", message: err instanceof Error ? err.message : "Caption request failed." };
      }
    },
    [idTokenGetter, project.id, cloudAvailable]
  );

  // "Generate AI Captions" — the ONE automatic caption entry point. Reuses an
  // existing valid transcript when possible (no charge), else reserves quota +
  // dispatches ASR server-side. Duplicate protection lives on the server.
  const generateCaptions: EditorRealContextValue["generateCaptions"] = React.useCallback(
    (opts) =>
      postCaptions({
        mode: opts.mode,
        code: opts.mode === "selected" ? opts.code : undefined,
        locale: typeof navigator !== "undefined" ? navigator.language : undefined,
        stylePreset: opts.stylePreset,
        position: opts.position,
        force: opts.force === true,
      }),
    [postCaptions]
  );

  // "Wrong language?" / change-language / retranscribe — a captions-only FORCED
  // regeneration through the SAME endpoint (never the analysis pipeline). The
  // server drops the old AI captions + reserves a fresh transcription.
  const retranscribe: EditorRealContextValue["retranscribe"] = React.useCallback(
    async (opts) => {
      await postCaptions({
        mode: opts.mode,
        code: opts.mode === "selected" ? opts.code : undefined,
        locale: typeof navigator !== "undefined" ? navigator.language : undefined,
        force: true,
      });
    },
    [postCaptions]
  );

  // Delete AI-generated captions (manual captions survive) — re-enables the
  // "Generate AI Captions" action.
  const deleteAiCaptions: EditorRealContextValue["deleteAiCaptions"] = React.useCallback(async () => {
    const cur = momentsRef.current;
    const kept = cur.filter((m) => !(m.effectType === "captions" && m.source !== "user"));
    if (kept.length !== cur.length) await commitMoments(kept);
  }, [commitMoments]);

  // ── AI Director ─────────────────────────────────────────────────────────
  // The Director is a STAGE OF ANALYSIS, not a separate run: the analyze route
  // plans → validates → applies → reviews → persists (`analysis.detectedMoments`
  // + `project.director`) in one server transaction, and the live project
  // subscription delivers the result. The only thing the client owns is the
  // BRIEF — the input the user wrote in the analysis dialog.
  //
  // The brief is a plain project field, not a Director run — write it directly.
  // Coalesced: an un-started save is safely superseded by a newer one, because
  // each write carries the WHOLE brief rather than a patch.
  const saveDirectorBrief: EditorRealContextValue["saveDirectorBrief"] =
    React.useCallback(
      async (prompt, form) => {
        const brief: DirectorBrief = {
          prompt,
          form,
          updatedAt: Date.now(),
        };
        await enqueueProjectWrite(
          project.id,
          "director-brief",
          () =>
            writeProject({
                directorBrief: stripUndefined(brief),
                updatedAt: serverTimestamp(),
              }),
          { coalesceTag: "director-brief" }
        );
      },
      [project.id, writeProject]
    );

  // ── Resume an in-flight chunked job after a refresh ─────────────────────
  // Completed chunks already wrote their moments to the project doc, so the
  // timeline shows them instantly; we just re-attach the orchestrator to drive
  // the remaining chunks + finalize. Runs once, after interactions resolve.
  const resumeAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumeAttemptedRef.current || interactionsLoading) return;
    // Nothing to resume without a cloud project — chunked analysis only ever
    // runs there.
    if (!cloudAvailable || !uid) return;
    const resumeUid = uid;
    resumeAttemptedRef.current = true;
    let cancelled = false;
    (async () => {
      const job = await getActiveJobForProject(resumeUid, project.id);
      if (cancelled || !job || analyzing || chunkRunningRef.current) return;
      chunkRunningRef.current = true;
      setAnalyzing(true);
      setProcessingMinimized(true); // resumed jobs run in the background
      const abort = new AbortController();
      cvAbortRef.current = abort;
      try {
        const result = await runChunkedAnalysis({
          uid: resumeUid,
          project,
          interactions,
          idTokenGetter,
          signal: abort.signal,
          onJob: setChunkedJob,
          resume: true,
          // Resume skips the reset (no carry-over needed) but the per-chunk
          // gating still needs the original run's engine selection. A legacy
          // in-flight job with no snapshot falls back to all-on.
          options:
            (project.analysis?.lastRunOptions as AnalysisOptions | undefined) ??
            DEFAULT_ANALYSIS_OPTIONS,
        });
        const degrade = finalizeDegradeText(result);
        if (degrade) setAnalyzeError(degrade);
      } catch (err) {
        // Aborted (unmount / user cancel) — not a failure.
        if (err instanceof CvAbortError || abort.signal.aborted) return;
        // Any other failure (incl. CvTaintedError) is a HARD FAIL — mirror the
        // fresh-run path: persist a terminal `failed` state so the project is
        // never left stuck "analyzing", and surface the exact reason. (The
        // orchestrator's own throw marks the JOB doc; this marks the PROJECT
        // doc the overlay reads — two idempotent writers, last-write-wins.)
        const message = chunkFailureText(err, "resume");
        console.error("[analysis-mode] chunked resume failed", {
          projectId: project.id,
          name: err instanceof Error ? err.name : "Unknown",
          phase: err instanceof ChunkedAnalysisError ? err.phase : "start",
          message: err instanceof Error ? err.message : String(err),
        });
        await writeChunkFailure(writeProject, {
          errorKind: "unknown",
          errorMessage: message,
        });
        setAnalyzeError(message);
      } finally {
        chunkRunningRef.current = false;
        cvAbortRef.current = null;
        setAnalyzing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once after interactions resolve; intentionally not re-firing on
    // every project snapshot (the ref guard + getActiveJobForProject gate it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, project.id, interactionsLoading]);

  // ── Stuck-completion repair (timeout guard) ─────────────────────────────
  // Safety net: if all chunks are done but the project never reached a terminal
  // state (a lost/raced finalize write, a hung pool, or cross-tab residue), and
  // the run is clearly complete (moments present + an "Analysis complete"
  // activity), force the terminal state so the overlay/pill can clear. Waits
  // 10s of stable "done" state and re-reads Firestore before repairing, so it
  // never fights a legitimate in-flight finalize.
  const repairedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const job = chunkedJob;
    if (!job) return;
    const allChunksDone = job.chunkCount > 0 && job.completedCount >= job.chunkCount;
    if (!allChunksDone) return;
    if (project.analysis?.status === "complete" || project.status === "analyzed") return;
    if (!isProcessing(project.status)) return;
    const repairKey = `${job.id}:${job.completedCount}`;
    if (repairedRef.current === repairKey) return;

    const timer = setTimeout(async () => {
      // Don't repair while the orchestrator is still actively writing — its own
      // terminal write will land. Repair is only for orphaned/stuck runs.
      if (isAnalysisActive(project.id)) return;
      const snap = await storage.get(project.id);
      const analysis = snap?.analysis;
      const statusNow = snap?.status;
      if (!analysis) return;
      if (analysis.status === "complete" || statusNow === "analyzed") return; // self-healed
      const moments = analysis.detectedMoments?.length ?? 0;
      const completeActivity = (analysis.activity ?? []).some((a) =>
        a.text?.includes("Analysis complete")
      );
      if (moments > 0 && completeActivity) {
        repairedRef.current = repairKey;
        // Route the repair through the serialized queue too.
        await enqueueProjectWrite(project.id, "repair-terminal", () =>
          writeProject({
              status: "analyzed",
              analysis: { status: "complete", stage: "Complete", cancelRequested: false },
              updatedAt: serverTimestamp(),
            })
        );
      }
    }, 10_000);
    return () => clearTimeout(timer);
  }, [
    chunkedJob,
    project.id,
    project.status,
    project.analysis?.status,
    project.analysis?.detectedMoments?.length,
    writeProject,
    storage,
  ]);

  /**
   * "Cancel" both flags the server route AND optimistically writes the
   * cancelled terminal state. The flag lets a live server shut down gracefully
   * between stages (its next `markCancelled` write is idempotent with what we
   * write here). The status write also unsticks runs whose server function
   * already terminated — e.g. after a serverless timeout or page reload — in
   * which case nothing would be polling the flag.
   *
   * The Gemini generateContent call itself can't be aborted mid-flight — but
   * once it returns, the server discards the result.
   */
  const cancelAnalyze: EditorRealContextValue["cancelAnalyze"] = React.useCallback(async () => {
    // Abort the client-side CV pass (if running).
    cvAbortRef.current?.abort();
    // Reset local processing state immediately so the overlay isn't held open
    // by stale React state if it was minimized.
    setAnalyzing(false);
    setCvProgress(null);
    setProcessingMinimized(false);
    await writeProject({
        status: "cancelled",
        analysis: {
          status: "cancelled",
          stage: "Cancelled",
          cancelRequested: true,
          completedAt: Date.now(),
        },
        updatedAt: serverTimestamp(),
      });
  }, [writeProject]);

  const [refiningFraming, setRefiningFraming] = React.useState(false);

  /**
   * Re-derive `focusRegion` for every non-user-positioned moment using the
   * project's stored interactions + visual analysis. Calls the lightweight
   * `/api/projects/[id]/reframe` route (no Gemini, no balancer selection).
   * The Firestore snapshot subscription in `RealEditorPage` will pick up
   * the patched moments and re-render.
   */
  const refineFraming: EditorRealContextValue["refineFraming"] =
    React.useCallback(async () => {
      requireCloud("refine framing");
      const token = await idTokenGetter();
      if (!token) throw new Error("Not signed in.");
      setRefiningFraming(true);
      try {
        const res = await apiFetch(`/api/projects/${project.id}/reframe`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({ error: "Reframe failed" }));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          changedCount?: number;
          totalCount?: number;
        };
        return {
          changedCount: body.changedCount ?? 0,
          totalCount: body.totalCount ?? 0,
        };
      } finally {
        setRefiningFraming(false);
      }
    }, [idTokenGetter, project.id, requireCloud]);

  // unused helpers exposed for callers that bulk-edit
  void arrayUnion;
  void arrayRemove;

  // MEMOIZED, and it must stay that way.
  //
  // This was a bare object literal, so it got a new identity on EVERY provider
  // render and re-rendered all ~30 consumers — the timeline and every pill, the
  // inspector and every control, the export panel, the preview — no matter how
  // unrelated the change was. Combined with a clock that ticked in this same
  // provider, that meant a full-editor re-render several times a second during
  // playback and on every pointermove of a drag. It is the single biggest reason
  // the editor felt unresponsive.
  //
  // Every entry below is either state that genuinely should propagate, or a
  // callback with a stable identity (see `writeProject`/`writeSnapshot`, which
  // read the live project from a ref precisely so they don't churn here).
  const value = React.useMemo<EditorRealContextValue>(
    () => ({
    project,
    uid,
    cloudAvailable,
    writeProject,
    videoRef,
    playing,
    setPlaying,
    exporting,
    setExporting,
    duration,
    setDuration,
    selectedMomentId,
    setSelectedMomentId,
    multiSelectIds,
    toggleMultiSelect,
    clearMultiSelect,
    deleteMultiSelected,
    inspectorOpen,
    openInspector,
    closeInspector,
    compareBypassId,
    setCompareBypassId,
    activeTool,
    setActiveTool,
    splitFraction,
    setSplitFraction,
    scenesOpen,
    toggleScenes,
    clips,
    clipsStoredCount,
    clipsDropped,
    clipsGenerating,
    clipsLastRun,
    generateClips,
    regenerateClip,
    renameClip,
    deleteClip,
    focusedClipId,
    focusedClip,
    openClip,
    exitClip,
    previewMoments,
    previewEffects,
    applyClipToTimeline,
    clipExport,
    requestClipExport,
    updateClipExport,
    exportModalOpen,
    openExportModal,
    closeExportModal,
    canvasOpen,
    openCanvas,
    closeCanvas,
    cropEditing,
    openCropEditor,
    closeCropEditor,
    previewMode,
    setPreviewMode,
    cvDebug,
    setCvDebug,

    updateMoment,
    deleteMoment,
    addMoment,
    setMomentEnabled,
    layers,
    setLayerVisible,
    showAllLayers,
    applyTextStyleToType,
    deleteLane,
    duplicateMoment,
    splitAtPlayhead,

    addMomentAtPlayhead,
    newMomentId,
    acceptSuggestion,
    dismissSuggestion,
    updateEffects,
    clearOutputCanvas,
    selectedVideoType,
    setSelectedVideoType,
    setSourceCrop,
    clearSourceCrop,
    setRemoveSharingBar,
    applyPreset,
    clearSelectedPreset,
    startAnalyze,
    generateCaptions,
    retranscribe,
    deleteAiCaptions,
    saveDirectorBrief,
    cancelAnalyze,
    refineFraming,
    refiningFraming,
    analyzing,
    analyzeError,
    cvProgress,
    processingMinimized,
    setProcessingMinimized,
    seek,
    togglePlay,
    seekBy,
    muted,
    volume,
    toggleMute,
    setPreviewVolume,
    bufferHoldRef,
    previewFullscreenRef,
    isFullscreen,
    toggleFullscreen,
    undo,
    redo,
    canUndo,
    canRedo,
    interactions,
    interactionsLoading,
    chunkedJob,
    }),
    [
      project, uid, cloudAvailable, writeProject, playing, exporting, duration,
      selectedMomentId, multiSelectIds, toggleMultiSelect, clearMultiSelect,
      deleteMultiSelected, inspectorOpen, openInspector, closeInspector,
      compareBypassId, activeTool, splitFraction, setSplitFraction, scenesOpen,
      toggleScenes, clips, clipsStoredCount, clipsDropped, clipsGenerating,
      clipsLastRun, generateClips, regenerateClip, renameClip, deleteClip,
      focusedClipId, focusedClip, openClip, exitClip, previewMoments,
      previewEffects, applyClipToTimeline, clipExport, requestClipExport,
      updateClipExport, exportModalOpen, openExportModal, closeExportModal,
      canvasOpen, openCanvas, closeCanvas, cropEditing, openCropEditor,
      closeCropEditor, previewMode, cvDebug, updateMoment,
      deleteMoment, addMoment, setMomentEnabled, layers, setLayerVisible,
      showAllLayers, applyTextStyleToType, deleteLane, duplicateMoment,
      splitAtPlayhead, addMomentAtPlayhead, newMomentId,
      acceptSuggestion, dismissSuggestion, updateEffects, clearOutputCanvas,
      selectedVideoType, setSelectedVideoType, setSourceCrop, clearSourceCrop,
      setRemoveSharingBar, applyPreset, clearSelectedPreset, startAnalyze,
      generateCaptions, retranscribe, deleteAiCaptions, saveDirectorBrief,
      cancelAnalyze, refineFraming, refiningFraming, analyzing, analyzeError,
      cvProgress, processingMinimized, seek, togglePlay, seekBy, muted, volume,
      toggleMute, setPreviewVolume, isFullscreen, toggleFullscreen, undo, redo,
      canUndo, canRedo, interactions, interactionsLoading, chunkedJob,
      // `videoRef`/`previewFullscreenRef` are refs and `set*` from useState are
      // identity-stable by contract, so they are deliberately not listed.
    ]
  );

  // The clock provider sits INSIDE this one: components subscribe to the
  // playhead independently of the editor value, which is what lets time tick
  // without re-rendering anything that doesn't display it.
  return (
    <Ctx.Provider value={value}>
      <PlaybackClockProvider store={clock}>{children}</PlaybackClockProvider>
    </Ctx.Provider>
  );
}

export function useEditorReal() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useEditorReal must be used inside EditorRealProvider");
  return ctx;
}

/**
 * The edit the playhead is currently inside, or null.
 *
 * A HOOK rather than a context field, and that distinction is the whole point.
 * As a field it was computed in the provider from a clock subscription, so every
 * boundary the playhead crossed rebuilt the context value and re-rendered every
 * consumer — including the entire timeline, which does not care which edit is
 * active. As a hook the subscription lives in the component that reads it, and
 * the selector returns a STRING id, so a tick that doesn't change the answer
 * (almost all of them) costs nothing at all.
 *
 * Call it as low in the tree as possible: it re-renders its caller on every
 * boundary crossing, so a large component should push it into the small child
 * that draws the result (see `ActiveMomentOverlays` in RealVideoPlayer).
 */
export function useActiveMoment(): DetectedMoment | null {
  const { project, selectedMomentId } = useEditorReal();
  const moments = project.analysis?.detectedMoments ?? EMPTY_MOMENTS;
  const activeId = useClockSelector((t) =>
    activeMomentIdAt(moments, selectedMomentId, t)
  );
  return React.useMemo(
    () => moments.find((m) => m.id === activeId) ?? null,
    [moments, activeId]
  );
}

/**
 * Whether the current selection can actually be split where the playhead is.
 *
 * Same reasoning as `useActiveMoment`: a BOOLEAN selector, so the caller
 * re-renders only when the answer flips — and with nothing selected the answer
 * is a constant `false`, so playback costs zero renders here.
 */
export function useCanSplitSelection(): boolean {
  const { project, selectedMomentId, multiSelectIds } = useEditorReal();
  const moments = project.analysis?.detectedMoments ?? EMPTY_MOMENTS;
  const targetIds = React.useMemo(
    () =>
      multiSelectIds.length > 0
        ? multiSelectIds
        : selectedMomentId
          ? [selectedMomentId]
          : [],
    [multiSelectIds, selectedMomentId]
  );
  return useClockSelector((t) => canSplitAt(moments, targetIds, t));
}

export function emptyAnalysis(): Analysis {
  return {
    status: "idle",
    detectedMoments: [],
    boringSections: [],
  };
}
