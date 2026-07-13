"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  X,
  AlertCircle,
  Minimize2,
  ChevronDown,
  ChevronUp,
  RefreshCcw,
  Sparkles,
  Loader2,
  Clock,
  AlertTriangle,
  Info,
} from "lucide-react";
import { useEditorReal } from "./context";
import {
  type AnalysisOptions,
  DEFAULT_ANALYSIS_OPTIONS,
} from "@/lib/analysis/engine-layers";
import {
  ANALYSIS_STAGES,
  ERROR_RECOVERY,
  fmtElapsed,
  isProcessing,
} from "@/lib/analysis-stages";
import {
  buildProgressSteps,
  progressHeadline,
  countGeneratedEdits,
  editsProgressLine,
  friendlyActivityFeed,
  type ProgressStep,
  type FriendlyActivity,
} from "@/lib/analysis-progress";
import type {
  AnalysisActivityEvent,
  AnalysisErrorKind,
  SelectedVideoType,
} from "@/lib/firebase/schema";
import { hasDirectorBrief } from "@/lib/director/types";
import { cn } from "@/lib/cn";

const LONG_PROCESS_WARN_MS = 90_000;

export function RealProcessingOverlay() {
  const {
    project,
    startAnalyze,
    cancelAnalyze,
    cvProgress,
    processingMinimized,
    setProcessingMinimized,
    chunkedJob,
    selectedVideoType,
  } = useEditorReal();

  const status = project.status;
  const analysis = project.analysis;
  // The CURRENT run's generation options (written to lastRunOptions at chunk
  // reset) — drives which generation steps the progress UI shows.
  const runOptions = (analysis?.lastRunOptions as AnalysisOptions | undefined) ?? undefined;
  const failed = analysis?.status === "failed" || status === "failed";
  const cancelled = analysis?.status === "cancelled" || status === "cancelled";
  const currentlyProcessing = isProcessing(status);

  // Completion detection — independent of `project.status`, which can lag or be
  // transiently reset by a chunked re-run. Treats the run as DONE when the
  // analysis is terminal, the chunked job is complete, OR the explicit safety
  // fallback holds (all chunks done + moments present + an "Analysis complete"
  // activity). This is what unsticks the overlay when status desyncs.
  const lastActivityComplete = (analysis?.activity ?? []).some((a) =>
    a.text?.includes("Analysis complete")
  );
  const allChunksDone =
    !!chunkedJob &&
    chunkedJob.chunkCount > 0 &&
    chunkedJob.completedCount >= chunkedJob.chunkCount;
  const momentsPresent = (analysis?.detectedMoments?.length ?? 0) > 0;
  const done =
    !failed &&
    !cancelled &&
    (analysis?.status === "complete" ||
      chunkedJob?.status === "complete" ||
      (allChunksDone && momentsPresent && lastActivityComplete));
  // Count ALL edit types (cuts, zooms, speeds, captions, overlays…) — not just zooms.
  const editsCount = countGeneratedEdits(analysis?.detectedMoments);

  // When `done`, the run is no longer processing regardless of a lagging status.
  const effectivelyProcessing = currentlyProcessing && !done;

  // Show the overlay when:
  //   - actively processing AND user hasn't minimized
  //   - terminal failure (so the user sees what happened)
  // After the user closes a failed/cancelled state, hide.
  const [dismissedTerminal, setDismissedTerminal] = React.useState<string | null>(
    null
  );
  React.useEffect(() => {
    // If the user starts a fresh analysis, forget the previous dismissal. Guard
    // on `!done` so a stuck status (processing + done) doesn't re-open the
    // success state right after its auto-dismiss.
    if (currentlyProcessing && !done) setDismissedTerminal(null);
  }, [currentlyProcessing, done]);

  // A success "complete" terminal only pops the overlay when it was already
  // open (not minimized) — when minimized (the chunked default) we just let the
  // pill clear + the navbar "AI analysis ready" notification fire, so we don't
  // interrupt the user mid-edit.
  const terminalKey = failed
    ? `failed:${analysis?.errorKind ?? "unknown"}:${analysis?.completedAt ?? ""}`
    : cancelled
      ? `cancelled:${analysis?.completedAt ?? ""}`
      : done && !processingMinimized
        ? `complete:${analysis?.completedAt ?? chunkedJob?.completedAt ?? "now"}`
        : null;
  const showTerminal = Boolean(terminalKey) && dismissedTerminal !== terminalKey;

  // Auto-dismiss the success state after a short confirmation beat.
  const isCompleteTerminal = showTerminal && done && !failed && !cancelled;
  React.useEffect(() => {
    if (!isCompleteTerminal || !terminalKey) return;
    const t = setTimeout(() => setDismissedTerminal(terminalKey), 2500);
    return () => clearTimeout(t);
  }, [isCompleteTerminal, terminalKey]);

  const visible =
    (effectivelyProcessing && !processingMinimized) || showTerminal;

  // Mount portal only after client-side hydration.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Elapsed time — must be called unconditionally, before any early return.
  const elapsedMs = useTickingElapsed(analysis?.startedAt);
  const estimateSeconds = analysis?.estimateSeconds;
  const longRunning = elapsedMs > LONG_PROCESS_WARN_MS && currentlyProcessing;

  if (!mounted) return null;

  const onMinimize = () => setProcessingMinimized(true);
  const onCloseTerminal = () => terminalKey && setDismissedTerminal(terminalKey);
  const onCancel = async () => {
    await cancelAnalyze();
  };
  const onRetry = async () => {
    setDismissedTerminal(null);
    // Retry with the engine selection from the run that failed, so a disabled
    // layer stays disabled. Falls back to all-on for an older project.
    await startAnalyze(
      (analysis?.lastRunOptions as AnalysisOptions | undefined) ??
        DEFAULT_ANALYSIS_OPTIONS
    );
  };

  const stage = analysis?.stage ?? "Preparing analysis";

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          key="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/85 px-4 py-6 backdrop-blur-2xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            // A flex COLUMN capped to the viewport: the header and the progress /
            // action footer are pinned (`shrink-0`), and only the body between them
            // scrolls. Without the cap the card grew past a short viewport and
            // `overflow-hidden` silently clipped the activity feed and the Cancel
            // button, with no way to reach either.
            className="glass-strong relative flex max-h-[min(88vh,54rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-cinematic"
          >
            {/* close / minimize header */}
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-5 py-3">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-violet-300">
                <Sparkles size={11} />
                Framevo AI
              </div>
              <div className="flex items-center gap-1.5">
                {effectivelyProcessing && (
                  <button
                    onClick={onMinimize}
                    aria-label="Continue in background"
                    title="Continue in background"
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1 text-[11px] font-medium text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
                  >
                    <Minimize2 size={11} />
                    Run in background
                  </button>
                )}
                {showTerminal && !effectivelyProcessing && (
                  <button
                    onClick={onCloseTerminal}
                    aria-label="Close"
                    className="inline-flex size-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* Body. The terminal states are short, but a failure message can be
                long — they scroll inside the card rather than growing it past the
                viewport. ActiveBody manages its own scroll + pinned footer. */}
            {failed ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <FailedBody
                  errorKind={analysis?.errorKind}
                  errorMessage={analysis?.errorMessage}
                  onRetry={onRetry}
                  onClose={onCloseTerminal}
                />
              </div>
            ) : cancelled ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CancelledBody onRetry={onRetry} onClose={onCloseTerminal} />
              </div>
            ) : done ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CompleteBody editsCount={editsCount} onClose={onCloseTerminal} />
              </div>
            ) : (
              <ActiveBody
                videoType={selectedVideoType}
                options={runOptions}
                editsCount={editsCount}
                stage={stage}
                status={status}
                elapsedMs={elapsedMs}
                estimateSeconds={estimateSeconds}
                activity={analysis?.activity ?? []}
                longRunning={longRunning}
                cvProgress={cvProgress}
                onCancel={onCancel}
                onMinimize={onMinimize}
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

// ─── COMPLETE BODY ───────────────────────────────────────────────────────────

function CompleteBody({
  editsCount,
  onClose,
}: {
  editsCount: number;
  onClose: () => void;
}) {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30">
        <Check size={26} strokeWidth={2.5} />
      </div>
      <h3 className="mt-4 font-display text-xl font-semibold tracking-tight text-white">
        Analysis complete
      </h3>
      <p className="mt-1.5 text-sm text-fog">
        {editsCount > 0
          ? `${editsCount} edit${editsCount === 1 ? "" : "s"} on your timeline — ready to refine.`
          : "Your timeline is ready to refine."}
      </p>
      <button
        onClick={onClose}
        className="mt-5 inline-flex items-center gap-1.5 rounded-xl border border-violet-400/35 bg-violet-500/15 px-4 py-2 text-[13px] font-medium text-violet-100 transition-colors duration-200 hover:bg-violet-500/25"
      >
        Start editing
      </button>
    </div>
  );
}

// ─── ACTIVE BODY ─────────────────────────────────────────────────────────────

function ActiveBody({
  videoType,
  options,
  editsCount,
  stage,
  status,
  elapsedMs,
  estimateSeconds,
  activity,
  longRunning,
  cvProgress,
  onCancel,
  onMinimize,
}: {
  videoType: SelectedVideoType;
  options: AnalysisOptions | undefined;
  editsCount: number;
  stage: string;
  status: string | undefined;
  elapsedMs: number;
  estimateSeconds: number | undefined;
  activity: AnalysisActivityEvent[];
  longRunning: boolean;
  cvProgress: number | null;
  onCancel: () => Promise<void>;
  onMinimize: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const { chunkedJob, project } = useEditorReal();
  // The Director step only exists when the user actually wrote a brief AND this
  // run isn't suppressing it — see `GenFlags.director`.
  const directing =
    hasDirectorBrief(project?.directorBrief) && options?.applyDirectorBrief !== false;
  const job =
    chunkedJob && (chunkedJob.status === "running" || chunkedJob.status === "queued")
      ? chunkedJob
      : null;
  const stageIdx = Math.max(
    0,
    ANALYSIS_STAGES.findIndex((s) => s.id === status)
  );
  // During the on-device CV scan, drive the bar from real frame progress.
  const scanning = status === "scanning_frames" && cvProgress !== null;
  const pct = scanning
    ? Math.max(0.02, Math.min(0.99, cvProgress ?? 0))
    : estimateSeconds && estimateSeconds > 0
      ? Math.min(0.97, elapsedMs / (estimateSeconds * 1000))
      : (stageIdx + 1) / ANALYSIS_STAGES.length;
  const estLow = Math.max(15, Math.round((estimateSeconds ?? 60) * 0.7));
  const estHigh = Math.round((estimateSeconds ?? 90) * 1.4);

  // Dynamic, video-type-aware, option-filtered step list. Progress maps onto it
  // so the checklist advances even without per-step server signals.
  const { headline, subtitle } = progressHeadline(videoType);
  const steps: ProgressStep[] = React.useMemo(
    () => buildProgressSteps({ videoType, options, directing }),
    [videoType, options, directing]
  );
  const activeStepIdx = Math.min(steps.length - 1, Math.max(0, Math.floor(pct * steps.length)));
  const activeStep = steps[activeStepIdx];
  const friendly = React.useMemo(() => friendlyActivityFeed(activity), [activity]);

  return (
    // `min-h-0` is what actually lets the scroll container below shrink — a flex
    // child defaults to min-height:auto and would otherwise refuse to be smaller
    // than its content, pushing the pinned footer off-screen instead of scrolling.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Scrolls. Everything that can grow without bound lives in here. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1.05fr_1fr]">
        {/* Left: headline + dynamic step list */}
        <div>
          <h3 className="font-display text-2xl font-semibold tracking-tight text-white">
            {headline}
          </h3>
          <p className="mt-1.5 text-sm text-fog">{subtitle}</p>
          {activeStep && (
            <AnimatePresence mode="wait">
              <motion.p
                key={activeStep.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22 }}
                className="mt-2 text-[13px] font-medium text-violet-200"
              >
                {activeStep.label}…
              </motion.p>
            </AnimatePresence>
          )}

          {job && (
            <div className="mt-4 rounded-xl border border-violet-400/25 bg-violet-500/[0.08] px-4 py-3">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-semibold text-violet-100">
                  Chunk {Math.min(job.completedCount + 1, job.chunkCount)} of{" "}
                  {job.chunkCount}
                  {job.chunkSize > 0 && (
                    <span className="font-normal text-violet-200/70">
                      {" · "}
                      {job.chunkMode === "custom" ? "custom " : ""}
                      {job.chunkSize}s chunks
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums text-violet-200/80">
                  {Math.round(job.progress * 100)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-500"
                  style={{ width: `${Math.max(2, job.progress * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-[11.5px] text-violet-100/80">
                {editsProgressLine(editsCount)}
              </p>
            </div>
          )}

          <ul className="mt-5 space-y-2.5">
            {steps.map((s, i) => {
              const stepDone = i < activeStepIdx;
              const active = i === activeStepIdx;
              return (
                <li key={s.id} className="flex items-start gap-2.5 text-sm">
                  <StageDot done={stepDone} active={active} />
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "text-sm",
                        stepDone && "text-white/85",
                        active && "text-white",
                        !stepDone && !active && "text-fog/70"
                      )}
                    >
                      {s.label}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {/* Captions are NOT part of analysis — they generate via the separate
              "Generate AI Captions" action, so no caption progress appears here. */}
        </div>

        {/* Right: activity feed (friendly labels; technical lives under details) */}
        <div className="flex min-h-0 flex-col">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Activity
            </div>
            <span className="font-mono text-[10px] text-fog">{friendly.length} events</span>
          </div>
          <ActivityFeed activity={friendly} />
        </div>
      </div>

      {/* Expandable details */}
      <AnimatePresence initial={false}>
        {detailsOpen && (
          <motion.div
            key="details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <ProcessingDetails
              status={status}
              stage={stage}
              elapsedMs={elapsedMs}
              estimateSeconds={estimateSeconds}
              activity={activity}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Long-running warning */}
      {longRunning && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2.5 text-xs text-amber-100">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <div className="font-semibold text-amber-200">
              This is taking longer than expected.
            </div>
            <p className="mt-1 leading-relaxed text-amber-100/85">
              Likely causes: very large video, Gemini congestion, or high-resolution file. You can keep waiting or run it in the background while you do something else.
            </p>
          </div>
        </div>
      )}

      </div>

      {/* PINNED. Progress and the escape hatches (background / cancel) must stay
          reachable no matter how long the activity feed grows — they are the two
          things a user reaches for when a run is taking too long, which is exactly
          when the content above them is longest. */}
      <div className="shrink-0 space-y-2 border-t border-white/[0.06] px-6 py-4">
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct * 100}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 shadow-[0_0_16px_rgba(139,92,246,0.6)]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-fog">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
            <Clock size={10} className="text-violet-300" />
            Elapsed{" "}
            <span className="font-mono tabular-nums text-white/85">
              {fmtElapsed(elapsedMs)}
            </span>
          </span>
          {estimateSeconds && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
              <Info size={10} />
              Est.{" "}
              <span className="font-mono tabular-nums text-white/85">
                {estLow}–{estHigh}s
              </span>
            </span>
          )}
          <button
            onClick={() => setDetailsOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5 text-[11px] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
          >
            {detailsOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            Processing details
          </button>
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            onClick={onMinimize}
            className="rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-sm text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
          >
            Continue in background
          </button>
          <button
            onClick={onCancel}
            className="rounded-full border border-rose-400/30 bg-rose-500/[0.06] px-4 py-2 text-sm text-rose-200 transition-colors duration-200 hover:border-rose-400/50 hover:bg-rose-500/[0.12]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function StageDot({ done, active }: { done: boolean; active: boolean }) {
  if (done) {
    return (
      <span className="mt-0.5 inline-flex size-4 items-center justify-center rounded-full bg-violet-500 text-white">
        <Check size={9} />
      </span>
    );
  }
  if (active) {
    return (
      <span className="mt-0.5 inline-flex size-4 items-center justify-center rounded-full border border-violet-400/60 bg-violet-500/15">
        <Loader2 size={9} className="animate-spin text-violet-300" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-flex size-4 items-center justify-center rounded-full border border-white/10" />
  );
}

function ActivityFeed({ activity }: { activity: FriendlyActivity[] }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [activity.length]);

  return (
    <div
      ref={ref}
      className="min-h-[200px] max-h-[260px] overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.015] p-3"
    >
      {activity.length === 0 ? (
        <div className="grid h-full place-items-center text-xs text-fog/70">
          Getting started…
        </div>
      ) : (
        <ul className="space-y-1.5">
          {activity.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="flex items-start gap-2 text-xs">
              <ActivityIcon kind={e.kind} />
              <span className="font-mono text-[10px] text-fog/70">
                {new Date(e.ts).toLocaleTimeString([], {
                  hour12: false,
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span className="min-w-0 flex-1 break-words text-white/85">
                {e.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityIcon({ kind }: { kind: AnalysisActivityEvent["kind"] }) {
  if (kind === "ok") {
    return <Check size={11} className="mt-0.5 shrink-0 text-emerald-400" />;
  }
  if (kind === "warn") {
    return <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-300" />;
  }
  if (kind === "error") {
    return <AlertCircle size={11} className="mt-0.5 shrink-0 text-rose-400" />;
  }
  return <Info size={11} className="mt-0.5 shrink-0 text-fog" />;
}

function ProcessingDetails({
  status,
  stage,
  elapsedMs,
  estimateSeconds,
  activity,
}: {
  status: string | undefined;
  stage: string;
  elapsedMs: number;
  estimateSeconds: number | undefined;
  activity: AnalysisActivityEvent[];
}) {
  const ok = activity.filter((a) => a.kind === "ok").length;
  const errors = activity.filter((a) => a.kind === "error").length;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.015] p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Status" value={status ?? "—"} />
        <Stat label="Stage" value={stage} />
        <Stat label="Elapsed" value={fmtElapsed(elapsedMs)} mono />
        <Stat
          label="Estimate"
          value={estimateSeconds ? `${estimateSeconds}s` : "—"}
          mono
        />
        <Stat label="Events" value={String(activity.length)} mono />
        <Stat label="Success" value={String(ok)} mono />
        <Stat label="Errors" value={String(errors)} mono />
      </div>
      {/* Raw technical log — the full server activity incl. Gemini/infra lines. */}
      {activity.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-white/[0.05] bg-black/20 p-2">
          <ul className="space-y-1">
            {activity.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="flex items-start gap-2 font-mono text-[10px] text-fog/80">
                <span className="shrink-0 text-fog/50">
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="min-w-0 flex-1 break-words">{e.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm text-white/90",
          mono && "font-mono tabular-nums"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── FAILED BODY ────────────────────────────────────────────────────────────

function FailedBody({
  errorKind,
  errorMessage,
  onRetry,
  onClose,
}: {
  errorKind: AnalysisErrorKind | undefined;
  errorMessage: string | undefined;
  onRetry: () => void;
  onClose: () => void;
}) {
  const kind = errorKind ?? "unknown";
  const rec = ERROR_RECOVERY[kind];
  return (
    <div className="p-6">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-rose-400/30 bg-rose-500/10 text-rose-300">
          <AlertCircle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl font-semibold tracking-tight text-white">
            {rec.title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-fog">{rec.reason}</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-violet-400/20 bg-violet-500/[0.06] px-3 py-2.5 text-sm text-violet-100">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">
          What to try
        </span>
        <p className="mt-1 leading-relaxed">{rec.suggestion}</p>
      </div>

      {errorMessage && (
        <details className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-fog">
          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em]">
            Technical details
          </summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-fog/85">
            {errorMessage}
          </pre>
        </details>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-sm text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
        >
          Close
        </button>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-full bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.6)] transition-colors duration-200 hover:bg-violet-500/90"
        >
          <RefreshCcw size={13} />
          Retry analysis
        </button>
      </div>
    </div>
  );
}

// ─── CANCELLED BODY ─────────────────────────────────────────────────────────

function CancelledBody({
  onRetry,
  onClose,
}: {
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="p-6">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-fog">
          <X size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl font-semibold tracking-tight text-white">
            Analysis cancelled
          </h3>
          <p className="mt-1 text-sm text-fog">
            You stopped this run. Your video is still uploaded — you can re-run analysis whenever you're ready.
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-sm text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
        >
          Close
        </button>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-full bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.6)] transition-colors duration-200 hover:bg-violet-500/90"
        >
          <RefreshCcw size={13} />
          Start again
        </button>
      </div>
    </div>
  );
}

// ─── HOOKS ──────────────────────────────────────────────────────────────────

function useTickingElapsed(startedAt?: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, now - startedAt);
}
