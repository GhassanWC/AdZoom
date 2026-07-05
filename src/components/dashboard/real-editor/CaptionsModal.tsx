"use client";

import * as React from "react";
import { Captions as CaptionsIcon, Loader2, Check } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentOption } from "@/components/ui/SegmentedControl";
import { SpokenLanguagePicker } from "./SpokenLanguagePicker";
import { useEditorReal } from "./context";
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
 * The DEDICATED "Generate AI Captions" dialog — the only automatic caption
 * entry point. Lets the user pick spoken language, caption style, and position;
 * shows the caption quota (monthly usage + estimate for this video); and calls
 * the captions-only endpoint (reuses an existing transcript free when possible,
 * else reserves quota + dispatches ASR). It never runs Gemini or the full
 * analysis. When valid AI captions already exist it doesn't offer generation
 * (the toolbar button is disabled) — this dialog is the create flow.
 */
export function CaptionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { project, generateCaptions } = useEditorReal();
  const usage = useCaptionUsage();
  const toast = useToast();

  const [mode, setMode] = React.useState<TranscriptLanguageMode>("auto");
  const [code, setCode] = React.useState<string | undefined>(undefined);
  const [stylePreset, setStylePreset] = React.useState<OverlayTextPreset>("clean");
  const [position, setPosition] = React.useState<CaptionPosition>("bottom");
  const [busy, setBusy] = React.useState(false);
  // Set when the user dismisses via "Run in background" while a job is in
  // flight — the request keeps running server-side (we never abort it); the
  // toolbar button + Captions card then show the live "processing" state and
  // captions appear on the timeline via the Firestore subscription.
  const backgroundedRef = React.useRef(false);

  const videoDuration = project.duration ?? 0;
  const moments = project.analysis?.detectedMoments ?? [];
  const transcript = project.analysis?.transcript ?? null;
  const status = resolveAiCaptionStatus({
    moments,
    transcript,
    currentSourceFingerprint: projectSourceFingerprint(project),
  });

  const perVideoBlocked = exceedsCaptionVideoLimit(usage.plan, videoDuration);
  const requiredSeconds = requiredCaptionSeconds(videoDuration);
  const exhausted =
    !perVideoBlocked && !usage.loading && usage.remainingSeconds < requiredSeconds;
  const blocked = perVideoBlocked || exhausted;
  const upgradeTarget = usage.plan === "free" ? "Pro" : usage.plan === "pro" ? "Creator" : null;

  // Regenerating when AI captions already exist is a FRESH ASR run: force it so
  // the server drops the old AI captions, reserves + commits quota (counts the
  // minutes), and re-transcribes — never a free reuse. A first generation
  // (none yet) may still reuse an existing transcript for free.
  const isRegenerate = status.hasAiCaptions;

  const run = async () => {
    if (blocked || busy) return;
    setBusy(true);
    backgroundedRef.current = false;
    try {
      const result = await generateCaptions({ mode, code, stylePreset, position, force: isRegenerate });
      // If the user already backgrounded it, they got the "generating in the
      // background" toast — only surface a terminal error/quota block here so
      // it isn't silently lost; success is confirmed by captions appearing.
      if (result.status === "blocked" || result.status === "error" || result.status === "unavailable") {
        toast.error("Captions", result.message);
      } else if (backgroundedRef.current) {
        // already acknowledged on background-dismiss
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
      if (!backgroundedRef.current) onClose();
    } finally {
      setBusy(false);
    }
  };

  // Dismiss now and let the in-flight job finish in the background.
  const runInBackground = () => {
    backgroundedRef.current = true;
    toast.info(
      "Captions",
      "Generating in the background — captions will appear on the timeline when ready."
    );
    onClose();
  };

  return (
    <EditorSheet
      open={open}
      onClose={onClose}
      title="Generate AI Captions"
      subtitle="Transcribe the video's speech and add subtitle captions. This uses your caption minutes — separate from AI edits and export minutes."
      icon={<CaptionsIcon size={17} />}
      size="default"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] text-fog/80">
            {!usage.loading &&
              `${usage.usedMinutes} of ${usage.allowanceMinutes} caption minutes used · ${usage.remainingMinutes} remaining`}
          </span>
          <div className="flex items-center gap-2">
            {busy ? (
              // While a job runs, the secondary action lets the user leave —
              // transcription keeps going and the toolbar shows its progress.
              <Button variant="ghost" size="sm" onClick={runInBackground}>
                Run in background
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => void run()}
              disabled={blocked || busy}
              leftIcon={busy ? <Loader2 size={14} className="animate-spin" /> : <CaptionsIcon size={14} />}
            >
              {busy ? "Generating…" : isRegenerate ? "Regenerate captions" : "Generate captions"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-7 px-6 py-6">
        {/* Quota + estimate */}
        <section className="space-y-2">
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
            videoDuration > 0 && (
              <p className="text-[11.5px] leading-relaxed text-fog/70">
                This video will use approximately {estimateCaptionMinutes(videoDuration)} caption
                minutes.
              </p>
            )
          )}
          {status.hasAiCaptions && (
            <p className="inline-flex items-center gap-1.5 text-[11.5px] text-amber-200/90">
              <Check size={12} />
              {status.aiCaptionCount} AI caption{status.aiCaptionCount === 1 ? "" : "s"} already
              exist — regenerating replaces them and uses caption minutes.
            </p>
          )}
        </section>

        {/* Spoken language */}
        <section className="space-y-2 border-t border-white/[0.06] pt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Spoken language
          </h3>
          <p className="text-[11.5px] leading-relaxed text-fog/80">
            The language spoken in the video. Framevo transcribes + captions in this language — it
            never translates. Pick it for reliable captions (e.g. Arabic); Auto Detect guesses from
            a small candidate list.
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

        {/* Style + position */}
        <section className="space-y-4 border-t border-white/[0.06] pt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Caption style
          </h3>
          <div className="space-y-3">
            <SegmentedControl
              ariaLabel="Caption style"
              value={stylePreset}
              onChange={setStylePreset}
              options={STYLE_OPTS}
            />
            <SegmentedControl
              ariaLabel="Caption position"
              value={position}
              onChange={setPosition}
              options={POSITION_OPTS}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-fog/70">
            You can restyle or reposition individual captions later from the timeline — restyling
            never uses caption minutes.
          </p>
        </section>
      </div>
    </EditorSheet>
  );
}
