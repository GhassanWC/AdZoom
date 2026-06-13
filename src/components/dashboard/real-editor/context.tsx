"use client";

import * as React from "react";
import {
  arrayRemove,
  arrayUnion,
  deleteField,
  doc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type { DocumentReference } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import type {
  AiSuggestion,
  Analysis,
  AnalysisErrorKind,
  DetectedMoment,
  EffectsSettings,
  EffectType,
  Preset,
  ProjectDoc,
} from "@/lib/firebase/schema";
import { applyPresetToSettings } from "@/lib/presets";
import { useInteractions } from "./useInteractions";
import type { Interaction } from "@/lib/recording/types";
import { getDoc } from "firebase/firestore";
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
import { runChunkedAnalysis } from "@/lib/analysis/chunk-orchestrator";
import {
  type AnalysisOptions,
  computeCarryOver,
  DEFAULT_ANALYSIS_OPTIONS,
} from "@/lib/analysis/engine-layers";
import { getActiveJobForProject } from "@/lib/firebase/analysis-jobs";
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
import type { AnalysisJob } from "@/lib/firebase/schema";
import { useNotifications } from "@/lib/notifications/store";

interface EditorRealContextValue {
  project: ProjectDoc;
  uid: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  setCurrentTime: (t: number) => void;
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
  /** Global "Canvas / Format" panel — opens from the header or the export summary. */
  canvasOpen: boolean;
  openCanvas: () => void;
  closeCanvas: () => void;
  previewMode: boolean;
  setPreviewMode: (v: boolean) => void;
  /** Developer overlay: CV signal curves, scene markers, centroid path. */
  cvDebug: boolean;
  setCvDebug: (v: boolean) => void;
  activeMoment: DetectedMoment | null;
  updateMoment: (id: string, patch: Partial<DetectedMoment>) => Promise<void>;
  deleteMoment: (id: string) => Promise<void>;
  addMoment: (m: DetectedMoment) => Promise<void>;
  /** Duplicate a moment just after itself, as a fresh user-owned edit. */
  duplicateMoment: (id: string) => Promise<void>;
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
  applyPreset: (preset: Preset) => Promise<void>;
  clearSelectedPreset: () => Promise<void>;
  startAnalyze: (options: AnalysisOptions) => Promise<void>;
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
 * Write a terminal "failed" state for a chunked run. Mirrors the analyze
 * route's `bail()` shape so the overlay's existing `status: "failed"` handling
 * renders `errorMessage` verbatim — no schema change needed. This is used
 * INSTEAD of silently dropping to the legacy direct path: a chunked failure
 * must be loud + attributed in production, persisted where it's inspectable
 * (Firestore `analysis.errorMessage` + `activity[]`) without devtools.
 */
async function writeChunkFailure(
  projectRef: DocumentReference,
  { errorKind, errorMessage }: { errorKind: AnalysisErrorKind; errorMessage: string }
): Promise<void> {
  await setDoc(
    projectRef,
    {
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
    },
    { merge: true }
  ).catch(() => {});
}

export function EditorRealProvider({
  uid,
  project,
  idTokenGetter,
  children,
}: {
  uid: string;
  project: ProjectDoc;
  idTokenGetter: () => Promise<string | null>;
  children: React.ReactNode;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const { tier: planTier } = usePlanTier();
  const [currentTime, setCurrentTime] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [duration, setDuration] = React.useState(project.duration ?? 0);
  const [selectedMomentId, setSelectedMomentId] = React.useState<string | null>(null);
  const [multiSelectIds, setMultiSelectIds] = React.useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const openInspector = React.useCallback(() => setInspectorOpen(true), []);
  const closeInspector = React.useCallback(() => setInspectorOpen(false), []);
  const [canvasOpen, setCanvasOpen] = React.useState(false);
  const openCanvas = React.useCallback(() => setCanvasOpen(true), []);
  const closeCanvas = React.useCallback(() => setCanvasOpen(false), []);
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

  // Compute the currently-active moment based on currentTime.
  const activeMoment = React.useMemo<DetectedMoment | null>(() => {
    const moments = project.analysis?.detectedMoments ?? [];
    // If user has explicitly selected one, prefer that.
    if (selectedMomentId) {
      const sel = moments.find((m) => m.id === selectedMomentId);
      if (sel && currentTime >= sel.startTime && currentTime <= sel.endTime) {
        return sel;
      }
    }
    // Otherwise pick the moment whose range contains currentTime.
    const within = moments.find(
      (m) => currentTime >= m.startTime && currentTime <= m.endTime
    );
    return within ?? null;
  }, [project.analysis?.detectedMoments, selectedMomentId, currentTime]);

  const seek = React.useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    // Snap seeks out of active cuts (removed ranges) so the playhead can't land
    // inside removed time. Covers timeline clicks + moment click-to-seek.
    const snapped = snapOutOfActiveCut(momentsRef.current, t);
    v.currentTime = Math.max(0, Math.min(v.duration || snapped, snapped));
    setCurrentTime(v.currentTime);
  }, []);

  const projectRef = React.useMemo(() => {
    const { db } = getFirebase();
    return doc(db, "users", uid, "projects", project.id);
  }, [uid, project.id]);

  // ── Shared interactions sidecar ─────────────────────────────────────────
  // Lazy-loaded once here (instead of per-consumer) so the inspector's
  // "Follow cursor" preset and the timeline's cursor/click lane share a
  // single fetch + cache for the lifetime of the project view.
  const { interactions, loading: interactionsLoading } = useInteractions({
    interactionsPath: project.interactionsPath,
    scope: project.interactionScope,
  });

  // ── Edit history (session-only, in-memory) ──────────────────────────────
  // Every moment mutation funnels through `commitMoments`, which snapshots the
  // prior array onto an undo stack before writing. `undo`/`redo` move whole
  // `detectedMoments` arrays between the two stacks and persist via the same
  // `setDoc` path — so the camera/export contract (which only reads the array)
  // is never touched. History is in-memory: a refresh starts fresh, matching
  // editor-session expectations and keeping the Firestore doc lean.
  const HISTORY_LIMIT = 50;
  const momentsRef = React.useRef<DetectedMoment[]>(
    project.analysis?.detectedMoments ?? []
  );
  React.useEffect(() => {
    momentsRef.current = project.analysis?.detectedMoments ?? [];
  }, [project.analysis?.detectedMoments]);
  const undoStackRef = React.useRef<DetectedMoment[][]>([]);
  const redoStackRef = React.useRef<DetectedMoment[][]>([]);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  // The single funnel: persist `next`, recording the prior array for undo.
  // `stripUndefined` runs on every write (Firestore rejects literal
  // `undefined` anywhere in the doc) — centralising it here removes the
  // earlier inconsistency where only some mutators scrubbed.
  const writeMoments = React.useCallback(
    async (next: DetectedMoment[]) => {
      // Serialize through the per-project write queue so a user edit can't
      // collide with a chunk append / finalize write ("Another write batch or
      // compaction is already active").
      await enqueueProjectWrite(project.id, "user-moments-write", () =>
        setDoc(
          projectRef,
          {
            analysis: stripUndefined({
              ...(project.analysis ?? {}),
              detectedMoments: next,
            }),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        )
      );
    },
    [project.analysis, project.id, projectRef]
  );

  const commitMoments = React.useCallback(
    async (next: DetectedMoment[]) => {
      undoStackRef.current.push(momentsRef.current);
      if (undoStackRef.current.length > HISTORY_LIMIT) {
        undoStackRef.current.shift();
      }
      redoStackRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
      // Optimistic ref update so two rapid edits chain off each other's
      // result instead of both reading the same (now stale) snapshot.
      momentsRef.current = next;
      await writeMoments(next);
    },
    [writeMoments]
  );

  const undo = React.useCallback(async () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(momentsRef.current);
    momentsRef.current = prev;
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
    await writeMoments(prev);
  }, [writeMoments]);

  const redo = React.useCallback(async () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(momentsRef.current);
    momentsRef.current = next;
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
    await writeMoments(next);
  }, [writeMoments]);

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
      await commitMoments(next);
    },
    [commitMoments]
  );

  const deleteMoment: EditorRealContextValue["deleteMoment"] = React.useCallback(
    async (id) => {
      const next = momentsRef.current.filter((m) => m.id !== id);
      await commitMoments(next);
      if (selectedMomentId === id) setSelectedMomentId(null);
      setMultiSelectIds((ids) => ids.filter((x) => x !== id));
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

  const addMomentAtPlayhead: EditorRealContextValue["addMomentAtPlayhead"] =
    React.useCallback(
      async (effectType) => {
        const isCrop = effectType === "crop";
        const isSpeed = effectType === "speed-up";
        const isCut = effectType === "cut";
        const span = isSpeed ? 2.6 : isCrop ? 3 : isCut ? 2 : 1.8;
        const total = duration || project.duration || 0;
        const start = total > 0 ? Math.min(currentTime, Math.max(0, total - span)) : currentTime;
        // Source aspect drives the initial crop box shape.
        const sourceAspect =
          project.width && project.height
            ? project.width / project.height
            : videoRef.current?.videoWidth && videoRef.current?.videoHeight
              ? videoRef.current.videoWidth / videoRef.current.videoHeight
              : 16 / 9;
        const focusRegion = isCrop
          ? cropBoxFor(
              DEFAULT_CROP.aspectRatio,
              DEFAULT_CROP.position,
              DEFAULT_CROP.scale,
              sourceAspect
            )
          : { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
        const m: DetectedMoment = {
          id: newMomentId(),
          startTime: start,
          endTime: total > 0 ? Math.min(total, start + span) : start + span,
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
      [commitMoments, project.duration, currentTime, duration, newMomentId]
    );

  const dismissSuggestion: EditorRealContextValue["dismissSuggestion"] =
    React.useCallback(
      async (id) => {
        await setDoc(
          projectRef,
          {
            analysis: { dismissedSuggestionIds: arrayUnion(id) },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      },
      [projectRef]
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
        await setDoc(
          projectRef,
          {
            analysis: {
              ...(project.analysis ?? {}),
              detectedMoments: nextMoments,
              dismissedSuggestionIds: arrayUnion(s.id),
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        if (focusId) setSelectedMomentId(focusId);
      },
      [project.analysis, projectRef, newMomentId]
    );

  const updateEffects: EditorRealContextValue["updateEffects"] = React.useCallback(
    async (key, value) => {
      await setDoc(
        projectRef,
        {
          effectsSettings: { ...project.effectsSettings, [key]: value },
          // Editing any slider/toggle drops the "applied" tie to the preset.
          selectedPresetId: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [project.effectsSettings, projectRef]
  );

  // Reset the global output canvas to "Source / full frame" by removing the
  // field — `resolveOutputCanvas` then returns null and the export/preview use
  // the source-aspect, no-crop path. `deleteField()` is the only safe way to
  // drop a single nested key under a `{merge:true}` write.
  const clearOutputCanvas: EditorRealContextValue["clearOutputCanvas"] =
    React.useCallback(async () => {
      await setDoc(
        projectRef,
        {
          effectsSettings: { outputCanvas: deleteField() },
          selectedPresetId: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }, [projectRef]);

  const applyPreset: EditorRealContextValue["applyPreset"] = React.useCallback(
    async (preset) => {
      // Defensive plan gate — the calling UI (PresetsRail / RecommendedPresets
      // / standalone page) already hides locked presets, but this catches
      // direct programmatic calls and surface bugs. Reads the live plan from
      // Firestore so a recent webhook upgrade is honoured.
      if (preset.requiredPlan) {
        const { db } = getFirebase();
        const userSnap = await getDoc(doc(db, "users", uid));
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
      await setDoc(
        projectRef,
        {
          effectsSettings: nextSettings,
          selectedPresetId: preset.id,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [project.effectsSettings, projectRef, uid]
  );

  const clearSelectedPreset: EditorRealContextValue["clearSelectedPreset"] =
    React.useCallback(async () => {
      await setDoc(
        projectRef,
        { selectedPresetId: null, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }, [projectRef]);

  const startAnalyze = React.useCallback(async (options: AnalysisOptions) => {
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
        await setDoc(
          projectRef,
          {
            ...(isGoodDuration(project.duration)
              ? {}
              : { duration: resolvedDuration }),
            status: "analyzing",
            analysis: { status: "analyzing", stage: "Analyzing in chunks" },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        try {
          await runChunkedAnalysis({
            uid,
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
          const reason =
            chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
          console.error("[analysis-mode] chunked failed to start", {
            projectId: project.id,
            name: chunkErr instanceof Error ? chunkErr.name : "Unknown",
            message: reason,
          });
          await writeChunkFailure(projectRef, {
            errorKind: "unknown",
            errorMessage: `Chunked analysis failed to start: ${reason}`,
          });
          setAnalyzeError(`Chunked analysis failed to start: ${reason}`);
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
        await writeChunkFailure(projectRef, {
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
          await setDoc(
            projectRef,
            {
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
            },
            { merge: true }
          );
          setCvProgress(0);
          const va = await runVisualAnalysis(video, {
            duration: cvDuration,
            signal: abort.signal,
            onProgress: (p) => setCvProgress(p.done),
          });
          await setDoc(
            projectRef,
            {
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
            },
            { merge: true }
          );
        } catch (cvErr) {
          if (cvErr instanceof CvAbortError) {
            // Cancelled mid-scan — mark cancelled and stop here.
            await setDoc(
              projectRef,
              {
                status: "cancelled",
                analysis: {
                  status: "cancelled",
                  stage: "Cancelled",
                  cancelRequested: false,
                },
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );
            return;
          }
          // Tainted canvas or any other CV failure → degrade gracefully and
          // continue with a Gemini-only analysis.
          const msg =
            cvErr instanceof CvTaintedError
              ? "Frame scan skipped — video not readable on-device (CORS). Continuing with Gemini only."
              : "Frame scan skipped — CV pass failed. Continuing with Gemini only.";
          await setDoc(
            projectRef,
            {
              analysis: {
                activity: arrayUnion({ ts: Date.now(), kind: "warn", text: msg }),
              },
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } finally {
          setCvProgress(null);
        }
      }

      // ── Phase 1+: server analysis (Gemini + balancer fusion) ───────────
      const token = await idTokenGetter();
      if (!token) throw new Error("Not signed in.");
      const res = await fetch(`/api/projects/${project.id}/analyze`, {
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
  }, [idTokenGetter, uid, project, projectRef, videoRef, interactions, planTier]);

  // ── Resume an in-flight chunked job after a refresh ─────────────────────
  // Completed chunks already wrote their moments to the project doc, so the
  // timeline shows them instantly; we just re-attach the orchestrator to drive
  // the remaining chunks + finalize. Runs once, after interactions resolve.
  const resumeAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumeAttemptedRef.current || interactionsLoading) return;
    resumeAttemptedRef.current = true;
    let cancelled = false;
    (async () => {
      const job = await getActiveJobForProject(uid, project.id);
      if (cancelled || !job || analyzing || chunkRunningRef.current) return;
      chunkRunningRef.current = true;
      setAnalyzing(true);
      setProcessingMinimized(true); // resumed jobs run in the background
      const abort = new AbortController();
      cvAbortRef.current = abort;
      try {
        await runChunkedAnalysis({
          uid,
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
      } catch (err) {
        // Aborted (unmount / user cancel) — not a failure.
        if (err instanceof CvAbortError || abort.signal.aborted) return;
        // Any other failure (incl. CvTaintedError) is a HARD FAIL — mirror the
        // fresh-run path: persist a terminal `failed` state so the project is
        // never left stuck "analyzing", and surface the exact reason. (The
        // orchestrator's own throw marks the JOB doc; this marks the PROJECT
        // doc the overlay reads — two idempotent writers, last-write-wins.)
        const reason = err instanceof Error ? err.message : "Resume failed.";
        console.error("[analysis-mode] chunked failed to resume", {
          projectId: project.id,
          name: err instanceof Error ? err.name : "Unknown",
          message: reason,
        });
        await writeChunkFailure(projectRef, {
          errorKind: "unknown",
          errorMessage: `Chunked analysis failed to resume: ${reason}`,
        });
        setAnalyzeError(`Chunked analysis failed to resume: ${reason}`);
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
      const snap = await getDoc(projectRef);
      const analysis = (snap.data() as ProjectDoc | undefined)?.analysis;
      const statusNow = (snap.data() as ProjectDoc | undefined)?.status;
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
          setDoc(
            projectRef,
            {
              status: "analyzed",
              analysis: { status: "complete", stage: "Complete", cancelRequested: false },
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          )
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
    projectRef,
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
    await setDoc(
      projectRef,
      {
        status: "cancelled",
        analysis: {
          status: "cancelled",
          stage: "Cancelled",
          cancelRequested: true,
          completedAt: Date.now(),
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }, [projectRef]);

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
      const token = await idTokenGetter();
      if (!token) throw new Error("Not signed in.");
      setRefiningFraming(true);
      try {
        const res = await fetch(`/api/projects/${project.id}/reframe`, {
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
    }, [idTokenGetter, project.id]);

  // unused helpers exposed for callers that bulk-edit
  void arrayUnion;
  void arrayRemove;

  const value: EditorRealContextValue = {
    project,
    uid,
    videoRef,
    currentTime,
    setCurrentTime,
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
    canvasOpen,
    openCanvas,
    closeCanvas,
    previewMode,
    setPreviewMode,
    cvDebug,
    setCvDebug,
    activeMoment,
    updateMoment,
    deleteMoment,
    addMoment,
    duplicateMoment,
    addMomentAtPlayhead,
    newMomentId,
    acceptSuggestion,
    dismissSuggestion,
    updateEffects,
    clearOutputCanvas,
    applyPreset,
    clearSelectedPreset,
    startAnalyze,
    cancelAnalyze,
    refineFraming,
    refiningFraming,
    analyzing,
    analyzeError,
    cvProgress,
    processingMinimized,
    setProcessingMinimized,
    seek,
    undo,
    redo,
    canUndo,
    canRedo,
    interactions,
    interactionsLoading,
    chunkedJob,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEditorReal() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useEditorReal must be used inside EditorRealProvider");
  return ctx;
}

export function emptyAnalysis(): Analysis {
  return {
    status: "idle",
    detectedMoments: [],
    boringSections: [],
  };
}
