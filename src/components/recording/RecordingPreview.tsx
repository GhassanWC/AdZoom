"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Sparkles, Loader2, Clock, FileVideo, RefreshCcw } from "lucide-react";
import {
  detectGreenBottomBand,
  type GreenBandReport,
  type SourceCrop,
} from "@/lib/recording";
import { resolveSourceRect } from "@/lib/timeline/source-crop";
import { Toggle } from "@/components/ui/Toggle";
import Link from "next/link";
import { usePlanTier } from "@/lib/usage/useStoragePlan";
import {
  exceedsUploadDuration,
  FREE_VIDEO_DURATION_LIMIT_MESSAGE,
} from "@/lib/usage/plan";

/**
 * Post-recording take review. Shows the recorded clip with two paths:
 *  - "Use this take" → uploads + creates project + redirects to editor.
 *  - "Discard & re-record" → throws away the blob and returns to setup.
 *
 * When the captured surface was a browser tab, we run a heuristic
 * green-bottom-band detector against the blob to catch Chrome's
 * sharing-controls strip (the "green bar" bug). Detection is NON-DESTRUCTIVE:
 * instead of re-encoding the blob, we attach a `sourceCrop` (a bottom-only
 * `browser-bar-cleanup` rect) that every render/analysis path honors via
 * `resolveSourceRect` — the same global Frame Crop system the editor exposes.
 * The original bytes are untouched, so removal is instant and reversible. A
 * detected band is removed automatically (the user can flip it off); the
 * take-review preview reflects the cleaned frame so it's WYSIWYG.
 */
export function RecordingPreview({
  blob,
  durationSeconds,
  width,
  height,
  displaySurface,
  sourceCrop,
  onSetSourceCrop,
  onDiscard,
  onUse,
  uploading,
  uploadPct,
  error,
}: {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
  displaySurface: "monitor" | "window" | "browser" | null;
  /** Current source crop on the take (mirrors the provider's result). */
  sourceCrop: SourceCrop | undefined;
  /** Attach / update / clear the source crop on the take. */
  onSetSourceCrop: (crop: SourceCrop | undefined) => void;
  onDiscard: () => void;
  onUse: () => void;
  uploading: boolean;
  uploadPct: number | null;
  error: string | null;
}) {
  // Free plan caps uploads at 3 minutes — disable "Use this take" for longer
  // takes and surface an upgrade path. The provider also hard-blocks the upload.
  const { tier } = usePlanTier();
  const durationBlocked = exceedsUploadDuration(tier, durationSeconds);

  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  // ── Green-bar health check ────────────────────────────────────────────────
  // Only run on `displaySurface === "browser"` takes. Window/monitor captures
  // can't include Chrome's sharing-controls strip, so the detector would be
  // noise. The detector is heuristic — see `health-check.ts` for the rules.
  const [bandReport, setBandReport] = React.useState<GreenBandReport | null>(null);
  const [bandChecked, setBandChecked] = React.useState(false);
  /** One-shot latch so auto-enable fires at most once per blob. */
  const autoSetForBlobRef = React.useRef<Blob | null>(null);

  React.useEffect(() => {
    setBandReport(null);
    setBandChecked(false);
    if (displaySurface !== "browser") {
      setBandChecked(true);
      return;
    }
    let cancelled = false;
    detectGreenBottomBand(blob, { surface: displaySurface })
      .then((report) => {
        if (!cancelled) setBandReport(report);
      })
      .catch(() => {
        // Detection failure is non-fatal — the user can still use the take.
      })
      .finally(() => {
        if (!cancelled) setBandChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [blob, displaySurface]);

  /** Build a bottom-only `browser-bar-cleanup` source crop from the report. */
  const buildCrop = React.useCallback(
    (on: boolean): SourceCrop | undefined => {
      if (!bandReport || !bandReport.detected) return undefined;
      const h = bandReport.videoHeight;
      const keepH = h > 0 ? Math.max(0, Math.min(1, (h - bandReport.bandHeightPx) / h)) : 1;
      return {
        enabled: on,
        x: 0,
        y: 0,
        width: 1,
        height: keepH,
        reason: "browser-bar-cleanup",
        confidence: bandReport.confidence,
      };
    },
    [bandReport]
  );

  // Auto-enable: a detected sharing-bar is removed automatically (removal is
  // non-destructive + reversible, so a false positive costs one toggle click).
  // Runs at most once per blob; the user's later toggle decisions stick.
  React.useEffect(() => {
    if (!bandChecked || !bandReport?.detected) return;
    if (autoSetForBlobRef.current === blob) return;
    autoSetForBlobRef.current = blob;
    onSetSourceCrop(buildCrop(true));
  }, [bandChecked, bandReport, blob, buildCrop, onSetSourceCrop]);

  const cropEnabled = sourceCrop?.enabled === true;

  const onToggleCrop = React.useCallback(
    (next: boolean) => {
      if (sourceCrop) {
        onSetSourceCrop({ ...sourceCrop, enabled: next });
      } else {
        onSetSourceCrop(buildCrop(next));
      }
    },
    [sourceCrop, onSetSourceCrop, buildCrop]
  );

  // Visual crop for the take-review preview, so the pane is WYSIWYG with the
  // editor + export (both crop via the same `resolveSourceRect`). The detector
  // only ever produces a bottom-only rect, so the over-tall top-anchor clip is
  // exact here.
  const rect = resolveSourceRect(width, height, sourceCrop);
  const cropActive = rect.cropActive && height > 0;
  const f = cropActive ? rect.sHeight / height : 1;

  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);
  const showCleanupControl = bandChecked && (bandReport?.detected === true || cropEnabled);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10"
    >
      <div className="text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
          <Sparkles size={11} />
          Take ready
        </div>
        <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          That looked clean.
        </h2>
        <p className="mt-2 text-sm text-fog">
          Send it to the AI editor and it&apos;ll draft the cinematic cut.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_280px]">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
          {url &&
            (cropActive ? (
              // Over-tall, top-anchored video clipped to the effective (cropped)
              // height — the bottom sharing bar overflows below and is hidden.
              <div
                className="relative w-full overflow-hidden"
                style={{ aspectRatio: `${width} / ${rect.sHeight}` }}
              >
                <video
                  src={url}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="absolute left-0 top-0 w-full object-cover"
                  style={{ height: `${100 / f}%` }}
                />
              </div>
            ) : (
              <video
                src={url}
                controls
                autoPlay
                muted
                loop
                className="aspect-video w-full"
              />
            ))}
        </div>

        <div className="glass space-y-3 rounded-2xl p-5 text-sm">
          <Row label="Duration">
            <span className="inline-flex items-center gap-1.5 text-white">
              <Clock size={12} className="text-violet-300" />
              <span className="font-mono tabular-nums">
                {fmt(durationSeconds)}
              </span>
            </span>
          </Row>
          <Row label="Resolution">
            {width && height
              ? cropActive
                ? `${rect.sWidth} × ${rect.sHeight}`
                : `${width} × ${height}`
              : "—"}
          </Row>
          <Row label="Size">{sizeMB} MB</Row>
          <Row label="Format">
            <span className="inline-flex items-center gap-1.5 text-white/85">
              <FileVideo size={12} className="text-fog" />
              {blob.type.split(";")[0] || "video"}
            </span>
          </Row>

          {uploadPct !== null && (
            <div className="pt-3">
              <div className="flex items-center justify-between text-[11px] text-fog">
                <span className="inline-flex items-center gap-1.5 text-white/85">
                  <Loader2 size={11} className="animate-spin text-violet-300" />
                  Uploading
                </span>
                <span className="font-mono">{uploadPct.toFixed(0)}%</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sharing-bar cleanup control. A solid band along the bottom of a
          browser-tab capture is Chrome's sharing-controls strip. We remove it
          non-destructively (the blob is untouched) by cropping every render +
          the export; the toggle flips that off to reveal the original frame.
          Only shown for browser-tab takes where a band was detected. */}
      {showCleanupControl && (
        <div className="mx-auto w-full max-w-2xl rounded-2xl border border-violet-400/30 bg-violet-500/[0.08] px-4 py-3.5">
          <Toggle
            label="Remove browser sharing bar"
            checked={cropEnabled}
            onChange={onToggleCrop}
            description={
              cropEnabled
                ? `Framevo detected a browser tab sharing bar and is removing it from preview and export. Reversible anytime in the editor.`
                : "Off — the original captured frame (including the browser sharing bar) will be used."
            }
          />
        </div>
      )}

      {durationBlocked && (
        <div className="mx-auto flex max-w-md items-center gap-3 rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
          <span className="flex-1 text-left">
            {FREE_VIDEO_DURATION_LIMIT_MESSAGE}
          </span>
          <Link
            href="/pricing"
            className="shrink-0 rounded-md border border-rose-300/40 bg-rose-400/15 px-2.5 py-1 text-[12px] font-semibold text-rose-50 transition-colors hover:bg-rose-400/25"
          >
            Upgrade
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onDiscard}
          disabled={uploading}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-6 text-sm text-fog transition-colors duration-200 hover:border-white/25 hover:text-white disabled:opacity-50"
        >
          <RefreshCcw size={14} />
          Discard &amp; re-record
        </button>
        <button
          type="button"
          onClick={onUse}
          disabled={uploading || durationBlocked}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-[0_18px_40px_-16px_rgba(139,92,246,0.65)] transition-all duration-200 hover:from-violet-500 hover:to-violet-500 disabled:opacity-70"
        >
          {uploading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {uploading ? "Sending to AI…" : "Use this take"}
        </button>
      </div>

      {error && (
        <div className="mx-auto max-w-md rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-center text-sm text-rose-200">
          {error}
        </div>
      )}
    </motion.div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-sm text-white/85">
        {children}
      </dd>
    </div>
  );
}

function fmt(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
