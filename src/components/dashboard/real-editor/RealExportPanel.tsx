"use client";

import * as React from "react";
import Link from "next/link";
import {
  Download,
  Smartphone,
  Monitor,
  Settings2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Wand2,
  Film,
  ZoomIn,
  Clock,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import {
  renderProjectClientSide,
  uploadExport,
  pickedMimeAvailable,
  pickedMimeExt,
  type ExportProgress,
} from "./export";
import type { ExportFormat } from "@/lib/firebase/schema";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";

const resolutions = ["1080p", "4K"] as const;
const fpsOptions = [30, 60] as const;
const formats: { id: ExportFormat; label: string; desc: string; Icon: typeof Smartphone }[] = [
  { id: "TikTok 9:16", label: "TikTok", desc: "9:16", Icon: Smartphone },
  { id: "YouTube 16:9", label: "YouTube", desc: "16:9", Icon: Monitor },
];

export function RealExportPanel() {
  const { project, uid, videoRef, duration } = useEditorReal();
  const { plan } = useStoragePlan();

  // 4K is Pro-only. Free + Creator are capped at 1080p.
  const canExport4k = planMeetsMinimum(plan.tier, "pro");
  const availableResolutions = (
    canExport4k ? resolutions : (["1080p"] as const)
  ) as readonly ("1080p" | "4K")[];

  const [resolution, setResolution] = React.useState<"1080p" | "4K">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  const [format, setFormat] = React.useState<ExportFormat>("YouTube 16:9");
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [downloadURL, setDownloadURL] = React.useState<string | null>(null);
  const cancelRef = React.useRef<AbortController | null>(null);

  // Defensive: if the user was on Pro at 4K and downgraded mid-session,
  // snap them back to 1080p before they hit Export.
  React.useEffect(() => {
    if (!canExport4k && resolution === "4K") setResolution("1080p");
  }, [canExport4k, resolution]);

  const supported = pickedMimeAvailable();

  // ── Pre-flight summary — what's about to be rendered ──────────────────────
  const moments = project.analysis?.detectedMoments ?? [];
  const zoomCount = moments.filter((m) => m.effectType === "zoom").length;
  const exportDuration = duration || project.duration || 0;
  // Client export renders at real-time speed + a little encode/upload overhead.
  const estRenderSeconds =
    exportDuration > 0 ? Math.ceil(exportDuration + 8) : 0;
  const presetName = project.selectedPresetId
    ? BUILTIN_PRESETS_BY_ID[project.selectedPresetId]?.name ?? "Custom preset"
    : "No preset";

  const start = async () => {
    setError(null);
    setDownloadURL(null);
    const video = videoRef.current;
    if (!video) {
      setError("Video element not ready.");
      return;
    }
    if (!project.originalVideoUrl) {
      setError("Project has no source video.");
      return;
    }
    if (!supported) {
      setError(
        "Client-side export isn't supported in this browser. Use Chrome or Edge."
      );
      return;
    }

    const controller = new AbortController();
    cancelRef.current = controller;
    setProgress({ stage: "preparing", pct: 0 });

    try {
      const blob = await renderProjectClientSide({
        uid,
        projectId: project.id,
        projectTitle: project.title,
        video,
        duration: duration || project.duration || 0,
        moments: project.analysis?.detectedMoments ?? [],
        effects: project.effectsSettings,
        resolution,
        fps,
        format,
        onProgress: (p) => setProgress(p),
        signal: controller.signal,
      });

      setProgress({ stage: "uploading", pct: 0 });
      const ext = pickedMimeExt();
      const { downloadURL } = await uploadExport({
        uid,
        projectId: project.id,
        projectTitle: project.title,
        blob,
        format,
        resolution,
        fps,
        ext,
      });
      setProgress({ stage: "complete", pct: 1, downloadURL });
      setDownloadURL(downloadURL);

      // Trigger local download too
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${project.title || "adzoom-export"}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed.";
      setProgress({ stage: "failed", pct: 0, message: msg });
      setError(msg);
    } finally {
      cancelRef.current = null;
    }
  };

  const cancel = () => {
    cancelRef.current?.abort();
  };

  const exporting =
    progress &&
    progress.stage !== "complete" &&
    progress.stage !== "failed" &&
    progress.stage !== "unsupported";

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

        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
            Format
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[...formats, { id: "Custom" as const, label: "Custom", desc: "—", Icon: Settings2 }].map(
              (f) => {
                const active = format === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-xl border p-4 text-center transition-colors duration-150",
                      active
                        ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                        : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white"
                    )}
                  >
                    <f.Icon size={16} />
                    <span className="text-[12px] font-medium">{f.label}</span>
                    <span className="text-[10px] opacity-70">{f.desc}</span>
                  </button>
                );
              }
            )}
          </div>
        </div>

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
              value={`${format} · ${resolution} · ${fps}fps`}
            />
            <PreFlightRow
              icon={<ZoomIn size={11} className="text-violet-300" />}
              label="Zoom moments"
              value={`${zoomCount} zoom${zoomCount === 1 ? "" : "s"} · ${
                moments.length
              } total`}
            />
            <PreFlightRow
              icon={<Clock size={11} className="text-violet-300" />}
              label="Est. render time"
              value={
                estRenderSeconds > 0 ? `~${fmtDuration(estRenderSeconds)}` : "—"
              }
            />
          </div>
        </div>

        {progress && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-white/85">
                {exporting && <Loader2 size={12} className="animate-spin text-violet-300" />}
                {stageLabel(progress)}
              </span>
              <span className="font-mono text-fog">
                {Math.round((progress.pct ?? 0) * 100)}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                style={{ width: `${(progress.pct ?? 0) * 100}%` }}
              />
            </div>
            {progress.message && (
              <p className="text-[11px] text-fog">{progress.message}</p>
            )}
          </div>
        )}

        {downloadURL && (
          <a
            href={downloadURL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-violet-300 underline-offset-4 hover:underline"
          >
            <ExternalLink size={12} />
            Open uploaded export
          </a>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-xs text-rose-200">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Primary action — pinned to the bottom of the sheet body. */}
        <div className="pt-1">
          {!exporting ? (
            <Button
              onClick={start}
              variant="primary"
              size="lg"
              className="w-full"
              leftIcon={<Download size={15} />}
              disabled={!supported}
            >
              Export {resolution}
            </Button>
          ) : (
            <Button onClick={cancel} variant="ghost" size="lg" className="w-full">
              Cancel
            </Button>
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

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function stageLabel(p: ExportProgress): string {
  switch (p.stage) {
    case "preparing":
      return "Preparing…";
    case "rendering":
      return "Rendering frames…";
    case "uploading":
      return "Uploading to Storage…";
    case "complete":
      return "Export complete";
    case "failed":
      return "Export failed";
    case "unsupported":
      return "Unsupported";
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
