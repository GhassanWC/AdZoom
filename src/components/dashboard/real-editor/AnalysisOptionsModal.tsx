"use client";

import * as React from "react";
import { Sparkles, AlertTriangle } from "lucide-react";
import { EditorSheet } from "./EditorSheet";
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
  type ChunkMode,
  CHUNK_MODE_SIZES,
  CHUNK_SIZE_MAX_S,
  CHUNK_SIZE_MIN_S,
  chunkCountFor,
  clampChunkSize,
  resolveChunkSize,
} from "@/lib/analysis/chunk-config";

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
  {
    value: "fast",
    label: "Fast",
    description: `Faster analysis with fewer chunks. · ${CHUNK_MODE_SIZES.fast}s chunks`,
  },
  {
    value: "balanced",
    label: "Balanced",
    badge: "Recommended",
    description: `Recommended balance of speed and detail. · ${CHUNK_MODE_SIZES.balanced}s chunks`,
  },
  {
    value: "detailed",
    label: "Detailed",
    description: `More precise edits, takes longer. · ${CHUNK_MODE_SIZES.detailed}s chunks`,
  },
  {
    value: "very-detailed",
    label: "Very detailed",
    description: `Best for short, dense videos, slowest. · ${CHUNK_MODE_SIZES["very-detailed"]}s chunks`,
  },
  {
    value: "custom",
    label: "Custom",
    description: "Set your own chunk length, or a number of chunks.",
  },
];

export interface AnalysisDetailPrefs {
  chunkMode: ChunkMode;
  chunkSizeSeconds: number;
}

/**
 * "Analysis options" dialog — shown before every (re)analysis so the user picks
 * which engines run, how existing AI edits are treated, and how finely the video
 * is chunked. Engine toggles + analysis detail seed from the user's remembered
 * preferences; the existing-edit mode always re-defaults to "replace-selected".
 */
export function AnalysisOptionsModal({
  open,
  onClose,
  hasExistingEdits,
  initialEnginePrefs,
  onPersistEnginePrefs,
  videoDuration,
  initialDetail,
  onPersistDetail,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  /** True when the project already has analysis (shows the existing-edits section). */
  hasExistingEdits: boolean;
  /** Remembered per-user engine toggles to pre-select. */
  initialEnginePrefs: AnalysisEnginePrefs;
  /** Persist the three engine toggles for next time. */
  onPersistEnginePrefs: (prefs: AnalysisEnginePrefs) => void;
  /** Whole-video duration (seconds) — drives the estimated-chunks preview. */
  videoDuration: number;
  /** Remembered analysis-detail (granularity) choice to pre-select. */
  initialDetail: AnalysisDetailPrefs;
  /** Persist the analysis-detail choice for next time. */
  onPersistDetail: (detail: AnalysisDetailPrefs) => void;
  /** Start analysis with the chosen options. */
  onConfirm: (options: AnalysisOptions) => void;
}) {
  const [engines, setEngines] = React.useState<AnalysisEnginePrefs>(initialEnginePrefs);
  const [mode, setMode] = React.useState<ExistingEditMode>("replace-selected");
  const [chunkMode, setChunkMode] = React.useState<ChunkMode>(initialDetail.chunkMode);
  const [customBy, setCustomBy] = React.useState<"size" | "count">("size");
  const [customSize, setCustomSize] = React.useState<number>(initialDetail.chunkSizeSeconds);
  const [customCount, setCustomCount] = React.useState<number>(() =>
    Math.max(1, chunkCountFor(videoDuration, initialDetail.chunkSizeSeconds) || 4)
  );

  // Re-seed each time the dialog opens: engines + detail from the remembered
  // preferences (which may have loaded async), the existing-edit mode back to
  // the safe default.
  React.useEffect(() => {
    if (!open) return;
    setEngines(initialEnginePrefs);
    setMode("replace-selected");
    setChunkMode(initialDetail.chunkMode);
    setCustomBy("size");
    setCustomSize(clampChunkSize(initialDetail.chunkSizeSeconds));
    setCustomCount(Math.max(1, chunkCountFor(videoDuration, initialDetail.chunkSizeSeconds) || 4));
  }, [open, initialEnginePrefs, initialDetail, videoDuration]);

  const allOff =
    !engines.generateCameraEdits && !engines.generateCut && !engines.generateSpeed;

  const setEngine = (key: keyof AnalysisEnginePrefs, value: boolean) =>
    setEngines((prev) => ({ ...prev, [key]: value }));

  // Resolved (clamped) chunk size for the current selection — authoritative.
  const resolvedSize = resolveChunkSize(chunkMode, {
    customSize,
    customCount: customBy === "count" ? customCount : undefined,
    duration: videoDuration,
  });
  const estimatedChunks = chunkCountFor(videoDuration, resolvedSize);
  const showWarning = resolvedSize <= 10 && estimatedChunks >= 12;

  const handleConfirm = () => {
    if (allOff) return;
    onPersistEnginePrefs(engines);
    onPersistDetail({ chunkMode, chunkSizeSeconds: resolvedSize });
    onConfirm({
      ...engines,
      existingEditMode: hasExistingEdits ? mode : "replace-selected",
      chunkMode,
      chunkSizeSeconds: resolvedSize,
      ...(chunkMode === "custom" && customBy === "count"
        ? { chunkCount: customCount }
        : {}),
    });
  };

  return (
    <EditorSheet
      open={open}
      onClose={onClose}
      title="Choose what Framevo should generate"
      subtitle="Pick the kinds of automatic edits you want for this analysis."
      icon={<Sparkles size={17} />}
      maxWidth="max-w-xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={allOff}
            leftIcon={<Sparkles size={14} />}
            title={allOff ? "Turn on at least one engine to continue." : undefined}
          >
            Start analysis
          </Button>
        </div>
      }
    >
      <div className="space-y-7 px-6 py-6">
        {/* ── Engines ───────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            What to generate
          </h3>
          <Toggle
            label="Camera edits"
            description="Zoom, click highlights, and focus moments."
            checked={engines.generateCameraEdits}
            onChange={(v) => setEngine("generateCameraEdits", v)}
          />
          <Toggle
            label="Cuts"
            description="Remove boring, idle, loading, or dead sections."
            checked={engines.generateCut}
            onChange={(v) => setEngine("generateCut", v)}
          />
          <Toggle
            label="Speed"
            description="Speed up slow, idle, or loading sections."
            checked={engines.generateSpeed}
            onChange={(v) => setEngine("generateSpeed", v)}
          />
          {allOff && (
            <p className="text-xs text-amber-200/90">
              Turn on at least one to start an analysis.
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
                      customBy === m
                        ? "bg-violet-500/30 text-white"
                        : "text-fog hover:text-white"
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

          {/* Estimate + helper + warning */}
          <div className="text-[12.5px] text-fog">
            {videoDuration > 0 ? (
              <span className="text-white/85">
                ≈ {estimatedChunks} chunk{estimatedChunks === 1 ? "" : "s"} ·{" "}
                {resolvedSize}s each
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
