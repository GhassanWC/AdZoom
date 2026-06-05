"use client";

import * as React from "react";
import Link from "next/link";
import {
  Download,
  Smartphone,
  Monitor,
  Maximize,
  AlertCircle,
  Loader2,
  ExternalLink,
  Wand2,
  Film,
  ZoomIn,
  Clock,
  Lock,
  Sparkles,
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
import { useMonthlyUsage } from "@/lib/usage/useMonthlyUsage";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useNotifications } from "@/lib/notifications/store";

const resolutions = ["1080p", "4K"] as const;
const fpsOptions = [30, 60] as const;
// "Source" is first AND the default — it preserves the full captured
// viewport (no crop). The other two are explicit CROP presets that force a
// fixed aspect and center-crop the source to fill it; their copy says so
// outright so a crop is never a surprise.
const formats: {
  id: ExportFormat;
  label: string;
  desc: string;
  Icon: typeof Smartphone;
}[] = [
  { id: "Source", label: "Source", desc: "Full frame", Icon: Maximize },
  { id: "YouTube 16:9", label: "YouTube", desc: "16:9 · crops", Icon: Monitor },
  { id: "TikTok 9:16", label: "TikTok", desc: "9:16 · crops", Icon: Smartphone },
];

export function RealExportPanel() {
  const { project, uid, videoRef, duration, updateEffects } = useEditorReal();
  const notifications = useNotifications();
  const { plan } = useStoragePlan();
  const usage = useMonthlyUsage();
  const { getIdToken } = useAuth();

  // 4K requires a paid plan (Pro $19 and up). Free is capped at 1080p.
  const canExport4k = planMeetsMinimum(plan.tier, "pro");
  const availableResolutions = (
    canExport4k ? resolutions : (["1080p"] as const)
  ) as readonly ("1080p" | "4K")[];

  const [resolution, setResolution] = React.useState<"1080p" | "4K">("1080p");
  const [fps, setFps] = React.useState<30 | 60>(30);
  const [format, setFormat] = React.useState<ExportFormat>("Source");
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [downloadURL, setDownloadURL] = React.useState<string | null>(null);
  const cancelRef = React.useRef<AbortController | null>(null);

  // Defensive: if the user was on a paid plan at 4K and downgraded to free
  // mid-session, snap them back to 1080p before they hit Export.
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
      // ── 1. Server-side permit ────────────────────────────────────────
      // Validates plan + monthly cap + locks resolution/format/watermark
      // server-side BEFORE we burn cycles rendering. Any failure here
      // saves the user a 60s+ render they couldn't have uploaded anyway.
      const token = await getIdToken();
      if (!token) throw new Error("Sign in to export.");
      const permitRes = await fetch("/api/billing/export-permit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          projectId: project.id,
          projectTitle: project.title,
          resolution,
          format,
          fps,
        }),
      });
      const permitJson = (await permitRes.json()) as {
        ok?: boolean;
        exportId?: string;
        uploadPath?: string;
        applyWatermark?: boolean;
        error?: string;
        kind?: "plan_required" | "limit_reached";
        used?: number;
        limit?: number;
      };
      if (!permitRes.ok || !permitJson.ok) {
        // Surface the server's clear message; the user knows what to do
        // (upgrade) without guessing.
        const friendly =
          permitJson.kind === "plan_required"
            ? "Pro plan required for 4K export. Upgrade in /pricing."
            : permitJson.kind === "limit_reached"
              ? `Export limit reached (${permitJson.used}/${permitJson.limit}). Upgrade to keep exporting.`
              : permitJson.error || `Export blocked (${permitRes.status})`;
        throw new Error(friendly);
      }

      const { exportId, uploadPath, applyWatermark } = permitJson;
      if (!exportId || !uploadPath) {
        throw new Error("Permit was missing exportId or uploadPath.");
      }

      // ── 2. Render ────────────────────────────────────────────────────
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
        applyWatermark: !!applyWatermark,
        onProgress: (p) => setProgress(p),
        signal: controller.signal,
      });

      // ── 3. Upload to the path the permit blessed ─────────────────────
      setProgress({ stage: "uploading", pct: 0 });
      const ext = pickedMimeExt();
      const { downloadURL } = await uploadExport({
        uid,
        projectId: project.id,
        exportId,
        uploadPath,
        blob,
      });
      setProgress({ stage: "complete", pct: 1, downloadURL });
      setDownloadURL(downloadURL);

      // Persistent notification — the user may have walked away from
      // the export panel by the time it finishes. Dedupe id ties to
      // the export id so a stray re-render can't queue it twice.
      notifications.push({
        id: `export-completed:${exportId}`,
        kind: "export-completed",
        title: "Export ready",
        body: `${project.title || "Untitled"} · ${format} · ${resolution}`,
        href: "/dashboard/exports",
      });

      // Trigger local download too
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${project.title || "framevo-export"}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed.";
      setProgress({ stage: "failed", pct: 0, message: msg });
      setError(msg);
      notifications.push({
        id: `export-failed:${project.id}:${Date.now()}`,
        kind: "export-failed",
        title: "Export failed",
        body: `${project.title || "Untitled"} — ${msg}`,
        href: `/dashboard/projects/${project.id}`,
      });
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
          {/* "Custom" was an option here. It surfaced as a button but the
              renderer in `export.ts` has no width/height/aspect/bitrate UI
              wired up, so selecting it silently exported at YouTube 16:9
              dimensions. Hidden until the Custom configuration panel ships
              (per user direction). The `"Custom"` literal stays in the
              `ExportFormat` union so any persisted defaults still
              type-check; `resolveOutputDims` maps it to a safe 16:9 crop. */}
          <div className="grid grid-cols-3 gap-1.5">
            {formats.map((f) => {
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
            })}
          </div>
          {/* Honest copy about what each mode does to the frame. The
              default ("Source") never crops; the presets always do. */}
          <p className="mt-2 text-[10.5px] leading-relaxed text-fog/80">
            {format === "Source"
              ? "Source keeps your full recording frame — nothing is cropped off the edges."
              : "This preset crops your recording to fit a fixed aspect. Pick Source to keep the whole frame."}
          </p>
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
