"use client";

import * as React from "react";
import { Captions as CaptionsIcon, Loader2, Check, Languages, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentOption } from "@/components/ui/SegmentedControl";
import { SpokenLanguagePicker } from "./SpokenLanguagePicker";
import { useEditorReal } from "./context";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useCaptionUsage } from "@/lib/usage/useCaptionUsage";
import {
  captionAllowanceLabel,
  estimateCaptionMinutes,
  exceedsCaptionVideoLimit,
  perVideoCaptionLimitMessage,
  requiredCaptionSeconds,
  CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE,
} from "@/lib/usage/caption-quota";
import { resolveAiCaptionStatus, projectSourceFingerprint } from "@/lib/analysis/ai-caption-status";
import type { TranscriptLanguageMode } from "@/lib/transcript/language";
import type { CaptionPosition, OverlayTextPreset } from "@/lib/firebase/schema";
import { useToast } from "@/components/ui/Toast";

const STYLE_OPTS: SegmentOption<OverlayTextPreset>[] = [
  { value: "clean", label: "Clean" },
  { value: "bold_social", label: "Bold" },
  { value: "minimal", label: "Minimal" },
  { value: "podcast", label: "Podcast" },
  { value: "tutorial", label: "Tutorial" },
];
const POSITION_OPTS: SegmentOption<CaptionPosition>[] = [
  { value: "bottom", label: "Bottom" },
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
];

/**
 * Docked "Captions" panel — the ONLY automatic caption entry point. When no AI
 * captions exist it offers generation (language + style + quota); once they
 * exist it disables generation ("AI Captions Generated") and surfaces the
 * manage actions: Retranscribe, Change language, Delete. Reuses the shared
 * context caption flow (generateCaptions / retranscribe / deleteAiCaptions) —
 * no duplicate caption state. Never runs Gemini / the full analysis.
 */
export function RealCaptionsPanel() {
  const { project, generateCaptions, retranscribe, deleteAiCaptions } = useEditorReal();
  const usage = useCaptionUsage();
  const toast = useToast();
  const confirm = useConfirm();

  const [mode, setMode] = React.useState<TranscriptLanguageMode>("auto");
  const [code, setCode] = React.useState<string | undefined>(undefined);
  const [stylePreset, setStylePreset] = React.useState<OverlayTextPreset>("clean");
  const [position, setPosition] = React.useState<CaptionPosition>("bottom");
  const [busy, setBusy] = React.useState(false);

  const videoDuration = project.duration ?? 0;
  const status = resolveAiCaptionStatus({
    moments: project.analysis?.detectedMoments,
    transcript: project.analysis?.transcript,
    currentSourceFingerprint: projectSourceFingerprint(project),
  });

  const perVideoBlocked = exceedsCaptionVideoLimit(usage.plan, videoDuration);
  const requiredSeconds = requiredCaptionSeconds(videoDuration);
  const exhausted =
    !perVideoBlocked && !usage.loading && usage.remainingSeconds < requiredSeconds;
  const blocked = perVideoBlocked || exhausted;
  const upgradeTarget = usage.plan === "free" ? "Pro" : usage.plan === "pro" ? "Creator" : null;

  const processing = status.state === "processing";
  const hasCaptions = status.hasAiCaptions;

  const generate = async () => {
    if (blocked || busy || hasCaptions) return;
    setBusy(true);
    try {
      const result = await generateCaptions({ mode, code, stylePreset, position, force: false });
      if (["blocked", "error", "unavailable"].includes(result.status)) {
        toast.error("Captions", result.message);
      } else if (result.status === "exists") {
        toast.info("Captions", result.message);
      } else {
        toast.success(
          "Captions",
          result.status === "processing"
            ? "Generating captions — they'll appear on the timeline shortly."
            : result.message || "Captions added."
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const applyRetranscribe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retranscribe({ mode, code });
      toast.success("Captions", "Retranscribing — updated captions will appear shortly.");
    } catch (err) {
      toast.error("Captions", err instanceof Error ? err.message : "Retranscribe failed.");
    } finally {
      setBusy(false);
    }
  };

  const removeCaptions = async () => {
    const ok = await confirm({
      title: "Delete AI captions?",
      message:
        "This removes every AI-generated caption from the timeline. Your manual captions are untouched.",
      confirmLabel: "Delete captions",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteAiCaptions();
      toast.success("Captions", "AI captions deleted.");
    } catch (err) {
      toast.error("Captions", err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 px-4 py-4">
      {/* Status */}
      <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="flex items-center gap-2">
          {processing ? (
            <Loader2 size={15} className="shrink-0 animate-spin text-violet-300" />
          ) : hasCaptions ? (
            <Check size={15} className="shrink-0 text-emerald-400" />
          ) : (
            <CaptionsIcon size={15} className="shrink-0 text-fog" />
          )}
          <span className="text-[13px] font-medium text-white">
            {processing
              ? "Generating AI Captions…"
              : hasCaptions
                ? "AI Captions Generated"
                : "No AI captions yet"}
          </span>
        </div>
        {hasCaptions && !processing && (
          <p className="mt-1 pl-[23px] text-[11.5px] text-fog">
            {status.aiCaptionCount} caption{status.aiCaptionCount === 1 ? "" : "s"} on the timeline —
            restyle or reposition any of them from the timeline.
          </p>
        )}
      </section>

      {/* Spoken language — used by both generate + change-language/retranscribe. */}
      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
          Spoken language
        </h3>
        <p className="text-[11.5px] leading-relaxed text-fog/80">
          Framevo transcribes + captions in this language — it never translates. Pick it for
          reliable captions; Auto Detect guesses.
        </p>
        <SpokenLanguagePicker
          mode={mode}
          code={code}
          onChange={(m, c) => {
            setMode(m);
            setCode(c);
          }}
        />
      </section>

      {/* Style + position (only meaningful for a fresh generation). */}
      {!hasCaptions && (
        <section className="space-y-3 border-t border-white/[0.06] pt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Caption style
          </h3>
          <SegmentedControl ariaLabel="Caption style" value={stylePreset} onChange={setStylePreset} options={STYLE_OPTS} />
          <SegmentedControl ariaLabel="Caption position" value={position} onChange={setPosition} options={POSITION_OPTS} />
          <p className="text-[11px] leading-relaxed text-fog/70">
            You can restyle or reposition individual captions later from the timeline.
          </p>
        </section>
      )}

      {/* Quota */}
      <section className="space-y-1.5 border-t border-white/[0.06] pt-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
          Caption minutes
        </h3>
        <p className="text-[11.5px] leading-relaxed text-fog/80">
          {captionAllowanceLabel(usage.plan)} · up to {Math.round(usage.maxVideoSeconds / 60)} minutes
          per video.
        </p>
        {perVideoBlocked ? (
          <p className="text-[11.5px] leading-relaxed text-amber-200/90">
            {perVideoCaptionLimitMessage(usage.plan)}{" "}
            {upgradeTarget && (
              <a href="/pricing" className="font-medium text-violet-300 hover:text-violet-200">
                Upgrade to {upgradeTarget}
              </a>
            )}
          </p>
        ) : exhausted ? (
          <p className="text-[11.5px] leading-relaxed text-amber-200/90">
            {CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE}{" "}
            {upgradeTarget && (
              <a href="/pricing" className="font-medium text-violet-300 hover:text-violet-200">
                Upgrade to {upgradeTarget}
              </a>
            )}
          </p>
        ) : (
          videoDuration > 0 &&
          !hasCaptions && (
            <p className="text-[11.5px] leading-relaxed text-fog/70">
              This video will use approximately {estimateCaptionMinutes(videoDuration)} caption minutes.
            </p>
          )
        )}
        {!usage.loading && (
          <p className="text-[11px] text-fog/70">
            {usage.usedMinutes} of {usage.allowanceMinutes} minutes used · {usage.remainingMinutes}{" "}
            remaining
          </p>
        )}
      </section>

      {/* Primary + manage actions */}
      <section className="space-y-2 border-t border-white/[0.06] pt-5">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => void generate()}
          disabled={blocked || busy || processing || hasCaptions}
          leftIcon={busy && !processing ? <Loader2 size={14} className="animate-spin" /> : <CaptionsIcon size={14} />}
        >
          {processing
            ? "Generating AI Captions…"
            : hasCaptions
              ? "AI Captions Generated"
              : busy
                ? "Generating…"
                : "Generate AI Captions"}
        </Button>

        {(hasCaptions || (project.analysis?.transcript && !processing)) && (
          <div className="grid grid-cols-1 gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center"
              onClick={() => void applyRetranscribe()}
              disabled={busy || processing}
              leftIcon={<RefreshCw size={13} />}
            >
              Retranscribe / change language
            </Button>
            {hasCaptions && (
              <Button
                variant="danger"
                size="sm"
                className="w-full justify-center"
                onClick={() => void removeCaptions()}
                disabled={busy || processing}
                leftIcon={<Trash2 size={13} />}
              >
                Delete AI captions
              </Button>
            )}
          </div>
        )}
        <p className="inline-flex items-start gap-1.5 text-[11px] leading-relaxed text-fog/70">
          <Languages size={12} className="mt-0.5 shrink-0" />
          Retranscribe re-runs ASR with the language above and replaces the current AI captions
          (uses caption minutes).
        </p>
      </section>
    </div>
  );
}
