"use client";

/**
 * AI Edit Recipe summary — a compact, honest readout of the recipe that drove
 * this analysis. Shows the chosen type, the edits that were actually APPLIED
 * (the implemented cut / zoom / speed engines, with live counts from the
 * timeline), and the edits that are PLANNED (declared by the recipe but not yet
 * executed). Planned edits are visually distinct so they're never mistaken for
 * applied ones. Renders nothing for projects analyzed before recipes existed.
 */
import * as React from "react";
import { Sparkles, Check, Clock, Captions as CaptionsIcon, AudioLines, Loader2, Languages, RotateCcw } from "lucide-react";
import {
  CATEGORY_LABELS,
  IMPLEMENTED_CATEGORIES,
  type EditOperationCategory,
  type EditRecipePlan,
} from "@/lib/analysis/edit-recipe";
import { VIDEO_TYPE_META } from "@/lib/analysis/video-type";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { estimateCaptionMinutes } from "@/lib/usage/caption-quota";
import { CAPTION_STATE_LABEL, resolveCaptionState } from "@/lib/analysis/caption-state";
import { SpokenLanguagePicker } from "./SpokenLanguagePicker";
import {
  transcriptLanguageLabel,
  type TranscriptLanguageMode,
} from "@/lib/transcript/language";
import type { AudioAnalysis, DetectedMoment, Transcript } from "@/lib/firebase/schema";

/** Human name for a transcript provider id. */
function providerLabel(id: string | undefined): string | null {
  if (!id) return null;
  if (id === "google_speech") return "Google Speech-to-Text";
  return id;
}

/** Which timeline effectTypes each recipe category maps onto (for live counts). */
const CATEGORY_EFFECTS: Partial<Record<EditOperationCategory, ReadonlySet<string>>> = {
  cut: new Set(["cut"]),
  zoom: new Set(["zoom", "click-highlight", "cursor-focus"]),
  speed: new Set(["speed-up"]),
  hook_text: new Set(["hook-text"]),
  text_overlay: new Set(["text-overlay"]),
  callout: new Set(["callout"]),
  branding: new Set(["branding-cta"]),
  smart_crop: new Set(["smart-crop"]),
  transition: new Set(["transition"]),
  captions: new Set(["captions"]),
  blur_redaction: new Set(["blur-redaction"]),
};

/** Count moments actually on the timeline for a recipe category. */
function countForCategory(cat: EditOperationCategory, moments: DetectedMoment[]): number {
  const set = CATEGORY_EFFECTS[cat];
  if (!set) return 0;
  return moments.filter((m) => m.effectType && set.has(m.effectType)).length;
}

export function RecipeSummary({
  recipe,
  moments,
  transcript,
  audioAnalysis,
}: {
  recipe: EditRecipePlan;
  moments: DetectedMoment[];
  transcript?: Transcript;
  audioAnalysis?: AudioAnalysis;
}) {
  const { retranscribe, analyzing, project } = useEditorReal();
  const confirm = useConfirm();
  // "Wrong language?" inline picker — re-transcribes the same video in a chosen
  // spoken language without re-uploading.
  const [langFixOpen, setLangFixOpen] = React.useState(false);
  const [fixMode, setFixMode] = React.useState<TranscriptLanguageMode>("selected");
  const [fixCode, setFixCode] = React.useState<string | undefined>(undefined);

  // Retranscription is a NEW ASR run and consumes caption minutes — always
  // confirm with the estimated cost first (never silently spend a second
  // allowance). The server still enforces the real quota.
  const confirmRetranscribe = async () => {
    const durationSec = project.duration ?? 0;
    const ok = await confirm({
      title: "Re-transcribe this video?",
      message:
        durationSec > 0
          ? `Retranscribing this video will use approximately ${estimateCaptionMinutes(durationSec)} caption minutes.`
          : "Retranscribing this video will use caption minutes from your monthly allowance.",
      confirmLabel: "Re-transcribe",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setLangFixOpen(false);
    void retranscribe({ mode: fixMode, code: fixCode });
  };
  // Applied = implemented, recipe-enabled categories that ACTUALLY produced
  // edits on the timeline (count > 0). This is the honest bar: a category is
  // shown as applied only when it really ran + is export-supported — never just
  // because the recipe wanted it. Deduped (a type can list a category twice).
  // Captions are NOT counted as an AI-edit category — they're a separate
  // transcription feature with their own card, state, and quota below.
  const appliedCats = Array.from(
    new Set(
      recipe.operations
        .filter(
          (o) =>
            o.category !== "captions" &&
            IMPLEMENTED_CATEGORIES.has(o.category) &&
            o.enabled &&
            !o.planned
        )
        .map((o) => o.category)
    )
  )
    .map((category) => ({ category, count: countForCategory(category, moments) }))
    .filter((a) => a.count > 0);
  const appliedTotal = appliedCats.reduce((n, a) => n + a.count, 0);
  const captionCount = countForCategory("captions", moments);

  // Planned = declared-but-not-executed categories (music, blur …), captions
  // excluded (their card owns caption state). Also includes any
  // implemented-but-not-yet-generated category so the user never sees it
  // counted as applied. Dedupe.
  const planned: EditOperationCategory[] = Array.from(
    new Set(
      recipe.operations
        .filter(
          (o) =>
            o.category !== "captions" &&
            (o.planned || (o.enabled && countForCategory(o.category, moments) === 0))
        )
        .map((o) => o.category)
    )
  );

  // ── Caption state — derived from the run's captions preference + the
  // transcript lifecycle, NEVER from the main analysis status. ─────────────
  const lastRun = project.analysis?.lastRunOptions as { generateCaptions?: boolean } | undefined;
  const captionsRequested = lastRun?.generateCaptions !== false;
  const captionState = resolveCaptionState({ captionsRequested, transcript });

  const requestedLabel = VIDEO_TYPE_META[recipe.requestedVideoType]?.label;
  const effectiveLabel =
    VIDEO_TYPE_META[recipe.effectiveVideoType]?.label ?? recipe.recipeName;
  const autoResolved =
    recipe.requestedVideoType === "auto" &&
    recipe.effectiveVideoType !== "auto";

  return (
    // TWO distinct cards: the AI EDIT (recipe + applied edit categories) and
    // CAPTIONS (transcription state + quota + language) — separate features
    // with separate states, so they never read as one thing.
    <section className="mt-4 space-y-3">
      {/* ══ Card 1 — AI Edit ══════════════════════════════════════════════ */}
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-violet-300" />
          <span className="text-[12.5px] font-semibold tracking-tight text-white/90">
            AI Edit
          </span>
          <span className="inline-flex items-center rounded-md border border-violet-400/25 bg-violet-500/[0.08] px-2 py-0.5 text-[11px] font-medium tracking-tight text-violet-200">
            {effectiveLabel}
          </span>
          {autoResolved && requestedLabel && (
            <span className="text-[11px] text-fog/70">
              auto-detected from “{requestedLabel}”
            </span>
          )}
        </div>
        <span className="text-[11px] text-fog/70">
          {appliedTotal} edit{appliedTotal === 1 ? "" : "s"} generated
        </span>
      </div>

      <p className="mt-2 text-[11.5px] leading-relaxed text-fog">
        {recipe.summary}
      </p>

      {/* Applied — implemented edits that actually ran + export this analysis. */}
      {appliedCats.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-300/80">
            <Check size={11} />
            Applied
          </div>
          <div className="flex flex-wrap gap-1.5">
            {appliedCats.map((a) => (
              <span
                key={a.category}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-500/[0.07] px-2.5 py-1 text-[11.5px] font-medium tracking-tight text-emerald-100"
              >
                {CATEGORY_LABELS[a.category]}
                <span className="rounded bg-emerald-400/15 px-1.5 py-px text-[10.5px] tabular-nums text-emerald-200/90">
                  {a.count}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Planned — declared by the recipe, no timeline effect yet. */}
      {planned.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-fog/60">
            <Clock size={11} />
            Planned
          </div>
          <div className="flex flex-wrap gap-1.5">
            {planned.map((c) => (
              <span
                key={c}
                className="inline-flex items-center rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-1 text-[11.5px] font-medium tracking-tight text-fog/70"
                title="Planned by this recipe — not applied to the preview or export yet."
              >
                {CATEGORY_LABELS[c]}
              </span>
            ))}
          </div>
        </div>
      )}

      </div>

      {/* ══ Card 2 — Captions (transcription) ═════════════════════════════
          A SEPARATE feature with its own state: disabled / processing /
          complete / failed / quota-blocked — independent of the AI edit
          above (which completes either way). */}
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CaptionsIcon size={13} className="text-sky-300" />
            <span className="text-[12.5px] font-semibold tracking-tight text-white/90">
              Captions
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-tight",
                captionState === "complete"
                  ? "border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-100"
                  : captionState === "processing"
                    ? "border-violet-400/25 bg-violet-500/[0.08] text-violet-100"
                    : captionState === "failed"
                      ? "border-rose-400/25 bg-rose-500/[0.06] text-rose-200"
                      : captionState === "blocked_by_quota"
                        ? "border-amber-400/30 bg-amber-500/[0.07] text-amber-100"
                        : "border-white/[0.07] bg-white/[0.02] text-fog"
              )}
            >
              {captionState === "processing" && (
                <Loader2 size={10} className="animate-spin" />
              )}
              {CAPTION_STATE_LABEL[captionState]}
            </span>
          </div>
          {captionState === "complete" && captionCount > 0 && (
            <span className="text-[11px] text-fog/70">
              {captionCount} generated
              {transcript?.language
                ? ` · ${transcriptLanguageLabel(transcript.language) ?? transcript.language}`
                : ""}
            </span>
          )}
        </div>

        {captionState === "disabled" && (
          <p className="mt-2 text-[11px] leading-relaxed text-fog/70">
            Captions are off for this analysis — every other AI edit still generated.
            Turn them on under Captions &amp; transcription when you re-analyze.
          </p>
        )}

      {(transcript || audioAnalysis) && captionState !== "disabled" && (
        <div className="mt-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {/* Spoken-language chip (rule §11): for Auto Detect show the detected
              language; for a selection show the chosen language. (The caption
              STATE lives in the card header pill above.) */}
          {transcript && (transcript.languageMode || transcript.language || transcript.requestedLanguageCode) && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 font-medium text-fog/85"
              title="Spoken language used for transcription (captions stay in this language — never translated)."
            >
              <Languages size={11} className="text-fog/70" />
              {transcript.languageMode === "auto"
                ? `Auto Detect${
                    transcript.language ? ` · Detected: ${transcriptLanguageLabel(transcript.language)}` : ""
                  }`
                : transcriptLanguageLabel(transcript.language ?? transcript.requestedLanguageCode) ?? "Language"}
            </span>
          )}
          {providerLabel(transcript?.provider?.provider) && (
            <span className="inline-flex items-center rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 font-medium text-fog/80">
              {providerLabel(transcript?.provider?.provider)}
            </span>
          )}
          {audioAnalysis && (audioAnalysis.silenceSegments?.length ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 font-medium text-fog"
              title="Silence detected by the audio analysis (silence-removal candidates)."
            >
              <AudioLines size={11} className="text-fog/70" />
              {Math.round(audioAnalysis.totalSilenceSeconds ?? 0)}s silent ·{" "}
              {audioAnalysis.silenceSegments!.length} pause
              {audioAnalysis.silenceSegments!.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {transcript?.status === "processing" && (
          <p className="mt-2 text-[11px] leading-relaxed text-violet-200/80">
            Transcribing in background… captions will appear here when ready. The rest of
            your edit is ready now.
          </p>
        )}
        {transcript?.status === "failed" && (
          <p className="mt-2 text-[11px] leading-relaxed text-rose-200/80">
            Captions were skipped — every other edit was still generated.
            {transcript.error ? ` ${transcript.error}` : ""}
          </p>
        )}
        {captionState === "blocked_by_quota" && (
          <p className="mt-2 text-[11px] leading-relaxed text-amber-200/90">
            {transcript?.error ?? "Caption limit reached for this billing period."}{" "}
            Every other edit still works.{" "}
            <a
              href="/pricing"
              className="font-medium text-violet-300 transition-colors hover:text-violet-200"
            >
              Upgrade for more caption minutes
            </a>
          </p>
        )}
        {captionState === "unavailable" && (
          <p className="mt-2 text-[11px] leading-relaxed text-fog/70">
            {transcript?.error
              ? // A specific skip reason — show it verbatim; every other edit
                // was still generated.
                `Auto-captions were skipped — ${transcript.error} Every other edit still works.`
              : "Auto-captions are off — no transcription provider is configured. Every other edit still works. Enable Speech-to-Text to turn on captions."}
          </p>
        )}
        {transcript?.languageMismatch && (
          <p className="mt-2 text-[11px] leading-relaxed text-amber-200/90">
            The detected transcript may use the wrong language. Use “Wrong language?” to
            re-transcribe — we never silently translate it.
          </p>
        )}

        {/* ── "Wrong language?" — fix the spoken language + re-transcribe ──── */}
        {transcript && transcript.status !== "not_started" && (
          <div className="mt-2.5">
            {!langFixOpen ? (
              <button
                type="button"
                onClick={() => {
                  setFixMode("selected");
                  setFixCode(transcript.language ?? transcript.requestedLanguageCode ?? undefined);
                  setLangFixOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] font-medium text-fog transition-colors duration-150 hover:border-white/20 hover:text-white"
              >
                <Languages size={11} />
                Wrong language?
              </button>
            ) : (
              <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                <p className="text-[11.5px] leading-relaxed text-fog/85">
                  Pick the language actually spoken. Framevo re-transcribes the same video
                  (no re-upload) and replaces the auto-captions — your manual captions stay.
                </p>
                <SpokenLanguagePicker
                  mode={fixMode}
                  code={fixCode}
                  disabled={analyzing}
                  onChange={(m, c) => {
                    setFixMode(m);
                    setFixCode(c);
                  }}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={analyzing || (fixMode === "selected" && !fixCode)}
                    onClick={() => void confirmRetranscribe()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-500/15 px-3 py-1.5 text-[12px] font-semibold text-violet-50 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw size={12} />
                    Re-transcribe
                  </button>
                  <button
                    type="button"
                    onClick={() => setLangFixOpen(false)}
                    className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[12px] font-medium text-fog transition-colors hover:border-white/25 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      )}
      </div>
    </section>
  );
}
