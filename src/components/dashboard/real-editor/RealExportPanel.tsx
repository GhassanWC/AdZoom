"use client";

import * as React from "react";
import Link from "next/link";
import {
  Download,
  AlertCircle,
  Loader2,
  Wand2,
  Film,
  ZoomIn,
  Clock,
  Lock,
  Sparkles,
  Frame,
  Pencil,
  Scissors,
  Copy,
  Check,
  ChevronDown,
  RefreshCw,
  X,
  CheckCircle2,
  FolderOpen,
  CloudDownload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import {
  useExport,
  type ExportJob,
  type ExportStatusUI,
} from "@/components/export/ExportProvider";
import { resolveOutputCanvas } from "@/lib/timeline/canvas-layout";
import { trackEditsOutcome } from "@/lib/framevo-ai/telemetry";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { visibleMoments } from "@/lib/timeline/layers";
import { clipExportMoments, clipEffects } from "@/lib/clips/clip-edits";
import {
  decideClipExport,
  stableHash,
  type ClipExportIdentity,
} from "@/lib/clips/clip-export-status";
import { projectSourceFingerprint } from "@/lib/analysis/ai-caption-status";
import type { ExportFormat, ExportUiStage, FitMode } from "@/lib/firebase/schema";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import {
  availableResolutionsForPlan,
  MAX_EXPORT_RESOLUTION,
  MAX_EXPORT_FPS,
} from "@/lib/export/plan-policy";
import { useCloudExport } from "@/components/export/useCloudExport";
import {
  useEditframeExport,
  type EditframeJob,
} from "@/components/export/EditframeExportProvider";
import {
  useDesktopExport,
  type DesktopExportJob,
} from "@/components/export/DesktopExportProvider";
import { localMediaId } from "@/lib/platform/desktop/ipc";
import { useSync } from "@/components/desktop/SyncProvider";
import { CloudTransferControl } from "@/components/dashboard/CloudTransferControl";
import type { MediaTransferSnapshot } from "@/lib/platform/types";
import { browserSupportsEditframe } from "@/lib/export/editframe/browser-support";
import {
  EXPORT_STAGE_LABEL,
  exportUiStage,
  isIndeterminateStage,
  isWaitingForSlot,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";

const fpsOptions = [30, 60] as const;

/** Friendly, user-facing copy for known export error/queue codes (UI-only). The
 *  server's raw message is the fallback for anything not mapped here. */
const EXPORT_ERROR_MESSAGES: Record<string, string> = {
  free_monthly_export_limit:
    "You've used your 2 free cloud exports this month. Upgrade to export more.",
  render_no_progress_timeout: "Export took too long to render. Please try again.",
  render_timeout: "Export took too long to render. Please try again.",
  video_decode_failed:
    "We couldn't read this video for cloud export. Try another recording or export locally.",
  active_export_limit: "You already have an export running. Please wait for it to finish.",
  export_already_running: "You already have an export running. Please wait for it to finish.",
  global_export_queue_full:
    "Your export is queued. We'll start it automatically when a render slot is free.",
  queued_due_to_capacity:
    "Your export is queued. We'll start it automatically when a render slot is free.",
};

/** Map an export error/queue code to friendly copy, falling back to `raw`. */
function friendlyExportError(code: string | undefined, raw: string | undefined): string | undefined {
  if (code && EXPORT_ERROR_MESSAGES[code]) return EXPORT_ERROR_MESSAGES[code];
  return raw;
}

/** Shown while a job is queued behind the global cap (friendlier than the raw marker). */
const QUEUED_FOR_SLOT_LABEL = "Queued — starts automatically when a slot is free";

const FIT_LABEL: Record<FitMode, string> = {
  fit: "Fit",
  fill: "Fill",
  "smart-fit": "Smart Fit",
  manual: "Manual",
};

/** Unified, engine-agnostic view of the export in flight (desktop, server VM, browser, or Editframe beta). */
type ExportView = {
  engine: "server" | "browser" | "editframe" | "desktop";
  phase: "active" | "ready" | "failed" | "canceled";
  /** Friendly stage for the stepper (Queued → Preparing → Rendering → …). */
  stage: ExportUiStage;
  stageLabel: string;
  percent: number;
  indeterminate: boolean;
  queuePosition: number | null;
  isStale: boolean;
  jobId?: string;
  errorText?: string;
  warningText?: string;
  /** Browser job (for the failure Details panel). */
  browserJob?: ExportJob;
};

const isDev = process.env.NODE_ENV === "development";

type ExportValidatable = { originalVideoUrl?: string | null };
type ValidationResult = { ok: boolean; error?: string };

/**
 * CLOUD (VM/server) export validation — deliberately INDEPENDENT of browser
 * codec limitations. We NEVER call MediaRecorder, canPlayType, AudioContext, or
 * any client audio/video decode capability here: the VM worker downloads,
 * ffprobes, normalizes, and decides what's supported. Auth, plan, monthly
 * minutes, the single-active-export rule, and resolution/fps caps are all
 * enforced server-side by /api/export/cloud (and surfaced from its response).
 * The only thing the client must confirm is that a source video exists.
 */
function validateForCloudExport(project: ExportValidatable): ValidationResult {
  if (!project.originalVideoUrl) {
    return { ok: false, error: "This project has no source video to export." };
  }
  return { ok: true };
}

export function RealExportPanel({ onClose }: { onClose?: () => void }) {
  const { project, duration, openCanvas, clipExport, updateClipExport } =
    useEditorReal();
  /** Set by "Re-export anyway" — bypasses the duplicate-render check once. */
  const [forceClipReexport, setForceClipReexport] = React.useState(false);

  // ── Clip export ────────────────────────────────────────────────────────────
  // A clip renders with ITS OWN effects (suggested aspect) — so every downstream
  // read below (canvas summary, format, resolution, render params) must go
  // through `effects`, not `project.effectsSettings`. With no clip in flight
  // this IS `project.effectsSettings` (same reference), so the full-video export
  // path is byte-for-byte unchanged.
  const effects = clipExport
    ? clipEffects(project.effectsSettings, clipExport, project.width ?? 0, project.height ?? 0)
    : project.effectsSettings;

  // Output aspect/fit lives in the global Canvas panel; export reads it via
  // `resolveOutputCanvas`. `format` is derived for the permit + a label only.
  const outputCanvas = resolveOutputCanvas(effects);
  const format: ExportFormat = !outputCanvas
    ? "Source"
    : outputCanvas.aspectRatio === "9:16"
      ? "TikTok 9:16"
      : outputCanvas.aspectRatio === "16:9"
        ? "YouTube 16:9"
        : "Custom";
  const canvasSummary = outputCanvas
    ? `${outputCanvas.aspectRatio} · ${FIT_LABEL[outputCanvas.fitMode]}`
    : "Source · full frame";

  const { plan } = useStoragePlan();
  const isPaid = planMeetsMinimum(plan.tier, "pro");

  // ── Export engines ─────────────────────────────────────────────────────────
  // The user sees ONE "Export" button. Under it: a fast in-browser render is the
  // primary path, and our server render is an automatic backup that runs only if
  // the in-browser one can't run or fails. Both produce the same MP4 with the same
  // edits — no engine choice, no "cloud" / "browser" wording is ever shown.
  const serverEnabled = process.env.NEXT_PUBLIC_CLOUD_EXPORT_ENABLED === "true";
  const canServerMp4 = serverEnabled;

  const cloud = useCloudExport(project.id);
  const { job: bJob, isExporting, cancelExport, clearJob, downloadCurrent } =
    useExport();

  // The desktop app renders LOCALLY with the machine's GPU: same recipe, same
  // compositor, no upload and no quota. When it's present it is the only engine
  // that runs — `desktop` is null in a browser, so the web paths below are
  // untouched.
  const desktop = useDesktopExport();
  const canUseDesktop = desktop !== null;

  // ── The file the local render needs ───────────────────────────────────────
  // A local render reads a file on THIS disk, found through the two-copy rule
  // (see desktop/src/main/library.ts): a project with a copy here always READS
  // as the local protocol URL, so an https URL means the copy isn't here yet.
  //
  // That is a DOWNLOAD, not a failure. A project synced from another machine
  // arrives as a timeline in a second and gigabytes never; the dialog says so
  // up front and offers the transfer, instead of refusing after the click.
  const sync = useSync();
  const localMedia = localMediaId(project.originalVideoUrl);
  const needsLocalMedia = canUseDesktop && !!project.originalVideoUrl && !localMedia;
  const mediaTransfer = sync.transferFor(project.id);
  // Read by a click handler after an await, where the rendered value is stale.
  const mediaTransferRef = React.useRef<MediaTransferSnapshot | null>(mediaTransfer);
  React.useEffect(() => {
    mediaTransferRef.current = mediaTransfer;
  }, [mediaTransfer]);
  // Pending counts as moving: the job is queued and a worker is about to claim
  // it, so asking again would only be told "already in progress".
  const mediaMoving =
    mediaTransfer?.direction === "download" &&
    (mediaTransfer.state === "active" || mediaTransfer.state === "pending");

  const editframe = useEditframeExport();
  const editframeEnabled = process.env.NEXT_PUBLIC_EDITFRAME_EXPORT_ENABLED === "true";
  const efBrowser = React.useMemo(() => browserSupportsEditframe(), []);
  // The in-browser render is usable here (Chrome/Edge); the server render is the
  // automatic backup. If neither is available, export can't run in this browser.
  const canUseEditframe = editframeEnabled && efBrowser.ok;
  const canUseCloud = canServerMp4;

  // Plan caps (server-enforced; mirrored here). 4K is disabled for ALL plans for
  // now; Free → 720p/30, Pro/Creator → up to 1080p/60. No "high quality" for Free.
  const maxResolution = MAX_EXPORT_RESOLUTION[plan.tier]; // "720p" | "1080p"
  const canExport1080 = maxResolution === "1080p";
  const canExport60 = MAX_EXPORT_FPS[plan.tier] === 60;
  const availableResolutions = availableResolutionsForPlan(plan.tier); // never 4K
  const availableFps = (canExport60 ? fpsOptions : ([30] as const)) as readonly (30 | 60)[];

  const [resolution, setResolution] = React.useState<"720p" | "1080p">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  // Export always produces MP4 — both the in-browser and server engines output it.
  const container = "mp4" as const;
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [blockedWarning, setBlockedWarning] = React.useState<string | null>(null);
  // Captions are still transcribing in the background. Warn ONCE before export
  // (rule: "Export now without captions or wait?") — an ack lets it through.
  const captionsProcessing = project.analysis?.transcript?.status === "processing";
  const [captionsPrompt, setCaptionsPrompt] = React.useState(false);
  const captionsAckRef = React.useRef(false);

  // Defensive: a downgrade mid-session (or the async plan load) snaps the
  // selection back to the plan caps — Free → 720p/30, 60fps → 30.
  React.useEffect(() => {
    if (!canExport1080 && resolution === "1080p") setResolution("720p");
  }, [canExport1080, resolution]);
  React.useEffect(() => {
    if (!canExport60 && fps === 60) setFps(30);
  }, [canExport60, fps]);

  // ── Duration + estimates ──────────────────────────────────────────────────
  const sourceDuration = duration || project.duration || 0;
  // HIDDEN LAYERS are dropped here, at the single point where the export's moment
  // list is built — every engine (browser MediaRecorder/WebCodecs, the Cloud Run
  // worker, Remotion) derives its recipe from THIS array, so one filter covers
  // them all, and the export job's recipe snapshot records exactly what rendered.
  // The project's own `detectedMoments` are untouched, so nothing is lost.
  const baseMoments = visibleMoments(
    project.analysis?.detectedMoments ?? [],
    project.timelineLayers
  );
  // Single-clip export: the clip's SMART EDITS (hook text, restyled captions,
  // emphasis zoom, CTA) are materialized into real moments, then two synthetic
  // cuts carve the timeline down to exactly [start,end]. Every render engine
  // honors cuts via buildTimelineMap, so the clip exports as its own short video
  // — with its edits baked in — without duplicating the source. With no clip in
  // flight this is exactly the project's moments (full edited video, unchanged).
  const moments = clipExport
    ? clipExportMoments(baseMoments, clipExport, sourceDuration)
    : baseMoments;
  const zoomCount = moments.filter((m) => m.effectType === "zoom").length;
  const cutMap = buildTimelineMap(moments, sourceDuration);

  // ── Clip export identity + duplicate check ────────────────────────────────
  // Identity = (clip id) + (source fingerprint) + (settings hash over the EXACT
  // moments/effects/format we're about to render). If a completed render already
  // matches, we offer its download instead of burning another job — unless the
  // user explicitly clicks "Re-export anyway".
  const clipIdentity: ClipExportIdentity | null = clipExport
    ? {
        sourceFingerprint: projectSourceFingerprint(project),
        settingsHash: stableHash({
          resolution,
          fps,
          format,
          container,
          moments,
          effects,
          sourceCrop: project.sourceCrop ?? null,
          // Free renders carry the watermark, so the plan is part of the clip's
          // identity — otherwise upgrading to Pro would offer the previously
          // exported WATERMARKED file instead of rendering a clean one.
          watermarked: plan.tier === "free",
        }),
      }
    : null;
  // `liveActive` (an export is genuinely running right now) beats the persisted
  // status, so a stale "rendering" — left behind when the dialog was closed
  // mid-render — can never permanently block a clip from being exported again.
  const clipDecision =
    clipExport && clipIdentity
      ? decideClipExport(clipExport, clipIdentity, {
          force: forceClipReexport,
          liveActive: cloud.hasActiveExport || isExporting,
        })
      : null;
  const exportDuration = cutMap.outputDuration;
  const estRenderSeconds = exportDuration > 0 ? Math.ceil(exportDuration + 8) : 0;
  const presetName = project.selectedPresetId
    ? BUILTIN_PRESETS_BY_ID[project.selectedPresetId]?.name ?? "Custom preset"
    : "No preset";

  // ── Unified in-flight view (whichever engine is running / just finished) ──
  const myBrowserJob = bJob && bJob.projectId === project.id ? bJob : null;
  const myEditframeJob =
    editframe.job && editframe.job.projectId === project.id ? editframe.job : null;
  const sView = serverView(cloud);
  const bView = myBrowserJob ? browserView(myBrowserJob) : null;
  const efView = myEditframeJob ? editframeView(myEditframeJob) : null;
  const myDesktopJob =
    desktop?.job && desktop.job.projectId === project.id ? desktop.job : null;
  const dView = myDesktopJob ? desktopView(myDesktopJob) : null;

  // The primary flow only uses the in-browser (editframe) + server (cloud)
  // engines. A legacy MediaRecorder/WebM browser job may still exist from a prior
  // session — only surface it while it's genuinely ACTIVE, never as a stale
  // terminal error that could leak into the current export's UI.
  const browserViewForUi = bView && bView.phase === "active" ? bView : null;

  // Prefer an ACTIVE export. Otherwise surface a FRESH result: a server job we
  // STARTED/watched this session, or this session's browser job. An OLD completed
  // server export is NOT a result here — it's offered as a manual "previous
  // export" in the settings view, never an auto-downloading "Export ready".
  const activeView =
    dView?.phase === "active"
      ? dView
      : sView?.phase === "active"
        ? sView
        : efView?.phase === "active"
          ? efView
          : browserViewForUi?.phase === "active"
            ? browserViewForUi
            : null;
  const serverResult =
    sView && sView.phase !== "active" && cloud.isSessionResult ? sView : null;
  // A FAILED in-browser render is never surfaced when a server backup is available
  // — the backup starts automatically (see the fallback effect) and replaces it,
  // so the user never sees a transient "Export failed" before the retry. Other
  // in-browser results (ready / canceled) surface normally.
  const efResult = efView && !(efView.phase === "failed" && canUseCloud) ? efView : null;
  // Editframe's job is always this session's (provider state) — surface its
  // terminal result ahead of a stale browser job.
  // The local render owns the result whenever it ran — it is the only engine
  // active in the desktop app, and its file is already on the user's disk.
  const resultView = dView ?? serverResult ?? efResult ?? browserViewForUi ?? null;
  const view: ExportView | null = activeView ?? resultView;
  const showStatus = !!view;
  const exportingNow = view?.phase === "active";

  // ── Clip export status sync ───────────────────────────────────────────────
  // Fold the unified export view (either engine) into THIS clip's status, so the
  // clip card tracks its own render — completely separate from the project's
  // full-video export state. Only runs while a clip export is in flight.
  const clipId = clipExport?.id ?? null;
  const clipDownloadUrl =
    view?.engine === "server" ? cloud.job?.downloadUrl ?? undefined : undefined;
  React.useEffect(() => {
    if (!clipId || !view) return;
    if (view.phase === "active") {
      void updateClipExport(clipId, { status: "rendering", jobId: view.jobId });
    } else if (view.phase === "ready") {
      void updateClipExport(clipId, {
        status: "completed",
        jobId: view.jobId,
        url: clipDownloadUrl,
      });
    } else if (view.phase === "failed") {
      void updateClipExport(clipId, {
        status: "failed",
        jobId: view.jobId,
        error: view.errorText,
      });
    } else if (view.phase === "canceled") {
      void updateClipExport(clipId, { status: "idle" });
    }
  }, [clipId, view?.phase, view?.jobId, view?.errorText, clipDownloadUrl, updateClipExport, view]);

  // ONE active export per user: any active server job, the browser single-flight,
  // OR an in-flight Editframe beta render.
  const blockedByActive =
    cloud.hasActiveExport || isExporting || editframe.isExporting || !!desktop?.isExporting;
  // In the settings view, a block means ANOTHER export (this project's active one
  // would be showing the status view instead).
  const anotherExporting = blockedByActive && !exportingNow;

  const serverInput = {
    projectId: project.id,
    projectTitle: project.title,
    resolution,
    fps,
    format,
    sourceWidth: project.width ?? 0,
    sourceHeight: project.height ?? 0,
    sourceDuration,
    moments,
    effects,
    sourceCrop: project.sourceCrop,
    visualAnalysis: project.visualAnalysis,
  };

  // ── Export handlers ────────────────────────────────────────────────────────
  // Edit-acceptance telemetry (Phase 2H): the export click is the moment the
  // user "ships" the timeline, so it is where the kept/modified/disabled/
  // deleted diff against the generation snapshot is recorded. Fired once per
  // analysis generation even when the editframe→cloud fallback runs both paths.
  const outcomeFiredRef = React.useRef<string | null>(null);
  const fireEditsOutcome = () => {
    const key = `${project.id}:${project.analysis?.completedAt ?? 0}`;
    if (outcomeFiredRef.current === key) return;
    outcomeFiredRef.current = key;
    trackEditsOutcome(project);
  };

  // Submit the SERVER (backup) render. Runs when the in-browser engine isn't
  // available here, and automatically as the fallback when it fails mid-render.
  const runCloudExport = () => {
    const v = validateForCloudExport(project);
    if (!v.ok) {
      setBlockedWarning(v.error!);
      return Promise.resolve<{ ok: boolean }>({ ok: false });
    }
    fireEditsOutcome();
    // Drop any stale browser job so a prior failure can't bleed into the UI.
    if (myBrowserJob) clearJob();
    return cloud.startCloudExport(serverInput).then((r) => {
      if (r.ok) {
        console.log("[export-ui:cloud-submit]", { jobId: r.jobId });
        // Stamp the clip as queued WITH the identity that produced it, so the card
        // shows progress even if the dialog is closed, and so a later identical
        // request is recognized as a duplicate.
        if (clipExport && clipIdentity) {
          void updateClipExport(clipExport.id, {
            status: "queued",
            jobId: r.jobId,
            identity: clipIdentity,
          });
        }
      } else {
        console.log("[export-ui:error]", { source: "cloud", code: r.kind ?? "start_failed" });
        const msg = friendlyExportError(r.kind, r.error);
        if (msg) setBlockedWarning(msg);
      }
      return r;
    });
  };
  // Keep the fallback effect pointed at the latest closure (fresh serverInput/clip).
  // Updated in an effect (never during render) so the fallback effect below — which
  // is defined later and therefore runs after this one — always sees the current one.
  const runCloudExportRef = React.useRef(runCloudExport);
  React.useEffect(() => {
    runCloudExportRef.current = runCloudExport;
  });

  // Start the in-browser render (the PRIMARY engine). Same resolution / fps /
  // moments / effects / range as the server render — it just renders locally and
  // touches no billing/usage/Firestore job.
  const runEditframeExport = () => {
    fireEditsOutcome();
    return editframe.startExport({
      project: {
        id: project.id,
        title: project.title,
        originalVideoUrl: project.originalVideoUrl!,
        width: project.width ?? 0,
        height: project.height ?? 0,
        effects,
        sourceCrop: project.sourceCrop,
        visualAnalysis: project.visualAnalysis,
        // Free-tier watermark, drawn by the shared composeFrame layer (no billing).
        applyWatermark: plan.tier === "free",
      },
      timeline: {
        moments,
        sourceDuration,
        resolution,
        fps,
        format,
        outputFormat: `${canvasSummary} · ${resolution} · ${fps}fps · MP4`,
      },
      plan: plan.tier,
      // When a server backup is available, stay quiet on failure — the fallback
      // runs automatically and only the final result is surfaced to the user.
      notifyOnFailure: !canUseCloud,
    });
  };

  // ── Primary "Export" action ────────────────────────────────────────────────
  // One button, one intent. Prefer the fast in-browser render; if it can't run or
  // fails, fall back to the server render automatically. No engine choice shown.
  const cloudFallbackArmedRef = React.useRef(false);
  const fallbackHandledRef = React.useRef<string | null>(null);
  /** An "Export" click that is waiting on the source video to arrive here. */
  const exportAfterDownloadRef = React.useRef(false);

  /**
   * The video is still only in the cloud. Ask for it, and REMEMBER that an
   * export is waiting on the other side — the effect below starts the render
   * the moment the file lands, so one click on "Export" means one export.
   */
  const requestSourceDownload = () => {
    if (!sync.available) {
      setBlockedWarning(
        "This project's video isn't stored on this computer, so it can't be exported locally."
      );
      return;
    }
    exportAfterDownloadRef.current = true;
    setBlockedWarning(null);
    // Already moving → nothing to ask for; the arm above is the whole job.
    if (mediaMoving) return;
    void (async () => {
      try {
        const result = await sync.downloadMedia(project.id);
        if (result.queued) return;
        // A refusal is information ("never uploaded", "not signed in", "already
        // in progress"). Only the first kind means no file is coming — and only
        // then must the arm be dropped, or the dialog would wait forever.
        const live = mediaTransferRef.current;
        const stillComing =
          live?.direction === "download" && (live.state === "active" || live.state === "pending");
        if (stillComing) return;
        exportAfterDownloadRef.current = false;
        setBlockedWarning(
          result.reason ?? "This project's video couldn't be copied to this computer."
        );
      } catch (err) {
        exportAfterDownloadRef.current = false;
        setBlockedWarning(
          err instanceof Error ? err.message : "That didn't work. Please try again."
        );
      }
    })();
  };

  /**
   * The LOCAL render (desktop app). Same moments, same effects, same resolution
   * and fps as every other engine — `serializeRecipeInput` produces exactly the
   * snapshot the cloud job stores, and the main process feeds it to the shared
   * render core. The user picks where the file goes; nothing is uploaded.
   */
  const runDesktopExport = async (): Promise<boolean> => {
    if (!desktop) return false;
    const mediaId = localMediaId(project.originalVideoUrl);
    if (!mediaId) {
      requestSourceDownload();
      return false;
    }
    fireEditsOutcome();
    return desktop.startExport({
      projectId: project.id,
      projectTitle: project.title,
      mediaId,
      sourceWidth: project.width ?? 0,
      sourceHeight: project.height ?? 0,
      sourceDuration,
      moments,
      effects,
      visualAnalysis: project.visualAnalysis,
      sourceCrop: project.sourceCrop,
      // The local render is the user's own machine and their own file; the
      // free-tier watermark rule still follows the plan, exactly as the
      // in-browser engine does.
      applyWatermark: plan.tier === "free",
      resolution,
      fps,
      format,
    });
  };

  // The download landed: main attached the file and re-broadcast the document,
  // so `originalVideoUrl` now reads as the local protocol URL. Finish the export
  // the user already asked for.
  React.useEffect(() => {
    if (!exportAfterDownloadRef.current || !localMedia) return;
    exportAfterDownloadRef.current = false;
    setBlockedWarning(null);
    void runDesktopExport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMedia]);

  // ...and the other ending: the transfer parked. DERIVED, not stored — the
  // reason belongs to the transfer, and the pending export stays armed, so the
  // "Try again" the banner already offers finishes what the user started.
  const mediaDownloadError =
    mediaTransfer?.direction === "download" && mediaTransfer.state === "failed"
      ? (mediaTransfer.lastError ?? "The download didn't finish.")
      : null;

  const startPrimary = () => {
    // Ignore extra clicks while a create/start is already in flight.
    if (cloud.starting || editframe.starting || editframe.isExporting) return;
    if (desktop?.starting || desktop?.isExporting) return;
    // Captions still transcribing → confirm once. Export NEVER creates captions;
    // it only renders caption ops that already exist, so exporting now simply
    // ships without them (they can be re-exported once transcription finishes).
    if (captionsProcessing && !captionsAckRef.current) {
      setCaptionsPrompt(true);
      return;
    }
    setBlockedWarning(null);
    cloud.clearError();

    // A clip that's already rendering (or already rendered with these exact
    // settings) must not spawn a second job — the banner offers Download / Re-export.
    if (clipExport && clipDecision && clipDecision.kind !== "start") {
      if (clipDecision.kind === "blocked") setBlockedWarning(clipDecision.reason);
      return;
    }
    if (!project.originalVideoUrl) {
      setBlockedWarning("This project has no source video to export.");
      return;
    }
    if (blockedByActive) {
      setBlockedWarning(cloud.alreadyRunningMessage);
      return;
    }

    if (canUseDesktop) {
      // Desktop app — render locally with the machine's GPU. There is no cloud
      // fallback to arm: a local render needs no account, no quota and no
      // network, so falling back to the server would be a downgrade.
      console.log("[export-ui:path]", { path: "desktop" });
      void runDesktopExport();
      return;
    }

    if (canUseEditframe) {
      // Primary path — render in the browser, with the server render armed as an
      // automatic backup (see the fallback effect below).
      console.log("[export-ui:path]", {
        path: "editframe",
        fallback: canUseCloud ? "cloud" : "none",
      });
      cloudFallbackArmedRef.current = canUseCloud;
      fallbackHandledRef.current = null;
      const ok = runEditframeExport();
      if (!ok) {
        cloudFallbackArmedRef.current = false;
        setBlockedWarning("An export is already running.");
      }
      return;
    }

    if (canUseCloud) {
      // No in-browser engine here → go straight to the server render.
      console.log("[export-ui:path]", { path: "cloud" });
      void runCloudExport();
      return;
    }

    setBlockedWarning("Export isn't available in this browser. Try Chrome or Edge.");
  };

  // Automatic server backup: when the in-browser render FAILS (not a user cancel),
  // start the server render once. A completed/canceled render disarms it.
  React.useEffect(() => {
    if (!cloudFallbackArmedRef.current) return;
    const j = myEditframeJob;
    if (!j) return;
    if (j.status === "failed") {
      if (fallbackHandledRef.current === j.id) return;
      fallbackHandledRef.current = j.id;
      cloudFallbackArmedRef.current = false;
      if (canUseCloud) {
        console.log("[export-ui:fallback]", { from: "editframe", to: "cloud", reason: j.error });
        editframe.clearJob(); // hide the failed in-browser job; the server render takes over
        void runCloudExportRef.current();
      }
    } else if (j.status === "completed" || j.status === "canceled") {
      cloudFallbackArmedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myEditframeJob?.status, myEditframeJob?.id, canUseCloud]);

  const exportAgain = () => {
    cloud.dismiss();
    cloud.clearError();
    clearJob();
    editframe.clearJob();
    desktop?.clearJob();
    setBlockedWarning(null);
  };

  // ── Defensive reset on dialog open ────────────────────────────────────────
  // RealExportPanel remounts each time the dialog opens (EditorSheet only renders
  // children while open). Clear stale errors + a leftover TERMINAL browser job so
  // a previous attempt's validation/codec error can't surface on a fresh open. A
  // genuinely in-flight render is preserved.
  React.useEffect(() => {
    setBlockedWarning(null);
    cloud.clearError();
    if (bJob && !isExporting && bJob.status !== "completed") clearJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-download the browser (WebM) result ONCE — parity with the server path.
  // sessionStorage-guarded so it fires once per job, not on every dialog reopen.
  const bAutoDl = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (myBrowserJob?.status !== "completed" || myBrowserJob.id === "pending") return;
    const key = myBrowserJob.id;
    if (bAutoDl.current === key) return;
    bAutoDl.current = key;
    let already = false;
    try {
      already = window.sessionStorage.getItem(`framevo.export.autodl.${key}`) === "1";
      if (!already) window.sessionStorage.setItem(`framevo.export.autodl.${key}`, "1");
    } catch {
      /* ignore */
    }
    if (!already) downloadCurrent();
  }, [myBrowserJob?.status, myBrowserJob?.id, downloadCurrent]);

  // Auto-download the Editframe (MP4) result ONCE — parity with the other engines.
  const efAutoDl = React.useRef<string | null>(null);
  const efStatus = editframe.job?.status;
  const efJobId = editframe.job?.id;
  const efBlobUrl = editframe.job?.localBlobUrl;
  const efJobProject = editframe.job?.projectId;
  const efDownload = editframe.downloadCurrent;
  React.useEffect(() => {
    if (efJobProject !== project.id) return;
    if (efStatus !== "completed" || !efBlobUrl || !efJobId) return;
    if (efAutoDl.current === efJobId) return;
    efAutoDl.current = efJobId;
    let already = false;
    try {
      already = window.sessionStorage.getItem(`framevo.editframe.autodl.${efJobId}`) === "1";
      if (!already) window.sessionStorage.setItem(`framevo.editframe.autodl.${efJobId}`, "1");
    } catch {
      /* ignore */
    }
    if (!already) efDownload();
  }, [efStatus, efJobId, efBlobUrl, efJobProject, project.id, efDownload]);

  // A transfer in flight is a busy state like any other start: the render is
  // genuinely under way, it is just moving bytes before it can move frames.
  const waitingOnSource = needsLocalMedia && mediaMoving;
  const primaryBusy =
    editframe.starting || cloud.starting || !!desktop?.starting || waitingOnSource;
  // The desktop app renders locally, so it needs neither the browser codec
  // support the in-browser engine requires nor the cloud feature flag.
  const canExportHere = canUseDesktop || canUseEditframe || canUseCloud;
  const primaryLabel = waitingOnSource
    ? "Downloading video…"
    : primaryBusy
      ? "Starting export…"
      : "Export";

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      {showStatus && view ? (
        <StatusView
          view={view}
          cloudJob={view.engine === "server" ? cloud.job : null}
          projectId={project.id}
          estTotalSeconds={estRenderSeconds}
          downloadStarted={view.engine === "server" ? cloud.downloadStarted : true}
          downloading={view.engine === "server" ? cloud.downloading : false}
          downloadError={view.engine === "server" ? cloud.downloadError : null}
          // A local export is already a file on disk — "download" becomes
          // "show me where it went".
          downloadLabel={view.engine === "desktop" ? "Show in folder" : undefined}
          onDownloadAgain={
            view.engine === "desktop"
              ? () => desktop?.revealOutput()
              : view.engine === "server"
                ? cloud.downloadAgain
                : view.engine === "editframe"
                  ? editframe.downloadCurrent
                  : downloadCurrent
          }
          onCancel={
            view.engine === "desktop"
              ? () => desktop?.cancelExport()
              : view.engine === "server"
                ? () => void cloud.cancelCloudExport()
                : view.engine === "editframe"
                  ? editframe.cancelExport
                  : cancelExport
          }
          onExportAgain={exportAgain}
          onClose={onClose}
        />
      ) : (
        <>
          {/* ── Single-clip export banner ─────────────────────────────────── */}
          {clipExport && (
            <div className="flex items-start gap-2 rounded-xl border border-violet-400/30 bg-violet-500/[0.08] px-3 py-2.5 text-[12px]">
              <Scissors size={14} className="mt-0.5 shrink-0 text-violet-300" />
              <div className="min-w-0">
                <p className="font-semibold text-white">Exporting one clip</p>
                <p className="truncate text-violet-100/85">{clipExport.title}</p>
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-violet-200/70">
                  {clipTimeLabel(clipExport.startTime)}–{clipTimeLabel(clipExport.endTime)} ·{" "}
                  {clipTimeLabel(exportDuration)} output
                </p>
                {/* The clip's smart edits ride along with the render. */}
                <p className="mt-1 text-[11px] leading-relaxed text-violet-200/70">
                  Includes {clipExport.suggestedAspectRatio} framing
                  {clipExport.suggestedHookText ? ", hook text" : ""}
                  {clipExport.editOperations.some((o) => o.type === "captions")
                    ? `, ${clipExport.suggestedCaptionStyle.replace("_", " ")} captions`
                    : ""}
                  {clipExport.editOperations.some((o) => o.type === "zoom")
                    ? ", emphasis zoom"
                    : ""}
                  . Your full video is unchanged.
                </p>

                {/* Already rendered with these exact settings → don't burn a
                    second job. Offer the existing file, or an explicit re-run. */}
                {clipDecision?.kind === "reuse" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.08] px-2.5 py-2">
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-emerald-100">
                      <CheckCircle2 size={12} />
                      Already exported with these settings
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1.5">
                      <a
                        href={clipDecision.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-medium text-emerald-50 transition-colors duration-150 hover:bg-emerald-500/30"
                      >
                        <Download size={11} />
                        Download
                      </a>
                      <button
                        type="button"
                        onClick={() => setForceClipReexport(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
                      >
                        <RefreshCw size={11} />
                        Re-export anyway
                      </button>
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Previous export (manual download only — never auto) ────────── */}
          {cloud.previousExport && (
            <PreviousExportCard
              title={cloud.previousExport.projectTitle}
              downloading={cloud.downloadingPrevious}
              onDownload={cloud.downloadPrevious}
            />
          )}

          {/* ── Settings ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Quality"
              lockHref={!canExport1080 ? "/pricing" : undefined}
              lockLabel="1080p — Pro"
            >
              <Segmented
                options={availableResolutions}
                value={resolution}
                onChange={setResolution}
              />
            </Field>
            <Field label="Frame rate" lockHref={!canExport60 ? "/pricing" : undefined} lockLabel="60 — Pro">
              <Segmented
                options={availableFps}
                value={fps}
                onChange={setFps}
                renderLabel={(n) => `${n}fps`}
              />
            </Field>
          </div>

          {!isPaid && (
            <p className="-mt-1 text-[10.5px] leading-relaxed text-fog/80">
              Free exports render at 720p with a small watermark.{" "}
              <a
                href="/pricing"
                className="font-medium text-violet-300 transition-colors hover:text-violet-200"
              >
                Upgrade to Pro
              </a>{" "}
              for 1080p, 60fps, and no watermark.
            </p>
          )}

          {/* Canvas (compact) */}
          <button
            onClick={openCanvas}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-white/20"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-200">
              <Frame size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/80">
                Canvas
              </span>
              <span className="block truncate text-[12.5px] font-medium capitalize text-white">
                {canvasSummary}
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-300">
              <Pencil size={12} />
              Edit
            </span>
          </button>

          {/* Advanced (collapsed) */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02]">
            <button
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">
                Advanced
              </span>
              <ChevronDown
                size={14}
                className={cn(
                  "text-fog transition-transform duration-150",
                  advancedOpen && "rotate-180"
                )}
              />
            </button>
            {advancedOpen && (
              <div className="space-y-2 border-t border-white/[0.06] px-3.5 py-3">
                <PreFlightRow icon={<Wand2 size={11} className="text-violet-300" />} label="Preset" value={presetName} />
                <PreFlightRow
                  icon={<Film size={11} className="text-violet-300" />}
                  label="Output"
                  value={`${canvasSummary} · ${resolution} · ${fps}fps`}
                />
                <PreFlightRow
                  icon={<ZoomIn size={11} className="text-violet-300" />}
                  label="Zoom moments"
                  value={`${zoomCount} zoom${zoomCount === 1 ? "" : "s"} · ${moments.length} total`}
                />
                <PreFlightRow
                  icon={<Scissors size={11} className="text-rose-300" />}
                  label="Duration"
                  value={
                    cutMap.totalRemoved > 0
                      ? `${fmtDuration(Math.round(exportDuration))} · −${Math.round(cutMap.totalRemoved)}s from ${cutMap.activeCuts} cut${cutMap.activeCuts === 1 ? "" : "s"}`
                      : fmtDuration(Math.round(exportDuration))
                  }
                />
                <PreFlightRow
                  icon={<Sparkles size={11} className="text-violet-300" />}
                  label="Visual effects"
                  value={
                    describeExportEffects(
                      project.effectsSettings.clickHighlights === true
                    ) || "Clean — no extra effects"
                  }
                />
              </div>
            )}
          </div>

          {anotherExporting && (
            <Notice tone="amber">{cloud.alreadyRunningMessage}</Notice>
          )}

          {/* ── The video is still in the cloud ───────────────────────────────
              Stated BEFORE the click, not as the result of one: the transfer
              can take minutes, so "press Export and find out" is the wrong
              order. Pressing Export from here starts the download and the
              render follows automatically once the file is on this disk. */}
          {needsLocalMedia && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3 text-[12px]">
              <div className="flex items-start gap-2">
                <CloudDownload size={13} className="mt-0.5 shrink-0 text-violet-300" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white">
                    This project’s video is only in the cloud.
                  </p>
                  <p className="mt-0.5 leading-relaxed text-fog">
                    {sync.available
                      ? "Framevo copies it to this computer first, then renders here — nothing is uploaded and no export minutes are used."
                      : "Sign in to bring it onto this computer, then export."}
                  </p>
                  {mediaDownloadError && (
                    <p className="mt-1 leading-relaxed text-rose-200/90">
                      {mediaDownloadError}
                    </p>
                  )}
                  {sync.available && (
                    <div className="mt-2">
                      <CloudTransferControl
                        projectId={project.id}
                        cloudOnly
                        variant="bar"
                        onNotice={(message) => setBlockedWarning(message)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {blockedWarning && <Notice tone="rose">{blockedWarning}</Notice>}

          {/* Captions still transcribing — confirm before exporting without them. */}
          {captionsPrompt && (
            <div className="rounded-xl border border-amber-300/35 bg-amber-400/[0.07] px-3.5 py-3 text-[12.5px] text-amber-100">
              <p className="font-medium text-white">Captions are still processing.</p>
              <p className="mt-0.5 leading-relaxed text-amber-100/85">
                Export now without captions, or wait for transcription to finish? You can
                re-export with captions once they appear on the timeline.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    captionsAckRef.current = true;
                    setCaptionsPrompt(false);
                    startPrimary();
                  }}
                  className="inline-flex items-center rounded-lg border border-amber-300/50 bg-amber-400/20 px-3 py-1.5 text-[12px] font-semibold text-amber-50 transition-colors hover:bg-amber-400/30"
                >
                  Export without captions
                </button>
                <button
                  type="button"
                  onClick={() => setCaptionsPrompt(false)}
                  className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[12px] font-medium text-fog transition-colors hover:border-white/25 hover:text-white"
                >
                  Wait for captions
                </button>
              </div>
            </div>
          )}

          {/* Expectation-setting — the export renders in the background. */}
          <p className="text-[11px] leading-relaxed text-fog/80">
            Your export renders in the background — keep editing while it finishes.
            {canUseEditframe && canUseCloud
              ? " If it can’t render in this browser, we’ll finish it on our servers automatically."
              : ""}
          </p>

          {/* ── Bottom action area ────────────────────────────────────────── */}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <div className="min-w-0 text-[11px] leading-tight text-fog">
              {estRenderSeconds > 0 && (
                <div className="inline-flex items-center gap-1.5">
                  <Clock size={11} className="text-violet-300" />
                  ~{fmtDuration(estRenderSeconds)} to export
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button onClick={() => onClose?.()} variant="ghost" size="lg">
                Cancel
              </Button>
              <Button
                onClick={startPrimary}
                variant="primary"
                size="lg"
                leftIcon={
                  primaryBusy ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Download size={15} />
                  )
                }
                disabled={blockedByActive || primaryBusy || !canExportHere}
              >
                {primaryLabel}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Status view (active / ready / failed / canceled) ───────────────────────
function StatusView({
  view,
  cloudJob,
  projectId,
  estTotalSeconds,
  downloadStarted,
  downloading,
  downloadError,
  downloadLabel,
  onDownloadAgain,
  onCancel,
  onExportAgain,
  onClose,
}: {
  view: ExportView;
  cloudJob?: ExportJobView | null;
  projectId: string;
  estTotalSeconds: number;
  downloadStarted: boolean;
  downloading: boolean;
  downloadError?: string | null;
  /** Overrides the primary action's label (the desktop reveals, not downloads). */
  downloadLabel?: string;
  onDownloadAgain: () => void;
  onCancel: () => void;
  onExportAgain: () => void;
  onClose?: () => void;
}) {
  // Rough remaining estimate: scale the total estimate by how much is left. For
  // an indeterminate stage (queued/preparing) we don't have a % yet, so show the
  // full estimate.
  const remainingSeconds =
    estTotalSeconds > 0
      ? view.indeterminate
        ? estTotalSeconds
        : Math.max(0, Math.round(estTotalSeconds * (1 - view.percent / 100)))
      : 0;

  return (
    <div className="space-y-4">
      {view.phase === "active" && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
          <StageSteps current={view.stage} />
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="inline-flex items-center gap-2 font-medium text-white/90">
              <Loader2 size={13} className="animate-spin text-violet-300" />
              {view.stageLabel}
            </span>
            {!view.indeterminate && (
              <span className="font-mono text-fog">{view.percent}%</span>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            {view.indeterminate ? (
              <div className="animate-indeterminate h-full w-2/5 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" />
            ) : (
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-300"
                style={{ width: `${Math.max(2, view.percent)}%` }}
              />
            )}
          </div>
          {(view.queuePosition != null || (remainingSeconds > 0 && !view.isStale)) && (
            <div className="flex items-center justify-between text-[11px] text-fog">
              <span>
                {view.queuePosition != null ? `Position in queue: ${view.queuePosition}` : ""}
              </span>
              {remainingSeconds > 0 && !view.isStale && (
                <span className="inline-flex items-center gap-1">
                  <Clock size={10} className="text-violet-300" />~{fmtDuration(remainingSeconds)} left
                </span>
              )}
            </div>
          )}
          {view.isStale ? (
            <Notice tone="rose">
              This export is taking longer than expected. You can cancel and try again.
            </Notice>
          ) : (
            <p className="text-[11px] text-fog">
              {view.engine === "server"
                ? "This is rendering on our servers — it can take a few minutes. You can close this or leave the page; it keeps going and appears under Exports when ready."
                : "Runs in the background — you can close this and keep editing."}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button onClick={onCancel} variant="ghost" size="lg" leftIcon={<X size={14} />}>
              Cancel export
            </Button>
            {!view.isStale && (
              <Button onClick={() => onClose?.()} variant="primary" size="lg">
                Continue in background
              </Button>
            )}
          </div>
          {isDev && view.jobId && (
            <p className="font-mono text-[10px] text-fog/40">job {view.jobId}</p>
          )}
        </div>
      )}

      {view.phase === "ready" && (
        <div className="space-y-3 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] px-4 py-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-emerald-100">
            <CheckCircle2 size={15} className="text-emerald-300" />
            Export ready
          </div>
          <p className="text-[11.5px] text-emerald-100/85">
            {downloadLabel
              ? "Your video was saved to the folder you chose."
              : downloadStarted
                ? "Download started. If it didn’t begin, use Download again."
                : "Your video is ready."}
          </p>
          {view.warningText && <Notice tone="amber">{view.warningText}</Notice>}
          {downloadError && <Notice tone="amber">{downloadError}</Notice>}
          <div className="flex items-center gap-2">
            <Button
              onClick={onDownloadAgain}
              variant="primary"
              size="lg"
              disabled={downloading}
              leftIcon={
                downloading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : downloadLabel ? (
                  <FolderOpen size={14} />
                ) : (
                  <Download size={14} />
                )
              }
            >
              {downloadLabel ??
                (downloading
                  ? "Starting download…"
                  : downloadStarted
                    ? "Download again"
                    : "Download MP4")}
            </Button>
            <Button onClick={onExportAgain} variant="ghost" size="lg">
              Export again
            </Button>
          </div>
          {isDev && view.jobId && (
            <p className="font-mono text-[10px] text-emerald-200/40">job {view.jobId}</p>
          )}
        </div>
      )}

      {view.phase === "failed" && (
        <div className="space-y-3 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-4">
          <div className="flex items-start gap-2 text-[12.5px] text-rose-100">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-300" />
            <span>{view.errorText || "Export failed."}</span>
          </div>
          {view.browserJob && <ExportFailureDetails job={view.browserJob} projectId={projectId} />}
          <div className="flex items-center gap-2">
            <Button onClick={onExportAgain} variant="primary" size="lg" leftIcon={<RefreshCw size={14} />}>
              Try again
            </Button>
            <Button onClick={() => onClose?.()} variant="ghost" size="lg">
              Close
            </Button>
          </div>
        </div>
      )}

      {view.phase === "canceled" && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
          <div className="text-[12.5px] text-white/85">Export canceled.</div>
          <Button onClick={onExportAgain} variant="primary" size="lg" leftIcon={<RefreshCw size={14} />}>
            Export again
          </Button>
        </div>
      )}

      {isDev && cloudJob && <ExportDiagnostics job={cloudJob} />}
    </div>
  );
}

/** Dev-only diagnostics for a cloud export — render mode, chunk progress, and the
 *  cold-start / render / merge timings the worker records. */
function ExportDiagnostics({ job }: { job: ExportJobView }) {
  // Remotion jobs render one video — show frame/fps/ETA, NOT chunk counts.
  const rows: Array<[string, string | number | undefined]> =
    job.backend === "remotion"
      ? [
          ["backend", job.backend],
          [
            "renderedFrames",
            job.totalFrames != null
              ? `${job.renderedFrames ?? 0} / ${job.totalFrames}`
              : job.renderedFrames,
          ],
          ["fpsEstimate", job.fpsEstimate],
          ["etaSeconds", job.etaSeconds],
          ["jobId", job.id],
        ]
      : [
          ["renderMode", job.renderMode],
          ["chunkCount", job.chunkCount],
          ["workerCount", job.workerCount ?? job.chunkParallelism],
          ["chunksCompleted", job.chunkCount != null ? `${job.chunksCompleted ?? 0} / ${job.chunkCount}` : undefined],
          ["chunksFailed", job.chunksFailed],
          ["coldStartSeconds", job.coldStartSeconds],
          ["chunkRenderSeconds", job.chunkRenderSeconds],
          ["mergeSeconds", job.mergeSeconds],
          ["totalSeconds", job.totalSeconds],
          ["batchJobName", job.batchJobName],
          ["workerImage", job.workerImage],
          ["machineType", job.machineType],
          ["jobId", job.id],
        ];
  const visible = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (visible.length === 0) return null;
  return (
    <details className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[10.5px] text-fog/70">
      <summary className="cursor-pointer select-none font-medium text-fog/80">Diagnostics</summary>
      <dl className="mt-2 space-y-1">
        {visible.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-36 shrink-0 text-fog/50">{k}</dt>
            <dd className="min-w-0 break-words font-mono text-fog/80">{String(v)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// ── View-model builders ────────────────────────────────────────────────────
const SERVER_ACTIVE: ReadonlyArray<string> = [
  "queued",
  "batch_submitted",
  "rendering",
  "uploading",
];

/** Stage order for the stepper. */
const STAGE_ORDER: readonly ExportUiStage[] = [
  "queued",
  "preparing",
  "rendering",
  "merging",
  "uploading",
  "ready",
];

/**
 * Map the raw 0..100 progress to a display percent that matches the stage's
 * expectations: rendering shows real progress (1–94 so it never reads 0 or
 * jumps to done), uploading parks at 95–99, ready is 100. Queued/preparing are
 * indeterminate, so their number is hidden anyway.
 */
function stageDisplayPercent(stage: ExportUiStage, rawPct: number): number {
  switch (stage) {
    case "queued":
    case "preparing":
    case "merging":
      return 0; // indeterminate — number is hidden anyway
    case "rendering":
      return Math.min(94, Math.max(1, rawPct));
    case "uploading":
      return Math.min(99, 95 + Math.round((rawPct / 100) * 4));
    case "ready":
      return 100;
  }
}

/** Remotion render label — "Rendering video", enriched with a coarse ETA once the
 *  worker has reported enough frames to estimate one. Never shows a chunk count. */
function remotionRenderLabel(j: { etaSeconds?: number; renderedFrames?: number }): string {
  const eta = j.etaSeconds;
  if (eta != null && eta > 0 && (j.renderedFrames ?? 0) > 0) {
    const etaText = eta >= 90 ? `~${Math.round(eta / 60)}m left` : `~${eta}s left`;
    return `Rendering video · ${etaText}`;
  }
  return "Rendering video";
}

function serverView(cloud: ReturnType<typeof useCloudExport>): ExportView | null {
  const j = cloud.job;
  if (!j) return null;
  const stage = exportUiStage(j);
  const phase: ExportView["phase"] = SERVER_ACTIVE.includes(j.status)
    ? "active"
    : j.status === "ready"
      ? "ready"
      : j.status === "failed"
        ? "failed"
        : "canceled";
  // Remotion renders ONE video (never sharded) and writes per-frame progress, so
  // it must NEVER show the Batch chunk count. The Batch path keeps driving label +
  // bar from chunks-done (falling back to legacy sequential, then raw progress).
  const isRemotion = j.backend === "remotion";
  const isChunked = !isRemotion && j.renderMode === "chunked";
  const chunkTot = j.chunkCount ?? j.chunkTotal ?? 0;
  const chunkDone = j.chunksCompleted ?? 0;
  const chunkedRendering = stage === "rendering" && isChunked && chunkTot > 1;
  const rawPct =
    chunkedRendering && chunkTot > 0
      ? Math.round((chunkDone / chunkTot) * 100)
      : Math.round((j.progress ?? 0) * 100);
  const stageLabel = isWaitingForSlot(j)
    ? QUEUED_FOR_SLOT_LABEL
    : isRemotion && stage === "rendering"
      ? remotionRenderLabel(j)
      : stage === "merging"
        ? "Merging chunks"
        : chunkedRendering
          ? `Rendering chunks: ${chunkDone} / ${chunkTot}`
          : (j.chunkTotal ?? 0) > 1 && (j.chunkIndex ?? 0) > 0
            ? `Rendering chunk ${j.chunkIndex}/${j.chunkTotal}` // legacy sequential
            : EXPORT_STAGE_LABEL[stage];
  return {
    engine: "server",
    phase,
    stage,
    stageLabel,
    percent: phase === "ready" ? 100 : stageDisplayPercent(stage, rawPct),
    indeterminate: isIndeterminateStage(stage),
    queuePosition: cloud.queuePosition,
    isStale: cloud.isStale,
    jobId: j.id,
    errorText:
      j.errorCode && EXPORT_ERROR_MESSAGES[j.errorCode]
        ? EXPORT_ERROR_MESSAGES[j.errorCode]
        : j.errorMessage
          ? `${j.errorMessage}${j.errorCode ? ` (${j.errorCode})` : ""}`
          : undefined,
    warningText: j.warnings && j.warnings.length ? j.warnings.join(" ") : undefined,
  };
}

const BROWSER_ACTIVE: ReadonlyArray<ExportStatusUI> = ["preparing", "rendering", "uploading"];

function browserUiStage(status: ExportStatusUI): ExportUiStage {
  switch (status) {
    case "preparing":
      return "preparing";
    case "rendering":
      return "rendering";
    case "uploading":
      return "uploading";
    default:
      return "ready"; // completed / failed / canceled
  }
}

function browserView(j: ExportJob): ExportView {
  const stage = browserUiStage(j.status);
  const phase: ExportView["phase"] = BROWSER_ACTIVE.includes(j.status)
    ? "active"
    : j.status === "completed"
      ? "ready"
      : j.status === "failed"
        ? "failed"
        : "canceled";
  const rawPct = Math.round((j.progress ?? 0) * 100);
  return {
    engine: "browser",
    phase,
    stage,
    stageLabel: EXPORT_STAGE_LABEL[stage],
    percent: phase === "ready" ? 100 : stageDisplayPercent(stage, rawPct),
    indeterminate: isIndeterminateStage(stage),
    queuePosition: null,
    isStale: false,
    jobId: j.id && j.id !== "pending" ? j.id : undefined,
    errorText: j.error,
    warningText: j.warning,
    browserJob: j,
  };
}

/** Adapt an Editframe beta job to the shared engine-agnostic view. */
/**
 * The LOCAL (desktop) render, mapped onto the same view model as every other
 * engine so the panel's stepper, progress bar, error block and cancel button
 * work unchanged. `encoding` is reported as "rendering" for the stepper — the
 * two overlap continuously in a piped render, and a separate step would show a
 * progress bar snapping backwards.
 */
function desktopView(j: DesktopExportJob): ExportView {
  const active = j.status === "preparing" || j.status === "rendering" || j.status === "encoding";
  const phase: ExportView["phase"] = active
    ? "active"
    : j.status === "completed"
      ? "ready"
      : j.status === "failed"
        ? "failed"
        : "canceled";
  const stage: ExportUiStage =
    j.status === "preparing" ? "preparing" : active ? "rendering" : "ready";
  const rawPct = Math.round((j.progress ?? 0) * 100);
  return {
    engine: "desktop",
    phase,
    stage,
    stageLabel:
      j.status === "preparing"
        ? "Preparing"
        : active
          ? `Rendering video${j.encoder && j.encoder !== "libx264" ? " (GPU)" : ""}`
          : EXPORT_STAGE_LABEL[stage],
    percent: phase === "ready" ? 100 : stageDisplayPercent(stage, rawPct),
    indeterminate: isIndeterminateStage(stage) && rawPct === 0,
    queuePosition: null,
    isStale: false,
    jobId: j.id,
    errorText: j.error,
    warningText: j.warning,
  };
}

function editframeView(j: EditframeJob): ExportView {
  const active = j.status === "preparing" || j.status === "rendering";
  const phase: ExportView["phase"] = active
    ? "active"
    : j.status === "completed"
      ? "ready"
      : j.status === "failed"
        ? "failed"
        : "canceled";
  const stage: ExportUiStage =
    j.status === "preparing" ? "preparing" : active ? "rendering" : "ready";
  const rawPct = Math.round((j.progress ?? 0) * 100);
  return {
    engine: "editframe",
    phase,
    stage,
    stageLabel:
      j.status === "preparing"
        ? "Preparing"
        : active
          ? "Rendering video"
          : EXPORT_STAGE_LABEL[stage],
    percent: phase === "ready" ? 100 : stageDisplayPercent(stage, rawPct),
    indeterminate: isIndeterminateStage(stage),
    queuePosition: null,
    isStale: false,
    jobId: j.id,
    errorText: j.error,
    warningText: j.warning,
  };
}

// ── Small building blocks ──────────────────────────────────────────────────

/** Compact labels for the progress stepper. */
const STAGE_SHORT: Record<ExportUiStage, string> = {
  queued: "Queued",
  preparing: "Preparing",
  rendering: "Rendering",
  merging: "Merging",
  uploading: "Uploading",
  ready: "Ready",
};

/** Horizontal Queued → Preparing → Rendering → Merging → Uploading → Ready stepper. */
function StageSteps({ current }: { current: ExportUiStage }) {
  const currentIdx = STAGE_ORDER.indexOf(current);
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${STAGE_ORDER.length}, minmax(0,1fr))` }}
    >
      {STAGE_ORDER.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s} className="flex flex-col items-center gap-1">
            <div
              className={cn(
                "h-1 w-full rounded-full transition-colors duration-300",
                done
                  ? "bg-violet-500"
                  : active
                    ? "bg-gradient-to-r from-violet-500 to-cyan-400"
                    : "bg-white/[0.08]"
              )}
            />
            <span
              className={cn(
                "text-[9px] font-medium leading-none transition-colors duration-300",
                done || active ? "text-violet-200" : "text-fog/60"
              )}
            >
              {STAGE_SHORT[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * "Previous export available" — a previously completed export found in storage.
 * Manual download ONLY (never auto-downloaded), so opening the dialog can't
 * spam-download old files. Distinct styling from a freshly-completed export.
 */
function PreviousExportCard({
  title,
  downloading,
  onDownload,
}: {
  title: string;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
          <CheckCircle2 size={15} />
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-white">Previous export available</div>
          <div className="truncate text-[11px] text-fog">{title || "Your last MP4"}</div>
        </div>
      </div>
      <Button
        onClick={onDownload}
        variant="glass"
        size="sm"
        disabled={downloading}
        leftIcon={
          downloading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )
        }
        className="shrink-0 whitespace-nowrap"
      >
        {downloading ? "Starting download…" : "Download previous export"}
      </Button>
    </div>
  );
}

function Field({
  label,
  lockHref,
  lockLabel,
  children,
}: {
  label: string;
  lockHref?: string;
  lockLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          {label}
        </span>
        {lockHref && (
          <Link
            href={lockHref}
            className="inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/20"
          >
            <Lock size={9} />
            {lockLabel}
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function Notice({ tone, children }: { tone: "amber" | "rose"; children: React.ReactNode }) {
  const c =
    tone === "amber"
      ? "border-amber-400/30 bg-amber-500/[0.06] text-amber-200"
      : "border-rose-400/30 bg-rose-500/[0.06] text-rose-200";
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[11.5px]", c)}>
      <AlertCircle size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Collapsible diagnostics for a failed BROWSER export. No tokens / signed URLs.
 */
function ExportFailureDetails({ job, projectId }: { job: ExportJob; projectId: string }) {
  const [copied, setCopied] = React.useState(false);
  const d = job.debug;
  const rows: Array<[string, string | undefined]> = [
    ["Stage", job.errorStage ?? d?.stage],
    ["Reason", job.error],
    ["Error", [d?.name, d?.code].filter(Boolean).join(" · ") || undefined],
    ["Project", projectId],
    ["Export ID", job.id && job.id !== "pending" ? job.id : undefined],
    ["Browser", d?.browser],
  ];
  const visible = rows.filter(([, v]) => v);
  const copy = () => {
    const text = visible.map(([k, v]) => `${k}: ${v}`).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  };
  return (
    <details className="rounded-lg border border-rose-400/20 bg-rose-500/[0.04] px-3 py-2 text-[11px] text-rose-100/90">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 text-rose-200/90">
        <span className="font-medium">Details</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            copy();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-rose-300/30 px-2 py-0.5 text-[10px] font-medium text-rose-100 transition-colors hover:bg-rose-400/10"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </summary>
      <dl className="mt-2 space-y-1">
        {visible.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-24 shrink-0 text-rose-200/60">{k}</dt>
            <dd className="min-w-0 break-words font-mono text-rose-100/90">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function describeExportEffects(clickHighlights: boolean): string {
  return clickHighlights ? "click highlights" : "";
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

/** m:ss — for clip in/out points (a position, not a duration). */
function clipTimeLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function PreFlightRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="inline-flex items-center gap-1.5 text-fog">
        {icon}
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-medium text-white/90">{value}</span>
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  renderLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  renderLabel?: (v: T) => string;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}
    >
      {options.map((opt) => (
        <button
          key={String(opt)}
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150",
            value === opt
              ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
              : "text-fog hover:bg-white/[0.04] hover:text-white"
          )}
        >
          {renderLabel ? renderLabel(opt) : String(opt)}
        </button>
      ))}
    </div>
  );
}
