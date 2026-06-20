"use client";

import * as React from "react";
import Link from "next/link";
import {
  Download,
  AlertCircle,
  Loader2,
  ExternalLink,
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
  Cloud,
  Zap,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { downloadFile } from "@/lib/download";
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
import {
  type ExportContainer,
  CONTAINERS,
  DEFAULT_CONTAINER,
  canEncodeMp4,
} from "./export-format";
import type { ExportFormat, FitMode } from "@/lib/firebase/schema";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { useMonthlyUsage } from "@/lib/usage/useMonthlyUsage";
import { useCloudMinutes, type CloudMinutesState } from "@/lib/usage/useCloudMinutes";
import {
  CLOUD_EXPORT_MINUTES,
  estimateExportMinutes,
} from "@/lib/usage/cloud-minutes";
import {
  useCloudExport,
  type StartCloudExportInput,
} from "@/components/export/useCloudExport";
import type { ExportJobView } from "@/lib/firebase/export-jobs";

const resolutions = ["1080p", "4K"] as const;
const fpsOptions = [30, 60] as const;

const FIT_LABEL: Record<FitMode, string> = {
  fit: "Fit",
  fill: "Fill",
  "smart-fit": "Smart Fit",
  manual: "Manual",
};

export function RealExportPanel({ onClose }: { onClose?: () => void }) {
  const { project, duration, updateEffects, openCanvas } = useEditorReal();

  // Output aspect/fit now lives in the global Canvas panel — the export reads
  // it via `resolveOutputCanvas`. `format` is derived purely for the billing
  // permit + pre-flight label (the renderer honours `outputCanvas` directly).
  const outputCanvas = resolveOutputCanvas(project.effectsSettings);
  const format: ExportFormat = !outputCanvas
    ? "Source"
    : outputCanvas.aspectRatio === "9:16"
      ? "TikTok 9:16"
      : outputCanvas.aspectRatio === "16:9"
        ? "YouTube 16:9"
        : "Custom";
  const canvasSummary = outputCanvas
    ? `${outputCanvas.aspectRatio} · ${FIT_LABEL[outputCanvas.fitMode]}${
        outputCanvas.fitMode === "fit" || outputCanvas.fitMode === "manual"
          ? ` · ${outputCanvas.backgroundMode} bg`
          : ""
      }`
    : "Source · full frame";
  const { plan } = useStoragePlan();
  const usage = useMonthlyUsage();
  const { job, isExporting, startExport, cancelExport, downloadCurrent } =
    useExport();

  // Paid plans (Pro/Creator) get server-side cloud MP4 export as the primary
  // path; Free stays browser-only. The browser flow below remains available to
  // paid users as an explicit fallback ("Render in browser instead").
  // Gated by the kill switch: when NEXT_PUBLIC_CLOUD_EXPORT_ENABLED !== "true"
  // the cloud UI is hidden entirely and everyone uses browser export.
  const cloudExportEnabled = process.env.NEXT_PUBLIC_CLOUD_EXPORT_ENABLED === "true";
  const isPaid = planMeetsMinimum(plan.tier, "pro");
  const cloudPrimary = isPaid && cloudExportEnabled;
  const cloudMinutes = useCloudMinutes();
  const cloud = useCloudExport(project.id);

  // 4K and 60fps require a paid plan (Pro $19 and up). Free is capped at 1080p/30.
  const canExport4k = planMeetsMinimum(plan.tier, "pro");
  const canExport60 = planMeetsMinimum(plan.tier, "pro");
  const availableResolutions = (
    canExport4k ? resolutions : (["1080p"] as const)
  ) as readonly ("1080p" | "4K")[];
  const availableFps = (canExport60 ? fpsOptions : ([30] as const)) as readonly (30 | 60)[];

  const [resolution, setResolution] = React.useState<"1080p" | "4K">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  const [container, setContainer] = React.useState<ExportContainer>(DEFAULT_CONTAINER);
  // null = probing; true/false = can this browser produce a real MP4 (WebCodecs)?
  const [mp4Supported, setMp4Supported] = React.useState<boolean | null>(null);
  const [blockedWarning, setBlockedWarning] = React.useState<string | null>(null);

  // Probe MP4 capability for the SELECTED resolution/fps (4K needs a higher
  // H.264 level than 1080p). The renderer re-checks the real canvas dims and
  // falls back to WebM if needed, so this is just for an accurate UI affordance.
  React.useEffect(() => {
    let alive = true;
    setMp4Supported(null);
    const dims =
      resolution === "4K"
        ? { width: 3840, height: 2160 }
        : { width: 1920, height: 1080 };
    void canEncodeMp4({ ...dims, fps, resolution }).then((ok) => {
      if (alive) setMp4Supported(ok);
    });
    return () => {
      alive = false;
    };
  }, [resolution, fps]);

  // If MP4 turns out unsupported, snap a stale MP4 selection back to WebM.
  React.useEffect(() => {
    if (mp4Supported === false && container === "mp4") setContainer("webm");
  }, [mp4Supported, container]);

  // The export job is shown here ONLY when it belongs to this project — a
  // background export for another project surfaces in the global pill instead.
  const myJob = job && job.projectId === project.id ? job : null;
  const exporting =
    !!myJob &&
    (myJob.status === "preparing" ||
      myJob.status === "rendering" ||
      myJob.status === "uploading");
  // Another project's export is mid-flight — block starting a duplicate.
  const otherExporting = isExporting && job?.projectId !== project.id;

  // Defensive: if the user was on a paid plan at 4K/60 and downgraded to free
  // mid-session, snap them back to 1080p/30 before they hit Export.
  React.useEffect(() => {
    if (!canExport4k && resolution === "4K") setResolution("1080p");
  }, [canExport4k, resolution]);
  React.useEffect(() => {
    if (!canExport60 && fps === 60) setFps(30);
  }, [canExport60, fps]);

  const supported = pickedMimeAvailable();

  // ── Pre-flight summary — what's about to be rendered ──────────────────────
  const moments = project.analysis?.detectedMoments ?? [];
  const zoomCount = moments.filter((m) => m.effectType === "zoom").length;
  const sourceDuration = duration || project.duration || 0;
  // Active cuts remove time + speed compresses it → the real exported length.
  const cutMap = buildTimelineMap(moments, sourceDuration);
  const exportDuration = cutMap.outputDuration;
  // Client export renders at real-time speed + a little encode/upload overhead.
  const estRenderSeconds =
    exportDuration > 0 ? Math.ceil(exportDuration + 8) : 0;
  const presetName = project.selectedPresetId
    ? BUILTIN_PRESETS_BY_ID[project.selectedPresetId]?.name ?? "Custom preset"
    : "No preset";

  // Hand the whole lifecycle to the session-level ExportProvider so it survives
  // closing this modal AND navigating away (it renders on its own offscreen
  // video). This panel just collects params + reflects the job state.
  const start = () => {
    setBlockedWarning(null);
    if (!project.originalVideoUrl) {
      setBlockedWarning("Project has no source video.");
      return;
    }
    if (!supported) {
      setBlockedWarning(
        "Client-side export isn't supported in this browser. Use Chrome or Edge."
      );
      return;
    }
    const params: ExportRenderParams = {
      projectId: project.id,
      projectTitle: project.title,
      originalVideoUrl: project.originalVideoUrl,
      duration: duration || project.duration || 0,
      moments: project.analysis?.detectedMoments ?? [],
      effects: project.effectsSettings,
      visualAnalysis: project.visualAnalysis,
      sourceCrop: project.sourceCrop,
      resolution,
      fps,
      format,
      container,
      outputFormat: `${canvasSummary} · ${resolution} · ${fps}fps · ${CONTAINERS[container].label}`,
    };
    if (!startExport(params)) {
      setBlockedWarning(
        "An export is already running. Cancel it or wait for it to finish."
      );
    }
  };

  return (
    <>
      <div className="space-y-6 px-6 py-6">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Resolution
            </span>
            {!canExport4k && (
              <Link
                href="/pricing"
                className="inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/20"
                title="4K exports require a Pro plan"
              >
                <Lock size={9} />
                4K — Pro
              </Link>
            )}
          </div>
          <Segmented
            label=""
            options={availableResolutions}
            value={resolution}
            onChange={setResolution}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Frame rate
            </span>
            {!canExport60 && (
              <Link
                href="/pricing"
                className="inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/20"
                title="60fps exports require a Pro plan"
              >
                <Lock size={9} />
                60fps — Pro
              </Link>
            )}
          </div>
          <Segmented
            label=""
            options={availableFps}
            value={fps}
            onChange={setFps}
            renderLabel={(n) => `${n}fps`}
          />
        </div>

        {/* Format (container) — WebM is the reliable default; MP4 is produced by
            a WebCodecs pipeline and only offered where the browser supports it. */}
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Format
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {(["webm", "mp4"] as const).map((c) => {
              // Treat the in-flight probe (null) as not-yet-available so the
              // button doesn't briefly appear selectable then disable.
              const mp4Disabled = c === "mp4" && mp4Supported !== true;
              const selected = container === c;
              return (
                <button
                  key={c}
                  type="button"
                  disabled={mp4Disabled}
                  onClick={() => !mp4Disabled && setContainer(c)}
                  title={
                    mp4Disabled
                      ? "MP4 export needs Chrome or Edge (WebCodecs)."
                      : CONTAINERS[c].description
                  }
                  className={cn(
                    "rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150",
                    selected
                      ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                      : mp4Disabled
                        ? "cursor-not-allowed text-fog/40"
                        : "text-fog hover:bg-white/[0.04] hover:text-white"
                  )}
                >
                  {CONTAINERS[c].label}
                  {c === "mp4" && mp4Supported === false && (
                    <span className="ml-1 text-[10px] text-fog/50">· n/a</span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-fog/80">
            {container === "mp4"
              ? CONTAINERS.mp4.description
              : mp4Supported === false
                ? "WebM — reliable, high quality. MP4 needs Chrome or Edge."
                : CONTAINERS.webm.description}
          </p>
        </div>

        {/* Output canvas — aspect ratio + fit + background now live in the
            global Canvas panel (one source of truth for preview AND export).
            This is a read-only summary with a shortcut to edit it. */}
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Canvas
          </div>
          <button
            onClick={openCanvas}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-left transition-colors duration-150 hover:border-white/20"
          >
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-500/10 text-violet-200">
              <Frame size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium capitalize text-white">
                {canvasSummary}
              </span>
              <span className="block text-[10.5px] leading-relaxed text-fog/80">
                {outputCanvas
                  ? "How your video fits the export frame — preview matches."
                  : "Keeps your full recording frame. Nothing is cropped."}
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-300">
              <Pencil size={12} />
              Edit
            </span>
          </button>
        </div>

        {/* Cinematic vignette — opt-in. When on, BOTH preview and
            export render the same radial darkening at the frame edges
            so what you see is what you get. Persisted on the project's
            effectsSettings so re-opening the editor remembers the
            choice. */}
        <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-white">
              Cinematic vignette
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fog">
              Soft radial darkening at the frame edges. Off by default —
              the preview matches, so it&apos;s safe to flip on / off and
              see the result before exporting.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!project.effectsSettings.vignette}
            onClick={() =>
              updateEffects("vignette", !project.effectsSettings.vignette)
            }
            className={cn(
              "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
              project.effectsSettings.vignette
                ? "bg-violet-500"
                : "bg-white/[0.08] hover:bg-white/[0.14]"
            )}
          >
            <span
              className={cn(
                "inline-block size-4 rounded-full bg-white shadow-sm transition-transform duration-150",
                project.effectsSettings.vignette
                  ? "translate-x-[18px]"
                  : "translate-x-[2px]"
              )}
            />
          </button>
        </div>

        {/* Monthly usage strip — live counter from users/{uid}/usage/{YYYY-MM} */}
        {Number.isFinite(usage.limit) && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-[12px]">
            <span className="inline-flex items-center gap-2 text-fog">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/80">
                This month
              </span>
              <span className="font-mono tabular-nums text-white/85">
                {usage.used} / {usage.limit}
              </span>
              <span className="text-fog/70">exports</span>
            </span>
            {usage.remaining <= 0 ? (
              <Link
                href="/pricing"
                className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-rose-200 hover:bg-rose-500/20"
              >
                Limit reached — upgrade
              </Link>
            ) : usage.remaining <= 2 ? (
              <Link
                href="/pricing"
                className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-200 hover:bg-amber-500/20"
              >
                {usage.remaining} left — upgrade
              </Link>
            ) : null}
          </div>
        )}

        {/* Pre-flight summary — build trust before the user commits to a render */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Before you export
          </div>
          <div className="space-y-2">
            <PreFlightRow
              icon={<Wand2 size={11} className="text-violet-300" />}
              label="Preset"
              value={presetName}
            />
            <PreFlightRow
              icon={<Film size={11} className="text-violet-300" />}
              label="Output"
              value={`${canvasSummary} · ${resolution} · ${fps}fps`}
            />
            <PreFlightRow
              icon={<ZoomIn size={11} className="text-violet-300" />}
              label="Zoom moments"
              value={`${zoomCount} zoom${zoomCount === 1 ? "" : "s"} · ${
                moments.length
              } total`}
            />
            <PreFlightRow
              icon={<Scissors size={11} className="text-rose-300" />}
              label="Duration"
              value={
                cutMap.totalRemoved > 0
                  ? `${fmtDuration(Math.round(exportDuration))} · −${Math.round(
                      cutMap.totalRemoved
                    )}s from ${cutMap.activeCuts} cut${
                      cutMap.activeCuts === 1 ? "" : "s"
                    }`
                  : fmtDuration(Math.round(exportDuration))
              }
            />
            <PreFlightRow
              icon={<Clock size={11} className="text-violet-300" />}
              label="Est. render time"
              value={
                estRenderSeconds > 0 ? `~${fmtDuration(estRenderSeconds)}` : "—"
              }
            />
            {/* Render manifest summary — mirrors the dev-mode
                `[export] render manifest` console table. Surfaces the
                conditional layers (vignette, click highlights) so the
                user can't accidentally export with vignette on without
                realising. "Clean" = no opt-in visual effects baked in. */}
            <PreFlightRow
              icon={<Sparkles size={11} className="text-violet-300" />}
              label="Visual effects"
              value={
                describeExportEffects(
                  project.effectsSettings.vignette === true,
                  project.effectsSettings.clickHighlights === true
                ) || "Clean — no extra effects baked in"
              }
            />
          </div>
        </div>

        {exporting && myJob && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-white/85">
                <Loader2 size={12} className="animate-spin text-violet-300" />
                {jobStageLabel(myJob.status)}
              </span>
              <span className="font-mono text-fog">
                {Math.round((myJob.progress ?? 0) * 100)}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                style={{ width: `${(myJob.progress ?? 0) * 100}%` }}
              />
            </div>
            <p className="text-[11px] text-fog">
              Runs in the background — you can keep editing or close this.
            </p>
          </div>
        )}

        {myJob?.status === "completed" && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] px-4 py-3 text-xs text-emerald-200">
            <Download size={12} className="mt-0.5 shrink-0" />
            <span>
              Export ready{myJob.downloadUrl ? "" : " in this browser session"}.
            </span>
          </div>
        )}

        {/* Audio warning — non-fatal. The export still completes; this tells the
            user it will be silent (e.g. browser couldn't capture the source
            audio) so a missing voiceover isn't a silent surprise. */}
        {myJob?.warning && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{myJob.warning}</span>
          </div>
        )}

        {(blockedWarning || myJob?.status === "failed") && (
          <div className="space-y-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-xs text-rose-200">
            <div className="flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{blockedWarning || myJob?.error || "Export failed."}</span>
            </div>
            {myJob?.status === "failed" && (
              <ExportFailureDetails job={myJob} projectId={project.id} />
            )}
          </div>
        )}

        {/* Cloud MP4 export (paid) — the primary path. Free sees an upgrade
            nudge here and uses the browser export below. Hidden entirely while
            the cloud-export kill switch is off. */}
        {cloudExportEnabled && (
        <CloudExportSection
          isPaid={isPaid}
          minutes={cloudMinutes}
          cloud={cloud}
          estimateMinutes={estimateExportMinutes(exportDuration)}
          hasSource={!!project.originalVideoUrl}
          input={{
            projectId: project.id,
            projectTitle: project.title,
            resolution,
            fps,
            format,
            sourceWidth: project.width ?? 0,
            sourceHeight: project.height ?? 0,
            sourceDuration: duration || project.duration || 0,
            moments: project.analysis?.detectedMoments ?? [],
            effects: project.effectsSettings,
            sourceCrop: project.sourceCrop,
            visualAnalysis: project.visualAnalysis,
          }}
        />
        )}

        {/* Primary action — pinned to the bottom of the sheet body. */}
        <div className="space-y-2 pt-1">
          {cloudPrimary && (
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog/70">
              Or render in browser
            </div>
          )}
          {exporting ? (
            <>
              <Button
                onClick={() => onClose?.()}
                variant="primary"
                size="lg"
                className="w-full"
              >
                Continue in background
              </Button>
              <Button
                onClick={cancelExport}
                variant="ghost"
                size="lg"
                className="w-full"
              >
                Cancel export
              </Button>
            </>
          ) : myJob?.status === "completed" ? (
            <>
              <Button
                onClick={downloadCurrent}
                variant="primary"
                size="lg"
                className="w-full"
                leftIcon={<Download size={15} />}
              >
                Download export
              </Button>
              <Link
                href="/dashboard/exports"
                className="inline-flex w-full items-center justify-center gap-1.5 text-xs text-violet-300 underline-offset-4 hover:underline"
              >
                <ExternalLink size={12} />
                View all exports
              </Link>
            </>
          ) : (
            <Button
              onClick={start}
              variant={cloudPrimary ? "ghost" : "primary"}
              size="lg"
              className="w-full"
              leftIcon={<Download size={15} />}
              disabled={!supported || otherExporting}
            >
              {cloudPrimary ? "Render in browser instead" : `Export ${resolution}`}
            </Button>
          )}
          {otherExporting && (
            <p className="text-center text-[11px] text-amber-200/80">
              Another export is running in the background.
            </p>
          )}
        </div>

        <p className="text-[10.5px] leading-relaxed text-fog/80">
          {cloudPrimary
            ? "Cloud export renders MP4 on our servers — you can close this and the export keeps going. Browser export stays available as a fallback."
            : "Export runs entirely in your browser using canvas + MediaRecorder. Files render at real-time speed (a 60s video takes ~60s)."}
        </p>
      </div>
    </>
  );
}

/**
 * Collapsible diagnostics for a failed export. Surfaces the stage + non-secret
 * detail (the same fields in the `[export-failed]` console log) so a user can
 * copy a useful bug report. Deliberately shows NO tokens / signed URLs. The
 * failed state is never auto-hidden — it stays until the user dismisses or
 * retries.
 */
function ExportFailureDetails({
  job,
  projectId,
}: {
  job: ExportJob;
  projectId: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const d = job.debug;
  const rows: Array<[string, string | undefined]> = [
    ["Stage", job.errorStage ?? d?.stage],
    ["Reason", job.error],
    ["Error", [d?.name, d?.code].filter(Boolean).join(" · ") || undefined],
    ["Project", projectId],
    ["Export ID", job.id && job.id !== "pending" ? job.id : undefined],
    ["Format", job.outputFormat],
    ["Recorder MIME", d?.mimeType ?? undefined],
    [
      "Output size",
      typeof d?.outputSize === "number"
        ? `${(d.outputSize / (1024 * 1024)).toFixed(1)} MB`
        : undefined,
    ],
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
      () => {
        /* clipboard blocked — ignore */
      }
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

/**
 * Cloud MP4 export block. For paid plans it's the primary export path —
 * minutes meter, a one-click start, and live job status (queued → rendering →
 * uploading → ready) driven by the Firestore `exportJobs` subscription, with
 * cancel + download. For Free it's an upgrade nudge (browser export below is
 * their path). Creator shows a priority badge.
 */
function CloudExportSection({
  isPaid,
  minutes,
  cloud,
  estimateMinutes,
  hasSource,
  input,
}: {
  isPaid: boolean;
  minutes: CloudMinutesState;
  cloud: ReturnType<typeof useCloudExport>;
  estimateMinutes: number;
  hasSource: boolean;
  input: StartCloudExportInput;
}) {
  if (!isPaid) {
    return (
      <div className="rounded-xl border border-violet-400/25 bg-violet-500/[0.07] px-4 py-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-violet-100">
          <Cloud size={14} className="text-violet-300" />
          Cloud MP4 export
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-fog">
          Render high-quality MP4 on our servers — no browser tab needed, and the
          export keeps going after you leave. Included with Pro (
          {CLOUD_EXPORT_MINUTES.pro} min/mo) and Creator (
          {CLOUD_EXPORT_MINUTES.creator} min/mo).
        </p>
        <Link
          href="/pricing"
          className="mt-2 inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/20"
        >
          Upgrade to Pro
        </Link>
      </div>
    );
  }

  const { job, isActive, isStale, starting, error, startCloudExport, cancelCloudExport } =
    cloud;
  const isCreator = minutes.plan === "creator";
  const enoughMinutes = minutes.remaining >= estimateMinutes;
  const usedPct =
    minutes.limit > 0 ? Math.min(100, (minutes.used / minutes.limit) * 100) : 0;
  const blocked = !hasSource || !enoughMinutes || starting || isActive;
  // Set expectations before a long render: 4K/60fps and longer clips take
  // noticeably more wall-clock time on the worker.
  const slowExport =
    estimateMinutes >= 8 || input.resolution === "4K" || input.fps === 60;

  return (
    <div className="space-y-3 rounded-xl border border-violet-400/30 bg-violet-500/[0.06] px-4 py-3.5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold text-white">
          <Cloud size={14} className="text-violet-300" />
          Cloud MP4 export
        </span>
        {isCreator && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
            <Zap size={9} /> Priority
          </span>
        )}
      </div>

      {/* Minutes meter */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <span className="inline-flex items-center gap-2 text-fog">
          <span className="font-mono tabular-nums text-white/85">
            {minutes.remaining}
          </span>
          <span className="text-fog/70">/ {minutes.limit} min left this month</span>
        </span>
        <span className="text-fog/70">~{estimateMinutes} min this export</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
          style={{ width: `${usedPct}%` }}
        />
      </div>

      {/* Slow-export heads-up (only when nothing is in flight) */}
      {slowExport && !isActive && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-200/90">
          <Clock size={12} className="mt-0.5 shrink-0" />
          <span>
            Large export — 4K, 60fps, and longer clips take noticeably longer to
            render. You can close this tab; the export keeps running.
          </span>
        </div>
      )}

      {/* Live job status — hidden once the job goes stale (worker likely died) */}
      {isActive && !isStale && job && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 text-white/85">
              <Loader2 size={12} className="animate-spin text-violet-300" />
              {cloudJobStageLabel(job)}
            </span>
            <span className="font-mono text-fog">
              {Math.round((job.progress ?? 0) * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
              style={{ width: `${(job.progress ?? 0) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Stale job — stuck with no progress. Offer cancel (releases minutes) + retry. */}
      {isActive && isStale && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            This export seems stuck and may have failed. Cancel it to free up your
            minutes, then try again.
          </span>
        </div>
      )}

      {job?.status === "ready" && job.downloadUrl && (
        <button
          type="button"
          onClick={() =>
            void downloadFile(
              job.downloadUrl!,
              `${(input.projectTitle || "framevo-export").replace(/[^\w.-]+/g, "_")}.mp4`
            )
          }
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/[0.07] px-3 py-2 text-[11.5px] font-medium text-emerald-200 hover:bg-emerald-500/[0.12]"
        >
          <Download size={13} /> Download MP4
        </button>
      )}

      {job?.status === "ready" && (job.warnings?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{job.warnings!.join(" ")}</span>
        </div>
      )}

      {job?.status === "failed" && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {/* Show the backend errorCode alongside the message so a generic
              "Something went wrong" still carries the actionable reason. */}
          <span>
            {job.errorMessage || "Cloud export failed."}
            {job.errorCode ? ` (${job.errorCode})` : ""}
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!enoughMinutes && !isActive && (
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-rose-200 hover:bg-rose-500/20"
        >
          Out of minutes — upgrade
        </Link>
      )}

      {/* Action */}
      {isActive ? (
        <Button
          onClick={() => void cancelCloudExport()}
          variant="ghost"
          size="lg"
          className="w-full"
          leftIcon={<X size={15} />}
        >
          Cancel cloud export
        </Button>
      ) : (
        <Button
          onClick={() => void startCloudExport(input)}
          variant="primary"
          size="lg"
          className="w-full"
          leftIcon={<Cloud size={15} />}
          disabled={blocked}
        >
          {starting ? "Starting…" : "Export to cloud (MP4)"}
        </Button>
      )}
    </div>
  );
}

function cloudJobStageLabel(job: ExportJobView): string {
  switch (job.status) {
    case "queued":
      return "Queued…";
    case "rendering":
      return job.stage === "normalizing"
        ? "Preparing source…"
        : job.stage === "encoding"
          ? "Encoding…"
          : "Rendering…";
    case "uploading":
      return "Saving…";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
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
      <span className="min-w-0 truncate text-right font-medium text-white/90">
        {value}
      </span>
    </div>
  );
}

/**
 * Compose the "Visual effects" pre-flight value. Returns an empty
 * string when no conditional effect is on (caller prints "Clean — …"
 * instead). Mirrors the dev console's render manifest so the user can
 * cross-check what's about to bake in.
 */
function describeExportEffects(
  vignette: boolean,
  clickHighlights: boolean
): string {
  const on: string[] = [];
  if (vignette) on.push("vignette");
  if (clickHighlights) on.push("click highlights");
  return on.length === 0 ? "" : `${on.join(" · ")}`;
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function jobStageLabel(status: ExportStatusUI): string {
  switch (status) {
    case "preparing":
      return "Preparing…";
    case "rendering":
      return "Rendering frames…";
    case "uploading":
      return "Saving export…";
    case "completed":
      return "Export complete";
    case "failed":
      return "Export failed";
    case "canceled":
      return "Export canceled";
  }
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  renderLabel,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  renderLabel?: (v: T) => string;
}) {
  return (
    <div>
      {label && (
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          {label}
        </div>
      )}
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
    </div>
  );
}
