"use client";

import * as React from "react";
import {
  arrayRemove,
  arrayUnion,
  doc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import type {
  AiSuggestion,
  Analysis,
  DetectedMoment,
  EffectsSettings,
  EffectType,
  Preset,
  ProjectDoc,
} from "@/lib/firebase/schema";
import { applyPresetToSettings } from "@/lib/presets";
import { getDoc } from "firebase/firestore";
import { normalizePlan, planMeetsMinimum } from "@/lib/usage/plan";
import {
  runVisualAnalysis,
  CvAbortError,
  CvTaintedError,
} from "@/lib/cv/pipeline";
import { useNotifications } from "@/lib/notifications/store";

interface EditorRealContextValue {
  project: ProjectDoc;
  uid: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  setCurrentTime: (t: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
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
  applyPreset: (preset: Preset) => Promise<void>;
  clearSelectedPreset: () => Promise<void>;
  startAnalyze: () => Promise<void>;
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
  "speed-up": "Speed ramp",
};

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
  const [currentTime, setCurrentTime] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [duration, setDuration] = React.useState(project.duration ?? 0);
  const [selectedMomentId, setSelectedMomentId] = React.useState<string | null>(null);
  const [multiSelectIds, setMultiSelectIds] = React.useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const openInspector = React.useCallback(() => setInspectorOpen(true), []);
  const closeInspector = React.useCallback(() => setInspectorOpen(false), []);
  const [previewMode, setPreviewMode] = React.useState(true);
  const [cvDebug, setCvDebug] = React.useState(false);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeError, setAnalyzeError] = React.useState<string | null>(null);
  const [processingMinimized, setProcessingMinimized] = React.useState(false);
  const [cvProgress, setCvProgress] = React.useState<number | null>(null);
  const cvAbortRef = React.useRef<AbortController | null>(null);

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
    v.currentTime = Math.max(0, Math.min(v.duration || t, t));
    setCurrentTime(v.currentTime);
  }, []);

  const projectRef = React.useMemo(() => {
    const { db } = getFirebase();
    return doc(db, "users", uid, "projects", project.id);
  }, [uid, project.id]);

  // Write helpers — all merge-safe writes that the security rules allow.
  const updateMoment: EditorRealContextValue["updateMoment"] = React.useCallback(
    async (id, patch) => {
      const moments = project.analysis?.detectedMoments ?? [];
      const next = moments.map((m) =>
        m.id === id ? ({ ...m, ...patch, edited: true } as DetectedMoment) : m
      );
      // Firestore rejects writes that carry `undefined` values anywhere in
      // the document. Two ways those slip in here:
      //   1. Callers pass `{ keyframes: undefined }` to clear a field —
      //      e.g. the directional preset chips that reset a moment back to
      //      static framing. The spread above preserves the `undefined`.
      //   2. The moment we spread was previously read from Firestore and
      //      still carries explicit-`undefined` optional fields (legacy).
      // Strip both with the same recursive helper duplicateMoment uses.
      await setDoc(
        projectRef,
        {
          analysis: stripUndefined({
            ...(project.analysis ?? {}),
            detectedMoments: next,
          }),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [project.analysis, projectRef]
  );

  const deleteMoment: EditorRealContextValue["deleteMoment"] = React.useCallback(
    async (id) => {
      const moments = project.analysis?.detectedMoments ?? [];
      const next = moments.filter((m) => m.id !== id);
      await setDoc(
        projectRef,
        {
          analysis: { ...(project.analysis ?? {}), detectedMoments: next },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      if (selectedMomentId === id) setSelectedMomentId(null);
      setMultiSelectIds((ids) => ids.filter((x) => x !== id));
    },
    [project.analysis, projectRef, selectedMomentId]
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
      const moments = project.analysis?.detectedMoments ?? [];
      const next = moments.filter((m) => !kill.has(m.id));
      await setDoc(
        projectRef,
        {
          analysis: { ...(project.analysis ?? {}), detectedMoments: next },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      if (selectedMomentId && kill.has(selectedMomentId)) setSelectedMomentId(null);
      setMultiSelectIds([]);
    }, [multiSelectIds, project.analysis, projectRef, selectedMomentId]);

  const addMoment: EditorRealContextValue["addMoment"] = React.useCallback(
    async (m) => {
      const moments = project.analysis?.detectedMoments ?? [];
      const next = [...moments, m].sort((a, b) => a.startTime - b.startTime);
      await setDoc(
        projectRef,
        {
          analysis: { ...(project.analysis ?? {}), detectedMoments: next },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [project.analysis, projectRef]
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
        const moments = project.analysis?.detectedMoments ?? [];
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
        await setDoc(
          projectRef,
          {
            analysis: stripUndefined({
              ...(project.analysis ?? {}),
              detectedMoments: next,
            }),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        setSelectedMomentId(copy.id);
      },
      [project.analysis, projectRef, duration, newMomentId]
    );

  const addMomentAtPlayhead: EditorRealContextValue["addMomentAtPlayhead"] =
    React.useCallback(
      async (effectType) => {
        const moments = project.analysis?.detectedMoments ?? [];
        const span = effectType === "speed-up" ? 2.6 : 1.8;
        const total = duration || project.duration || 0;
        const start = total > 0 ? Math.min(currentTime, Math.max(0, total - span)) : currentTime;
        const m: DetectedMoment = {
          id: newMomentId(),
          startTime: start,
          endTime: total > 0 ? Math.min(total, start + span) : start + span,
          label: DEFAULT_EFFECT_LABEL[effectType],
          reason: "Manually added.",
          focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
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
        };
        const next = [...moments, m].sort((a, b) => a.startTime - b.startTime);
        await setDoc(
          projectRef,
          {
            analysis: { ...(project.analysis ?? {}), detectedMoments: next },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        setSelectedMomentId(m.id);
        setInspectorOpen(true);
      },
      [project.analysis, project.duration, projectRef, currentTime, duration, newMomentId]
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

  const startAnalyze = React.useCallback(async () => {
    setAnalyzeError(null);
    setAnalyzing(true);
    setProcessingMinimized(false); // fresh run → show overlay

    const abort = new AbortController();
    cvAbortRef.current = abort;

    try {
      // ── Phase 0: client-side computer-vision pass ──────────────────────
      // Runs in the browser (the server route has no pixels). The result is
      // persisted top-level so the route's `analysis` reset can't clobber it,
      // then the route reads it back and fuses it in the balancer.
      const video = videoRef.current;
      const cvDuration = project.duration ?? video?.duration ?? 0;
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
        headers: { authorization: `Bearer ${token}` },
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
  }, [idTokenGetter, project.id, project.duration, projectRef, videoRef]);

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
