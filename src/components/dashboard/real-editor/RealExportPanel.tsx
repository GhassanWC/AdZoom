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
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import { pickedMimeAvailable } from "./export";
import {
  useExport,
  type ExportRenderParams,
  type ExportStatusUI,
} from "@/components/export/ExportProvider";
import { resolveOutputCanvas } from "@/lib/timeline/canvas-layout";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import type { ExportFormat, FitMode } from "@/lib/firebase/schema";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { useMonthlyUsage } from "@/lib/usage/useMonthlyUsage";

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

  // 4K requires a paid plan (Pro $19 and up). Free is capped at 1080p.
  const canExport4k = planMeetsMinimum(plan.tier, "pro");
  const availableResolutions = (
    canExport4k ? resolutions : (["1080p"] as const)
  ) as readonly ("1080p" | "4K")[];

  const [resolution, setResolution] = React.useState<"1080p" | "4K">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  const [blockedWarning, setBlockedWarning] = React.useState<string | null>(null);

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

  // Defensive: if the user was on a paid plan at 4K and downgraded to free
  // mid-session, snap them back to 1080p before they hit Export.
  React.useEffect(() => {
    if (!canExport4k && resolution === "4K") setResolution("1080p");
  }, [canExport4k, resolution]);

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
      outputFormat: `${canvasSummary} · ${resolution} · ${fps}fps`,
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

        <Segmented
          label="Frame rate"
          options={fpsOptions}
          value={fps}
          onChange={setFps}
          renderLabel={(n) => `${n}fps`}
        />

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
          <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-xs text-rose-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{blockedWarning || myJob?.error || "Export failed."}</span>
          </div>
        )}

        {/* Primary action — pinned to the bottom of the sheet body. */}
        <div className="space-y-2 pt-1">
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
              variant="primary"
              size="lg"
              className="w-full"
              leftIcon={<Download size={15} />}
              disabled={!supported || otherExporting}
            >
              Export {resolution}
            </Button>
          )}
          {otherExporting && (
            <p className="text-center text-[11px] text-amber-200/80">
              Another export is running in the background.
            </p>
          )}
        </div>

        <p className="text-[10.5px] leading-relaxed text-fog/80">
          Export runs entirely in your browser using canvas + MediaRecorder.
          Files render at real-time speed (a 60s video takes ~60s).
        </p>
      </div>
    </>
  );
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
