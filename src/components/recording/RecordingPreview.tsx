"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  RefreshCcw,
  Sparkles,
  Loader2,
  Clock,
  FileVideo,
  AlertTriangle,
  Scissors,
  Check,
} from "lucide-react";
import {
  detectGreenBottomBand,
  cropBottomBand,
  type GreenBandReport,
} from "@/lib/recording";

/**
 * Confidence threshold at/above which a detected green sharing-bar is
 * cropped AUTOMATICALLY (before the take is uploaded), rather than waiting
 * for the user to click "Crop bottom bar". The detector's confidence is
 * "how many probe frames agreed, scaled by how consistent the band height
 * was" — a rock-stable strip across all three probes scores ~1.0, which is
 * exactly the baked-in Chrome toolbar we want gone. Below this threshold
 * the detection is too uncertain to act on silently, so we fall back to the
 * opt-in button. Audio-loss is still surfaced with a Revert affordance, so
 * "automatic" never means "irreversible".
 */
const AUTO_CROP_MIN_CONFIDENCE = 0.8;

/**
 * Post-recording take review. Shows the recorded clip with two paths:
 *  - "Use this take" → uploads + creates project + redirects to editor.
 *  - "Discard & re-record" → throws away the blob and returns to setup.
 *
 * When the captured surface was a browser tab, we run a heuristic
 * green-bottom-band detector against the blob to catch Chrome's
 * sharing-controls strip (the "green bar" bug). A HIGH-confidence band is
 * cropped automatically before upload (the stored recording is clean, so a
 * full-frame "Source" export never shows the strip). A lower-confidence
 * band falls back to an opt-in "Crop bottom bar" button. Either way the
 * original is recoverable via Revert if the crop drops audio.
 *
 * No trimming or scrub-edits here — those belong in the editor proper.
 */
export function RecordingPreview({
  blob,
  durationSeconds,
  width,
  height,
  displaySurface,
  onDiscard,
  onUse,
  onReplaceBlob,
  uploading,
  uploadPct,
  error,
}: {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
  displaySurface: "monitor" | "window" | "browser" | null;
  onDiscard: () => void;
  onUse: () => void;
  /** Replace the live preview blob with a corrected version (e.g. after crop). */
  onReplaceBlob: (next: Blob, info: { width: number; height: number }) => void;
  uploading: boolean;
  uploadPct: number | null;
  error: string | null;
}) {
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
  // We also skip if the user has already accepted a crop (band detection on
  // the cropped blob would just thrash).
  const [bandReport, setBandReport] = React.useState<GreenBandReport | null>(null);
  const [bandChecked, setBandChecked] = React.useState(false);
  const [cropped, setCropped] = React.useState(false);
  const [cropping, setCropping] = React.useState(false);
  const [cropPct, setCropPct] = React.useState<number | null>(null);
  const [cropError, setCropError] = React.useState<string | null>(null);
  /** True if the user explicitly chose "Keep original" — silences the warning. */
  const [keptOriginal, setKeptOriginal] = React.useState(false);
  /**
   * One-shot latch so auto-crop fires at most once per blob. Without it, a
   * FAILED auto-crop would toggle `cropping` false→true and re-trigger the
   * effect forever. Reset per-blob in the detection effect below.
   */
  const [autoCropAttempted, setAutoCropAttempted] = React.useState(false);
  /** Did the cropped output retain an audio track? `null` until crop runs. */
  const [audioPreserved, setAudioPreserved] = React.useState<boolean | null>(null);
  /**
   * Snapshot of the input blob + dims taken right before crop replaces them
   * upstream. Used to power the "revert to original" affordance, which only
   * appears if the cropped output lost its audio.
   */
  const [originalSnapshot, setOriginalSnapshot] = React.useState<
    { blob: Blob; width: number; height: number } | null
  >(null);

  React.useEffect(() => {
    // Reset health-check state whenever a new blob arrives. We deliberately
    // do NOT reset `cropped`, `keptOriginal`, `audioPreserved`, or
    // `originalSnapshot` here — those describe a *decision the user made*
    // and need to persist across the blob swap that crop/revert triggers.
    setBandReport(null);
    setBandChecked(false);
    setCropError(null);
    // `autoCropAttempted` is per-blob: a fresh take (or the cropped output
    // swapped in) is a new blob and deserves its own single auto-crop shot.
    setAutoCropAttempted(false);
    if (displaySurface !== "browser") {
      setBandChecked(true);
      return;
    }
    let cancelled = false;
    detectGreenBottomBand(blob)
      .then((report) => {
        if (cancelled) return;
        setBandReport(report);
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

  // High-confidence bands are cropped automatically; lower-confidence ones
  // fall back to the manual opt-in warning below.
  const autoCropEligible =
    bandReport?.detected === true &&
    bandReport.confidence >= AUTO_CROP_MIN_CONFIDENCE;

  // Manual opt-in warning shows for lower-confidence bands, OR when a
  // high-confidence auto-crop was attempted and failed (so the user still
  // has a way to retry or knowingly keep the original).
  const autoCropFailed = autoCropEligible && autoCropAttempted && !!cropError;
  const showBandWarning =
    bandChecked &&
    bandReport?.detected === true &&
    !cropped &&
    !keptOriginal &&
    (!autoCropEligible || autoCropFailed);

  /**
   * Best-effort guess at whether the source recording even had audio. We use
   * it to decide whether "no audio in the cropped output" is worth warning
   * about — if the user disabled mic + system audio, a muted crop is fine.
   * The crop function reports `audioPreserved` directly; this is just the
   * pre-flight sanity for *expected* audio.
   */
  const sourceProbablyHadAudio = (() => {
    const type = blob.type.toLowerCase();
    // Heuristic: every MIME we record into has an audio codec stub
    // ("...,mp4a..." or "...,opus") when audio was wired up. If neither
    // appears, the source is video-only and we shouldn't fearmonger.
    return /opus|mp4a|aac/.test(type);
  })();

  const handleKeepOriginal = React.useCallback(() => {
    setKeptOriginal(true);
  }, []);

  const handleCrop = React.useCallback(async () => {
    if (!bandReport || !bandReport.detected) return;
    setCropping(true);
    setCropPct(0);
    setCropError(null);
    // Snapshot the current (uncropped) blob *before* we hand the crop off,
    // so a later "Revert to original" can put it back. The provider's
    // replaceResultBlob is one-way from its side — we hold the source-of-
    // truth for revert here in the preview.
    const snapshot = { blob, width: bandReport.videoWidth, height: bandReport.videoHeight };
    try {
      const result = await cropBottomBand(
        blob,
        bandReport.bandHeightPx,
        (p) => setCropPct(p.pct)
      );
      setOriginalSnapshot(snapshot);
      setAudioPreserved(result.audioPreserved);
      onReplaceBlob(result.blob, {
        width: bandReport.videoWidth,
        height: bandReport.videoHeight - bandReport.bandHeightPx,
      });
      setCropped(true);
    } catch (err) {
      setCropError(
        err instanceof Error
          ? err.message
          : "Couldn't crop the bottom bar. You can still use the take as-is."
      );
    } finally {
      setCropping(false);
      setCropPct(null);
    }
  }, [bandReport, blob, onReplaceBlob]);

  // Auto-crop: when a high-confidence sharing-bar is detected, slice it off
  // automatically before the take is uploaded. Guards mirror handleCrop's
  // preconditions plus the user's decisions (cropped / keptOriginal) so a
  // manual Revert isn't immediately undone by a re-trigger. Runs at most
  // once per detected band — once `cropped` flips true the guard holds.
  React.useEffect(() => {
    if (!bandChecked || !autoCropEligible) return;
    if (cropped || cropping || keptOriginal || autoCropAttempted) return;
    setAutoCropAttempted(true);
    void handleCrop();
  }, [
    bandChecked,
    autoCropEligible,
    cropped,
    cropping,
    keptOriginal,
    autoCropAttempted,
    handleCrop,
  ]);

  const handleRevert = React.useCallback(() => {
    if (!originalSnapshot) return;
    onReplaceBlob(originalSnapshot.blob, {
      width: originalSnapshot.width,
      height: originalSnapshot.height,
    });
    setCropped(false);
    setAudioPreserved(null);
    setOriginalSnapshot(null);
    // Suppress the warning banner so the user isn't re-prompted to crop
    // immediately after they consciously chose to back out.
    setKeptOriginal(true);
  }, [originalSnapshot, onReplaceBlob]);

  const showAudioDroppedWarning =
    cropped && audioPreserved === false && sourceProbablyHadAudio;

  const sizeMB = (blob.size / (1024 * 1024)).toFixed(1);

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
          {url && (
            <video
              src={url}
              controls
              autoPlay
              muted
              loop
              className="aspect-video w-full"
            />
          )}
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
            {width && height ? `${width} × ${height}` : "—"}
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

      {/* Auto-crop in progress — a high-confidence sharing-bar was found and
          is being sliced off automatically before upload. Shown instead of
          the opt-in warning so the user understands why the action buttons
          are briefly disabled. */}
      {autoCropEligible && cropping && !cropped && (
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-violet-400/30 bg-violet-500/[0.08] px-4 py-3 text-left text-sm text-violet-100">
          <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-violet-300" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-violet-50">
              Removing the captured browser sharing bar…
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-violet-100/85">
              Detected a {bandReport?.bandHeightPx}px green strip along the
              bottom of your take and we&apos;re cropping it out automatically
              {cropPct !== null ? ` — ${Math.round(cropPct * 100)}%` : ""}. This
              re-processes the video and may take about as long as the recording.
            </p>
          </div>
        </div>
      )}

      {/* Sharing-bar health warning. Heuristic: a strong solid green band
          along the bottom of the captured frame is Chrome's tab-share strip
          (or, occasionally, a green footer on the captured page). We never
          modify the recorded blob silently — the user opts in via the crop
          button below. Detection only runs when displaySurface === "browser",
          so window / monitor takes never see this banner. */}
      {showBandWarning && (
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-300/40 bg-amber-400/[0.08] px-4 py-3 text-left text-sm text-amber-100">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-amber-50">
              A green browser sharing bar may have been captured.
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-amber-100/85">
              Detected a {bandReport?.bandHeightPx}px solid-green band along the
              bottom of your take. Try recording a window or full screen next
              time for the cleanest result. We won&apos;t change this recording
              unless you ask.
            </p>
            {/* Explicit duration disclosure — the crop is a real-time
                re-encode, so on long takes this is a meaningful wait. We
                put it up here, BEFORE the buttons, so the user is informed
                before they choose, not after they've kicked it off. */}
            <p className="mt-2 text-[11.5px] leading-relaxed text-amber-100/75">
              Cropping re-processes the video and may take about as long as
              the recording.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleKeepOriginal}
                disabled={cropping || uploading}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-3.5 text-[12px] font-semibold text-white/85 transition-colors duration-150 hover:border-white/30 hover:text-white disabled:opacity-60"
              >
                Keep original
              </button>
              <button
                type="button"
                onClick={handleCrop}
                disabled={cropping || uploading}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-400/15 px-3.5 text-[12px] font-semibold text-amber-50 transition-colors duration-150 hover:border-amber-300/70 hover:bg-amber-400/25 disabled:opacity-60"
              >
                {cropping ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Scissors size={12} />
                )}
                {cropping
                  ? cropPct !== null
                    ? `Cropping… ${Math.round(cropPct * 100)}%`
                    : "Cropping…"
                  : "Crop bottom bar"}
              </button>
            </div>
            {cropError && (
              <p className="mt-2 text-[12px] text-rose-200">{cropError}</p>
            )}
          </div>
        </div>
      )}

      {/* Success banner after a crop has landed. We elevate this from a
          subtle chip to a full banner because it signals a real change to
          what will be uploaded — not just an indicator. */}
      {cropped && (
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-400/[0.08] px-4 py-3 text-left text-sm text-emerald-100">
          <Check size={16} className="mt-0.5 shrink-0 text-emerald-300" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-emerald-50">
              Cropped version is now being used for upload/editing.
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-emerald-100/80">
              The bottom band has been removed from the take you&apos;re about
              to send. The original recording on this page has been replaced.
            </p>
          </div>
        </div>
      )}

      {/* Audio-loss warning, only when (a) the crop completed, (b) the
          re-encoded output has no audio track, and (c) the source plausibly
          had audio in the first place (so we don't nag on muted captures).
          The "Revert to original" button is the explicit out the user is
          promised by the copy. */}
      {showAudioDroppedWarning && (
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/[0.08] px-4 py-3 text-left text-sm text-rose-100">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-rose-50">
              Cropped video may not include audio.
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-rose-100/85">
              This browser couldn&apos;t carry the audio track through the crop.
              You can keep the original recording instead.
            </p>
            <div className="mt-2.5">
              <button
                type="button"
                onClick={handleRevert}
                disabled={uploading || cropping}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-rose-300/50 bg-rose-400/15 px-3.5 text-[12px] font-semibold text-rose-50 transition-colors duration-150 hover:border-rose-300/70 hover:bg-rose-400/25 disabled:opacity-60"
              >
                <RefreshCcw size={12} />
                Revert to original
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onDiscard}
          disabled={uploading || cropping}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-6 text-sm text-fog transition-colors duration-200 hover:border-white/25 hover:text-white disabled:opacity-50"
        >
          <RefreshCcw size={14} />
          Discard &amp; re-record
        </button>
        <button
          type="button"
          onClick={onUse}
          disabled={uploading || cropping}
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
