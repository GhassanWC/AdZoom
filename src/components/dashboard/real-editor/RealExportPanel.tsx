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
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import { pickedMimeAvailable } from "./export";
import {
  useExport,
  type ExportJob,
  type ExportRenderParams,
  type ExportStatusUI,
} from "@/components/export/ExportProvider";
import { resolveOutputCanvas } from "@/lib/timeline/canvas-layout";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import type { ExportFormat, ExportUiStage, FitMode } from "@/lib/firebase/schema";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { useCloudMinutes } from "@/lib/usage/useCloudMinutes";
import { estimateExportMinutes } from "@/lib/usage/cloud-minutes";
import { useCloudExport } from "@/components/export/useCloudExport";
import {
  EXPORT_STAGE_LABEL,
  exportUiStage,
  isIndeterminateStage,
  isWaitingForSlot,
  WAITING_FOR_SLOT_MESSAGE,
  type ExportJobView,
} from "@/lib/firebase/export-jobs";

const resolutions = ["1080p", "4K"] as const;
const fpsOptions = [30, 60] as const;

const FIT_LABEL: Record<FitMode, string> = {
  fit: "Fit",
  fill: "Fill",
  "smart-fit": "Smart Fit",
  manual: "Manual",
};

/** Unified, engine-agnostic view of the export in flight (server VM or browser). */
type ExportView = {
  engine: "server" | "browser";
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

/**
 * BROWSER export validation — MAY reject for browser codec / recorder limits.
 * This is the ONLY place a browser-support block belongs; it must never gate a
 * cloud export.
 */
function validateForBrowserExport(
  project: ExportValidatable,
  browserSupported: boolean
): ValidationResult {
  if (!project.originalVideoUrl) {
    return { ok: false, error: "This project has no source video to export." };
  }
  if (!browserSupported) {
    return {
      ok: false,
      error: "Browser export needs a Chromium browser (Chrome or Edge).",
    };
  }
  return { ok: true };
}

export function RealExportPanel({ onClose }: { onClose?: () => void }) {
  const { project, duration, updateEffects, openCanvas } = useEditorReal();

  // Output aspect/fit lives in the global Canvas panel; export reads it via
  // `resolveOutputCanvas`. `format` is derived for the permit + a label only.
  const outputCanvas = resolveOutputCanvas(project.effectsSettings);
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
  // Server (VM) MP4 export is the primary path for paid plans. The flag keeps it
  // dark until the worker is verified in an environment.
  const serverEnabled = process.env.NEXT_PUBLIC_CLOUD_EXPORT_ENABLED === "true";
  const canServerMp4 = isPaid && serverEnabled;
  const minutes = useCloudMinutes();

  const cloud = useCloudExport(project.id);
  const { job: bJob, isExporting, startExport, cancelExport, clearJob, downloadCurrent } =
    useExport();

  // 4K and 60fps are Pro+; Free is capped at 1080p/30.
  const canExport4k = planMeetsMinimum(plan.tier, "pro");
  const canExport60 = planMeetsMinimum(plan.tier, "pro");
  const availableResolutions = (
    canExport4k ? resolutions : (["1080p"] as const)
  ) as readonly ("1080p" | "4K")[];
  const availableFps = (canExport60 ? fpsOptions : ([30] as const)) as readonly (30 | 60)[];

  const [resolution, setResolution] = React.useState<"1080p" | "4K">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  // MP4 is the headline format (server VM for paid). WebM always renders in the
  // browser. The format choice transparently picks the engine — no "cloud" copy.
  const [container, setContainer] = React.useState<"mp4" | "webm">("mp4");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [blockedWarning, setBlockedWarning] = React.useState<string | null>(null);

  const engine: "server" | "browser" =
    container === "mp4" && canServerMp4 ? "server" : "browser";
  // Free picked MP4 → it's a paid feature → upgrade nudge. Paid users always get
  // MP4: server when enabled, otherwise the browser WebCodecs path as a fallback.
  const mp4NeedsUpgrade = container === "mp4" && !isPaid;

  // Defensive: a downgrade mid-session snaps 4K/60 back to the free caps.
  React.useEffect(() => {
    if (!canExport4k && resolution === "4K") setResolution("1080p");
  }, [canExport4k, resolution]);
  React.useEffect(() => {
    if (!canExport60 && fps === 60) setFps(30);
  }, [canExport60, fps]);

  const supported = pickedMimeAvailable();

  // ── Duration + estimates ──────────────────────────────────────────────────
  const moments = project.analysis?.detectedMoments ?? [];
  const zoomCount = moments.filter((m) => m.effectType === "zoom").length;
  const sourceDuration = duration || project.duration || 0;
  const cutMap = buildTimelineMap(moments, sourceDuration);
  const exportDuration = cutMap.outputDuration;
  const estMinutes = estimateExportMinutes(exportDuration);
  const estRenderSeconds = exportDuration > 0 ? Math.ceil(exportDuration + 8) : 0;
  const presetName = project.selectedPresetId
    ? BUILTIN_PRESETS_BY_ID[project.selectedPresetId]?.name ?? "Custom preset"
    : "No preset";

  // ── Unified in-flight view (whichever engine is running / just finished) ──
  const myBrowserJob = bJob && bJob.projectId === project.id ? bJob : null;
  const sView = serverView(cloud);
  const bView = myBrowserJob ? browserView(myBrowserJob) : null;

  // Keep the two engines' UIs COMPLETELY SEPARATE. A browser job only drives this
  // dialog when we're on the browser path, or when a browser render is genuinely
  // still running. A TERMINAL browser job (e.g. a prior failed attempt with a
  // browser codec/audio error) must NEVER leak into the cloud-export UI and show
  // up as the current export's error — that's the "unsupported audio format on
  // cloud export" bug.
  const browserViewForUi =
    bView && (engine === "browser" || bView.phase === "active") ? bView : null;

  // Prefer an ACTIVE export. Otherwise surface a FRESH result: a server job we
  // STARTED/watched this session, or this session's browser job. An OLD completed
  // server export is NOT a result here — it's offered as a manual "previous
  // export" in the settings view, never an auto-downloading "Export ready".
  const activeView =
    sView?.phase === "active"
      ? sView
      : browserViewForUi?.phase === "active"
        ? browserViewForUi
        : null;
  const serverResult =
    sView && sView.phase !== "active" && cloud.isSessionResult ? sView : null;
  const resultView = serverResult ?? browserViewForUi ?? null;
  const view: ExportView | null = activeView ?? resultView;
  const showStatus = !!view;
  const exportingNow = view?.phase === "active";

  // ONE active export per user: any active server job OR the browser single-flight.
  const blockedByActive = cloud.hasActiveExport || isExporting;
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
    effects: project.effectsSettings,
    sourceCrop: project.sourceCrop,
    visualAnalysis: project.visualAnalysis,
  };

  // Explicit, logged export path. The engine is the single source of truth for
  // which validation + submit pipeline runs — there is no implicit fallback from
  // one to the other.
  const exportPath: "cloud" | "browser" = engine === "server" ? "cloud" : "browser";

  const start = () => {
    // Client-side lock: a create request is already in flight — ignore extra
    // clicks so a double-click can't spawn two jobs (the server dedups too).
    if (cloud.starting) return;
    setBlockedWarning(null);
    cloud.clearError();
    console.log("[export-ui:path]", { path: exportPath });

    if (exportPath === "cloud") {
      // Cloud export is INDEPENDENT of browser codec limitations. We never run
      // MediaRecorder / canPlayType / audio-decode checks here — the VM worker
      // ffprobes, normalizes, and decides support. Auth/plan/minutes/active are
      // enforced server-side (and surfaced from the job/route response).
      console.log("[export-ui:browser-validation-skipped]", { reason: "cloud-export" });
      const v = validateForCloudExport(project);
      if (!v.ok) {
        console.log("[export-ui:error]", { source: "cloud", code: "precondition" });
        setBlockedWarning(v.error!);
        return;
      }
      if (blockedByActive) {
        setBlockedWarning(cloud.alreadyRunningMessage);
        return;
      }
      // Drop any stale browser job so a prior browser failure (e.g. a codec/audio
      // error) can't bleed into the cloud-export UI for the new job.
      if (myBrowserJob) clearJob();
      void cloud.startCloudExport(serverInput).then((r) => {
        if (r.ok) {
          console.log("[export-ui:cloud-submit]", { jobId: r.jobId });
        } else {
          console.log("[export-ui:error]", { source: "cloud", code: r.kind ?? "start_failed" });
          if (r.error) setBlockedWarning(r.error);
        }
      });
      return;
    }

    // Browser engine — renders the SELECTED container in the browser. MP4 uses
    // WebCodecs (Chrome/Edge) and auto-falls back to WebM where unsupported.
    // Browser codec checks live ONLY on this path.
    const v = validateForBrowserExport(project, supported);
    if (!v.ok) {
      console.log("[export-ui:error]", { source: "browser", code: "precondition" });
      setBlockedWarning(v.error!);
      return;
    }
    if (blockedByActive) {
      setBlockedWarning(cloud.alreadyRunningMessage);
      return;
    }
    const params: ExportRenderParams = {
      projectId: project.id,
      projectTitle: project.title,
      originalVideoUrl: project.originalVideoUrl!,
      duration: sourceDuration,
      moments,
      effects: project.effectsSettings,
      visualAnalysis: project.visualAnalysis,
      sourceCrop: project.sourceCrop,
      resolution,
      fps,
      format,
      container,
      outputFormat: `${canvasSummary} · ${resolution} · ${fps}fps · ${container === "mp4" ? "MP4" : "WebM"}`,
    };
    if (!startExport(params)) setBlockedWarning(cloud.alreadyRunningMessage);
  };

  const exportAgain = () => {
    cloud.dismiss();
    cloud.clearError();
    clearJob();
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

  const primaryLabel = cloud.starting
    ? "Starting export…"
    : engine === "server"
      ? "Cloud Export"
      : container === "mp4"
        ? "Export MP4"
        : "Export WebM";

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
          onDownloadAgain={
            view.engine === "server" ? cloud.downloadAgain : downloadCurrent
          }
          onCancel={
            view.engine === "server" ? () => void cloud.cancelCloudExport() : cancelExport
          }
          onExportAgain={exportAgain}
          onClose={onClose}
        />
      ) : (
        <>
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
            <Field label="Quality" lockHref={!canExport4k ? "/pricing" : undefined} lockLabel="4K — Pro">
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

          <Field label="Format">
            <Segmented
              options={["mp4", "webm"] as const}
              value={container}
              onChange={setContainer}
              renderLabel={(c) => (c === "mp4" ? "MP4" : "WebM")}
            />
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-fog/80">
              {container === "mp4"
                ? mp4NeedsUpgrade
                  ? "MP4 is a Pro feature — upgrade, or choose WebM to export now."
                  : engine === "server"
                    ? "Best quality and compatibility. Prepared automatically — close the dialog and it keeps going."
                    : "Best quality. Renders in your browser (Chrome or Edge)."
                : "Renders in your browser. Works everywhere; larger files."}
            </p>
          </Field>

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

          {/* Style — cinematic vignette */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/80">
                Style
              </div>
              <div className="text-[12.5px] font-medium text-white">Cinematic vignette</div>
            </div>
            <Toggle
              on={!!project.effectsSettings.vignette}
              onClick={() => updateEffects("vignette", !project.effectsSettings.vignette)}
            />
          </div>

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
                      project.effectsSettings.vignette === true,
                      project.effectsSettings.clickHighlights === true
                    ) || "Clean — no extra effects"
                  }
                />
              </div>
            )}
          </div>

          {/* Block / upgrade messaging */}
          {mp4NeedsUpgrade && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-violet-400/25 bg-violet-500/[0.07] px-4 py-3 text-[12px]">
              <span className="text-violet-100">
                MP4 export runs on our servers — a Pro feature.
              </span>
              <Link
                href="/pricing"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/20"
              >
                Upgrade
              </Link>
            </div>
          )}

          {anotherExporting && (
            <Notice tone="amber">{cloud.alreadyRunningMessage}</Notice>
          )}
          {blockedWarning && <Notice tone="rose">{blockedWarning}</Notice>}

          {/* Cloud export expectation-setting — it runs server-side and the user
              is free to leave the page while it renders. */}
          {engine === "server" && !mp4NeedsUpgrade && (
            <p className="text-[11px] leading-relaxed text-fog/80">
              Cloud export renders on our servers and may take a few minutes. You can
              leave this page — it keeps running and appears under Exports when ready.
            </p>
          )}

          {/* ── Bottom action area ────────────────────────────────────────── */}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <div className="min-w-0 text-[11px] leading-tight text-fog">
              {estRenderSeconds > 0 && (
                <div className="inline-flex items-center gap-1.5">
                  <Clock size={11} className="text-violet-300" />
                  ~{fmtDuration(estRenderSeconds)} to export
                </div>
              )}
              {engine === "server" && Number.isFinite(minutes.limit) && (
                <div className="mt-0.5 text-fog/80">
                  <span className="font-mono tabular-nums text-white/85">{minutes.remaining}</span>
                  {" / "}
                  {minutes.limit} min left · ~{estMinutes} this export
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button onClick={() => onClose?.()} variant="ghost" size="lg">
                Cancel
              </Button>
              {mp4NeedsUpgrade ? (
                <Link
                  href="/pricing"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-500 px-5 text-sm font-semibold text-white hover:bg-violet-400"
                >
                  Upgrade to export MP4
                </Link>
              ) : (
                <Button
                  onClick={start}
                  variant="primary"
                  size="lg"
                  leftIcon={
                    cloud.starting ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Download size={15} />
                    )
                  }
                  disabled={blockedByActive || cloud.starting || (engine === "browser" && !supported)}
                >
                  {primaryLabel}
                </Button>
              )}
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
                ? "Cloud export runs on our servers — it can take a few minutes. You can close this or leave the page; it keeps going and appears under Exports when ready."
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
            {downloadStarted
              ? "Download started. If it didn’t begin, use Download again."
              : "Your video is ready."}
          </p>
          {view.warningText && <Notice tone="amber">{view.warningText}</Notice>}
          <div className="flex items-center gap-2">
            <Button
              onClick={onDownloadAgain}
              variant="primary"
              size="lg"
              disabled={downloading}
              leftIcon={downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            >
              {downloading
                ? "Preparing download…"
                : downloadStarted
                  ? "Download again"
                  : "Download"}
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
  const rows: Array<[string, string | number | undefined]> = [
    ["renderMode", job.renderMode],
    ["chunkCount", job.chunkCount],
    ["chunksCompleted", job.chunkCount != null ? `${job.chunksCompleted ?? 0} / ${job.chunkCount}` : undefined],
    ["chunksFailed", job.chunksFailed],
    ["chunkParallelism", job.chunkParallelism],
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
  // Parallel chunked render: the worker writes `chunksCompleted` (not per-frame
  // progress), so drive both the label and the bar from chunks-done. Falls back to
  // the legacy sequential "chunk X/Y" and then to plain raw progress.
  const isChunked = j.renderMode === "chunked";
  const chunkTot = j.chunkCount ?? j.chunkTotal ?? 0;
  const chunkDone = j.chunksCompleted ?? 0;
  const chunkedRendering = stage === "rendering" && isChunked && chunkTot > 1;
  const rawPct =
    chunkedRendering && chunkTot > 0
      ? Math.round((chunkDone / chunkTot) * 100)
      : Math.round((j.progress ?? 0) * 100);
  const stageLabel = isWaitingForSlot(j)
    ? WAITING_FOR_SLOT_MESSAGE
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
    errorText: j.errorMessage
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
        {downloading ? "Preparing…" : "Download previous export"}
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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
        on ? "bg-violet-500" : "bg-white/[0.08] hover:bg-white/[0.14]"
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-sm transition-transform duration-150",
          on ? "translate-x-[18px]" : "translate-x-[2px]"
        )}
      />
    </button>
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

function describeExportEffects(vignette: boolean, clickHighlights: boolean): string {
  const on: string[] = [];
  if (vignette) on.push("vignette");
  if (clickHighlights) on.push("click highlights");
  return on.join(" · ");
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
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
