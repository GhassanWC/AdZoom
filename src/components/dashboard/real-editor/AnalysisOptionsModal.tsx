"use client";

import * as React from "react";
import { Sparkles, AlertTriangle, RotateCcw, CheckCheck, Ban } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
import { EditorDialogGrid } from "./EditorDialog";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { SegmentedControl, type SegmentOption } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import {
  type AnalysisEnginePrefs,
  type AnalysisOptions,
  type ExistingEditMode,
} from "@/lib/analysis/engine-layers";
import {
  recipeGenerationDefaults,
  resolveInitialGenerationToggles,
  type GenerationToggles,
} from "@/lib/analysis/edit-recipe";
import { VideoTypePicker } from "./VideoTypePicker";
import { SpokenLanguagePicker } from "./SpokenLanguagePicker";
import type { TranscriptLanguageMode } from "@/lib/transcript/language";
import type { SelectedVideoType } from "@/lib/firebase/schema";
import {
  type ChunkMode,
  CHUNK_MODE_SIZES,
  CHUNK_SIZE_MAX_S,
  CHUNK_SIZE_MIN_S,
  chunkCountFor,
  clampChunkSize,
  resolveChunkSize,
} from "@/lib/analysis/chunk-config";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import { useCaptionUsage, type CaptionUsageState } from "@/lib/usage/useCaptionUsage";
import {
  CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE,
  captionAllowanceLabel,
  estimateCaptionMinutes,
  exceedsCaptionVideoLimit,
  perVideoCaptionLimitMessage,
  requiredCaptionSeconds,
} from "@/lib/usage/caption-quota";
import {
  AI_EDIT_GROUPS,
  AI_EDIT_TOGGLE_KEYS,
  AI_EDIT_EXTRA_KEYS,
  CAPTIONS_TOGGLE,
} from "@/lib/analysis/analyze-dialog-config";

const EXISTING_EDIT_OPTIONS: SegmentOption<ExistingEditMode>[] = [
  {
    value: "replace-selected",
    label: "Replace selected layers only",
    badge: "Recommended",
    description:
      "Regenerate just the layers you picked. Your other edits — and anything you made by hand — stay exactly as they are.",
  },
  {
    value: "keep",
    label: "Keep existing and add missing",
    description:
      "Don't touch anything you already have. Only fill in selected layers that are currently empty.",
  },
  {
    value: "clear-all",
    label: "Clear all AI edits and regenerate",
    description:
      "Remove every AI-generated edit (your manual edits are kept), then generate the selected layers fresh.",
  },
];

const DETAIL_OPTIONS: SegmentOption<ChunkMode>[] = [
  { value: "fast", label: "Fast", description: `Faster analysis with fewer chunks. · ${CHUNK_MODE_SIZES.fast}s chunks` },
  { value: "balanced", label: "Balanced", badge: "Recommended", description: `Recommended balance of speed and detail. · ${CHUNK_MODE_SIZES.balanced}s chunks` },
  { value: "detailed", label: "Detailed", description: `More precise edits, takes longer. · ${CHUNK_MODE_SIZES.detailed}s chunks` },
  { value: "very-detailed", label: "Very detailed", description: `Best for short, dense videos, slowest. · ${CHUNK_MODE_SIZES["very-detailed"]}s chunks` },
  { value: "custom", label: "Custom", description: "Set your own chunk length, or a number of chunks." },
];

// Dialog structure (AI-edit groups WITHOUT captions + the separate captions
// toggle) lives in a pure config module so the separation rule is testable:
// captions are a transcription feature — never just another AI-edit toggle.
// See src/lib/analysis/analyze-dialog-config.ts.

export interface AnalysisDetailPrefs {
  chunkMode: ChunkMode;
  chunkSizeSeconds: number;
}

/**
 * "What should Framevo generate?" dialog — shown before every (re)analysis. Now
 * exposes ALL implemented automatic edit types (not just zoom/cut/speed): AI
 * edits, visual focus, and pacing. Toggles seed from the video-type recipe (and
 * the project's last run on re-analyze) and each one really gates generation.
 */
export function AnalysisOptionsModal({
  open,
  onClose,
  hasExistingEdits,
  initialVideoType,
  onSelectVideoType,
  lastRunOptions,
  corePrefs,
  onPersistCorePrefs,
  videoDuration,
  initialDetail,
  onPersistDetail,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  hasExistingEdits: boolean;
  /** The currently-chosen video type (recipe) to seed the picker. */
  initialVideoType: SelectedVideoType;
  /** Persist the chosen video type (so it survives + drives the run). */
  onSelectVideoType: (t: SelectedVideoType) => void;
  /** The project's last run's options — respected on re-analyze (toggles + language). */
  lastRunOptions?: Partial<AnalysisOptions> | null;
  /** Remembered per-user core-engine toggles. */
  corePrefs?: AnalysisEnginePrefs | null;
  /** Persist just the 3 core engine toggles for next time (per-user). */
  onPersistCorePrefs: (core: AnalysisEnginePrefs) => void;
  videoDuration: number;
  initialDetail: AnalysisDetailPrefs;
  onPersistDetail: (detail: AnalysisDetailPrefs) => void;
  onConfirm: (options: AnalysisOptions) => void;
}) {
  const [videoType, setVideoType] = React.useState<SelectedVideoType>(initialVideoType);
  // The chosen type's recipe defaults (for "Reset to recipe" + re-seed on switch).
  const recipeDefaults = React.useMemo(() => recipeGenerationDefaults(videoType), [videoType]);
  const [gen, setGen] = React.useState<GenerationToggles>(() =>
    resolveInitialGenerationToggles({
      recipeDefaults: recipeGenerationDefaults(initialVideoType),
      lastRun: lastRunOptions,
      corePrefs,
    })
  );
  // Spoken language for transcription — seeds from the last run (default Auto).
  const [langMode, setLangMode] = React.useState<TranscriptLanguageMode>(
    lastRunOptions?.transcriptLanguageMode === "selected" ? "selected" : "auto"
  );
  const [langCode, setLangCode] = React.useState<string | undefined>(
    lastRunOptions?.transcriptLanguageCode
  );
  const [mode, setMode] = React.useState<ExistingEditMode>("replace-selected");
  const [chunkMode, setChunkMode] = React.useState<ChunkMode>(initialDetail.chunkMode);
  const [customBy, setCustomBy] = React.useState<"size" | "count">("size");
  const [customSize, setCustomSize] = React.useState<number>(initialDetail.chunkSizeSeconds);
  const [customCount, setCustomCount] = React.useState<number>(() =>
    Math.max(1, chunkCountFor(videoDuration, initialDetail.chunkSizeSeconds) || 4)
  );

  React.useEffect(() => {
    if (!open) return;
    setVideoType(initialVideoType);
    setGen(
      resolveInitialGenerationToggles({
        recipeDefaults: recipeGenerationDefaults(initialVideoType),
        lastRun: lastRunOptions,
        corePrefs,
      })
    );
    setLangMode(lastRunOptions?.transcriptLanguageMode === "selected" ? "selected" : "auto");
    setLangCode(lastRunOptions?.transcriptLanguageCode);
    setMode("replace-selected");
    setChunkMode(initialDetail.chunkMode);
    setCustomBy("size");
    setCustomSize(clampChunkSize(initialDetail.chunkSizeSeconds));
    setCustomCount(Math.max(1, chunkCountFor(videoDuration, initialDetail.chunkSizeSeconds) || 4));
    // Re-seed only when the dialog opens (not on every keystroke inside it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Switching video type inside the dialog → adopt that recipe's defaults + persist.
  const onPickVideoType = (t: SelectedVideoType) => {
    setVideoType(t);
    setGen(recipeGenerationDefaults(t));
    onSelectVideoType(t);
  };

  // A run needs at least ONE core engine (camera/cut/speed) — overlays are
  // additive on top of a real timeline.
  const coreOff = !gen.generateCameraEdits && !gen.generateCut && !gen.generateSpeed;

  // ── Auto-caption quota (display + client guard; the server re-checks and
  // reserves atomically — client values are never trusted for enforcement).
  // A blocked caption toggle NEVER blocks the rest of the analysis.
  const captionUsage = useCaptionUsage();
  const captionPerVideoBlocked = exceedsCaptionVideoLimit(captionUsage.plan, videoDuration);
  const captionRequiredSeconds = requiredCaptionSeconds(videoDuration);
  const captionExhausted =
    !captionPerVideoBlocked &&
    !captionUsage.loading &&
    captionUsage.remainingSeconds < captionRequiredSeconds;
  const captionBlocked = captionPerVideoBlocked || captionExhausted;

  const setToggle = (key: keyof GenerationToggles, value: boolean) =>
    setGen((prev) => ({ ...prev, [key]: value }));

  const resolvedSize = resolveChunkSize(chunkMode, {
    customSize,
    customCount: customBy === "count" ? customCount : undefined,
    duration: videoDuration,
  });
  const estimatedChunks = chunkCountFor(videoDuration, resolvedSize);
  const showWarning = resolvedSize <= 10 && estimatedChunks >= 12;

  const handleConfirm = () => {
    if (coreOff) return;
    if (gen.generateCameraEdits) logFramevoEvent(EVENTS.CAMERA_EDITS_ENABLED);
    if (gen.generateCut) logFramevoEvent(EVENTS.CUTS_ENABLED);
    if (gen.generateSpeed) logFramevoEvent(EVENTS.SPEED_ENABLED);
    // Captions have their OWN event lifecycle (separate from the AI edit):
    // requested / disabled / blocked all logged distinctly.
    if (captionBlocked) {
      logFramevoEvent(EVENTS.CAPTION_QUOTA_BLOCKED, {
        reason: captionPerVideoBlocked ? "per_video_limit" : "quota_exhausted",
      });
    } else if (gen.generateCaptions) {
      logFramevoEvent(EVENTS.CAPTION_TRANSCRIPTION_STARTED, { requested: true });
    } else {
      logFramevoEvent(EVENTS.CAPTION_DISABLED);
    }
    logFramevoEvent(EVENTS.CHUNK_SIZE_SELECTED, { chunkMode, chunkSizeSeconds: resolvedSize });
    onPersistCorePrefs({
      generateCameraEdits: gen.generateCameraEdits,
      generateCut: gen.generateCut,
      generateSpeed: gen.generateSpeed,
    });
    onPersistDetail({ chunkMode, chunkSizeSeconds: resolvedSize });
    onSelectVideoType(videoType);
    onConfirm({
      ...gen,
      // Quota-blocked captions are forced off for this run (defense in depth —
      // the server enforces the same limits before dispatching ASR).
      ...(captionBlocked ? { generateCaptions: false } : {}),
      selectedVideoType: videoType,
      // Spoken language — sent verbatim to ASR (never overridden by the server
      // env). Auto mode omits the code; a locale hint aids Auto-Detect candidates.
      transcriptLanguageMode: langMode,
      ...(langMode === "selected" && langCode ? { transcriptLanguageCode: langCode } : {}),
      ...(typeof navigator !== "undefined" && navigator.language
        ? { transcriptLocaleHint: navigator.language }
        : {}),
      existingEditMode: hasExistingEdits ? mode : "replace-selected",
      chunkMode,
      chunkSizeSeconds: resolvedSize,
      ...(chunkMode === "custom" && customBy === "count" ? { chunkCount: customCount } : {}),
    });
  };

  return (
    <EditorSheet
      open={open}
      onClose={onClose}
      title="Choose what Framevo should generate"
      subtitle="Pick the kinds of automatic edits you want for this analysis."
      icon={<Sparkles size={17} />}
      size="wide"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={coreOff}
            leftIcon={<Sparkles size={14} />}
            title={coreOff ? "Turn on at least one of Zooms & focus, Cuts, or Speed to continue." : undefined}
          >
            Start analysis
          </Button>
        </div>
      }
    >
      <div className="space-y-7 px-6 py-6">
        {/* ── Video type (recipe) ───────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            What kind of video is this?
          </h3>
          <p className="text-[11.5px] leading-relaxed text-fog/80">
            Pick a type and Framevo starts from the matching edit recipe. Switching
            a type resets the toggles below to that recipe&apos;s defaults.
          </p>
          <VideoTypePicker value={videoType} onChange={onPickVideoType} />
        </section>

        {/* ── Captions & transcription ──────────────────────────────────────
            A DEDICATED section — captions are a transcription feature with
            their own monthly quota, spoken language, and background
            processing. They are not one of the AI video edits below: turning
            them off (or hitting a caption limit) never affects those. */}
        <section className="space-y-3 border-t border-white/[0.06] pt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Captions &amp; transcription
          </h3>
          <p className="text-[11.5px] leading-relaxed text-fog/80">
            Auto-captions transcribe the video&apos;s speech (using your monthly caption
            minutes) and can keep processing in the background — every other AI edit
            generates either way.
          </p>

          <div className="space-y-1">
            <div className={captionBlocked ? "pointer-events-none opacity-55" : undefined}>
              <Toggle
                label={CAPTIONS_TOGGLE.label}
                description={CAPTIONS_TOGGLE.description}
                checked={captionBlocked ? false : gen.generateCaptions}
                onChange={(v) => {
                  if (!captionBlocked) setToggle("generateCaptions", v);
                }}
              />
            </div>
            {CAPTIONS_TOGGLE.note && gen.generateCaptions && !captionBlocked && (
              <p className="pl-0.5 text-[11px] leading-relaxed text-fog/70">
                {CAPTIONS_TOGGLE.note}
              </p>
            )}
            <CaptionQuotaNote
              usage={captionUsage}
              videoDuration={videoDuration}
              enabled={gen.generateCaptions && !captionBlocked}
              perVideoBlocked={captionPerVideoBlocked}
              exhausted={captionExhausted}
            />
          </div>

          <div className={cn("space-y-2 pt-1", !gen.generateCaptions && "opacity-60")}>
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog/60">
              Spoken language
            </h4>
            <p className="text-[11.5px] leading-relaxed text-fog/80">
              The language spoken in the video. Framevo transcribes + captions in this
              language — it never translates. Pick it for reliable captions (e.g. Arabic);
              Auto Detect guesses from a small candidate list.
            </p>
            <SpokenLanguagePicker
              mode={langMode}
              code={langCode}
              disabled={!gen.generateCaptions || captionBlocked}
              onChange={(m, c) => {
                setLangMode(m);
                setLangCode(c);
              }}
            />
          </div>
        </section>

        {/* ── AI video edits ────────────────────────────────────────────────
            The automatic EDIT types only — captions are a separate
            transcription feature (section above) and the bulk actions here
            never touch the captions toggle. */}
        <section className="space-y-4 border-t border-white/[0.06] pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
              AI video edits
            </h3>
            <div className="flex items-center gap-1">
              <MiniAction icon={<RotateCcw size={11} />} label="Reset to recipe" onClick={() =>
                // Recipe reset covers the AI-edit toggles only — captions stay
                // the user's separate choice (the recipe merely recommends).
                setGen((prev) => {
                  const next = { ...prev };
                  for (const k of AI_EDIT_TOGGLE_KEYS) next[k] = recipeDefaults[k];
                  return next;
                })
              } />
              <MiniAction icon={<CheckCheck size={11} />} label="Select all" onClick={() =>
                setGen((prev) => {
                  const next = { ...prev };
                  for (const k of AI_EDIT_TOGGLE_KEYS) next[k] = true;
                  return next;
                })
              } />
              <MiniAction icon={<Ban size={11} />} label="Disable extras" onClick={() =>
                setGen((prev) => {
                  const next = { ...prev };
                  for (const k of AI_EDIT_EXTRA_KEYS) next[k] = false;
                  return next;
                })
              } />
            </div>
          </div>

          {/* Two/three-column on desktop (wide dialog), single column on mobile. */}
          <EditorDialogGrid columns={3}>
            {AI_EDIT_GROUPS.map((group) => (
              <div key={group.title} className="space-y-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog/60">
                  {group.title}
                </div>
                {group.items.map((item) => (
                  <div key={item.key} className="space-y-1">
                    <Toggle
                      label={item.label}
                      description={item.description}
                      checked={gen[item.key]}
                      onChange={(v) => setToggle(item.key, v)}
                    />
                    {item.note && gen[item.key] && (
                      <p className="pl-0.5 text-[11px] leading-relaxed text-fog/70">{item.note}</p>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </EditorDialogGrid>

          {coreOff && (
            <p className="text-xs text-amber-200/90">
              Turn on at least one of Zooms &amp; focus, Cuts, or Speed to start an analysis.
            </p>
          )}
        </section>

        {/* ── Existing edits ────────────────────────────────────────────── */}
        {hasExistingEdits && (
          <section className="space-y-3 border-t border-white/[0.06] pt-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
              Existing AI-generated edits
            </h3>
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={EXISTING_EDIT_OPTIONS}
              ariaLabel="How to treat existing AI-generated edits"
            />
          </section>
        )}

        {/* ── Analysis detail (chunk granularity) ───────────────────────── */}
        <section className="space-y-3 border-t border-white/[0.06] pt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Analysis detail
          </h3>
          <SegmentedControl
            value={chunkMode}
            onChange={setChunkMode}
            options={DETAIL_OPTIONS}
            ariaLabel="How detailed the analysis should be"
          />

          {chunkMode === "custom" && (
            <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.015] p-3.5">
              <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5 text-[12px]">
                {(["size", "count"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCustomBy(m)}
                    className={cn(
                      "rounded-md px-3 py-1 font-medium transition-colors duration-150",
                      customBy === m ? "bg-violet-500/30 text-white" : "text-fog hover:text-white"
                    )}
                  >
                    {m === "size" ? "By seconds" : "By chunks"}
                  </button>
                ))}
              </div>

              {customBy === "size" ? (
                <label className="flex items-center gap-2.5 text-[13px] text-white/90">
                  <span>Chunk length</span>
                  <input
                    type="number"
                    min={CHUNK_SIZE_MIN_S}
                    max={CHUNK_SIZE_MAX_S}
                    value={customSize}
                    onChange={(e) => setCustomSize(Number(e.target.value))}
                    onBlur={() => setCustomSize(clampChunkSize(customSize))}
                    className="w-20 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-sm tabular-nums text-white outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  />
                  <span className="text-fog">seconds</span>
                </label>
              ) : (
                <label className="flex items-center gap-2.5 text-[13px] text-white/90">
                  <span>Number of chunks</span>
                  <input
                    type="number"
                    min={1}
                    value={customCount}
                    onChange={(e) => setCustomCount(Math.max(1, Math.round(Number(e.target.value))))}
                    className="w-20 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-sm tabular-nums text-white outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                  />
                  <span className="text-fog">= {resolvedSize}s each</span>
                </label>
              )}
              <p className="text-[11px] text-fog">
                Chunk length is kept between {CHUNK_SIZE_MIN_S}s and {CHUNK_SIZE_MAX_S}s.
              </p>
            </div>
          )}

          <div className="text-[12.5px] text-fog">
            {videoDuration > 0 ? (
              <span className="text-white/85">
                ≈ {estimatedChunks} chunk{estimatedChunks === 1 ? "" : "s"} · {resolvedSize}s each
              </span>
            ) : (
              <span className="text-white/85">{resolvedSize}s chunks</span>
            )}
          </div>
          <p className="text-[11.5px] leading-relaxed text-fog">
            Smaller chunks can create more detailed edits but may take longer.
          </p>
          {showWarning && (
            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-amber-200/90">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Very small chunks may take longer and create more edits.
            </p>
          )}
        </section>
      </div>
    </EditorSheet>
  );
}

function MiniAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10.5px] font-medium text-fog transition-colors duration-150 hover:border-white/20 hover:text-white"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The auto-caption allowance readout under the Captions toggle: the plan's
 * monthly allowance, live usage, the estimated cost of THIS analysis, and the
 * per-video / exhausted limit states with the right upgrade action. Numbers
 * come from the shared caption-quota config + the user's own ledger doc —
 * display only; the server enforces.
 */
function CaptionQuotaNote({
  usage,
  videoDuration,
  enabled,
  perVideoBlocked,
  exhausted,
}: {
  usage: CaptionUsageState;
  videoDuration: number;
  enabled: boolean;
  perVideoBlocked: boolean;
  exhausted: boolean;
}) {
  const upgradeTarget =
    usage.plan === "free" ? "Pro" : usage.plan === "pro" ? "Creator" : null;
  return (
    <div className="space-y-1 pl-0.5">
      <p className="text-[11px] leading-relaxed text-fog/70">
        {captionAllowanceLabel(usage.plan)}
        {" · "}up to {Math.round(usage.maxVideoSeconds / 60)} minutes per video
        {!usage.loading && (
          <>
            {" · "}
            {usage.usedMinutes} of {usage.allowanceMinutes} caption minutes used
            {" · "}
            {usage.remainingMinutes} minutes remaining
          </>
        )}
      </p>
      {perVideoBlocked ? (
        <p className="text-[11px] leading-relaxed text-amber-200/90">
          {perVideoCaptionLimitMessage(usage.plan)}{" "}
          {upgradeTarget && (
            <a
              href="/pricing"
              className="font-medium text-violet-300 transition-colors hover:text-violet-200"
            >
              Upgrade to {upgradeTarget}
            </a>
          )}
        </p>
      ) : exhausted ? (
        <p className="text-[11px] leading-relaxed text-amber-200/90">
          {CAPTION_ALLOWANCE_EXHAUSTED_MESSAGE}{" "}
          {upgradeTarget && (
            <a
              href="/pricing"
              className="font-medium text-violet-300 transition-colors hover:text-violet-200"
            >
              Upgrade to {upgradeTarget}
            </a>
          )}
        </p>
      ) : (
        enabled &&
        videoDuration > 0 && (
          <p className="text-[11px] leading-relaxed text-fog/70">
            This video will use approximately {estimateCaptionMinutes(videoDuration)} caption
            minutes.
          </p>
        )
      )}
    </div>
  );
}
