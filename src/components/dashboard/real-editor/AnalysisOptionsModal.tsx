"use client";

import * as React from "react";
import {
  Sparkles,
  AlertTriangle,
  RotateCcw,
  CheckCheck,
  Ban,
  Loader2,
} from "lucide-react";
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
import {
  DirectorBriefFields,
  directorDraftFromBrief,
  directorDraftHasPrompt,
  directorDraftToForm,
  type DirectorBriefDraft,
} from "./DirectorBriefFields";
import type { DirectorBrief } from "@/lib/director/types";
import type { DirectorRequestForm } from "@/lib/director/request";
import type { SelectedVideoType, ZoomPresetId } from "@/lib/firebase/schema";
import {
  DEFAULT_ZOOM_PRESET,
  ZOOM_PRESETS,
  ZOOM_PRESET_IDS,
} from "@/lib/timeline/zoom-presets";
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
// Captions are DECOUPLED from analysis — no caption toggle, language picker, or
// quota lives in this dialog. Caption generation is behind the dedicated
// "Generate AI Captions" action (CaptionsModal). This dialog controls ONLY the
// AI video edits.
import {
  AI_EDIT_GROUPS,
  AI_EDIT_TOGGLE_KEYS,
  AI_EDIT_EXTRA_KEYS,
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

/**
 * Zoom style — a PROJECT-level choice, not a per-run one, so it applies to the
 * edits this run generates AND to every edit already on the timeline (and to the
 * preview, and to all three exports: they share one camera resolver). It lives
 * here because "how hard should the camera push?" is the same question as "what
 * should Framevo generate?", and this is the one dialog that asks it.
 */
const ZOOM_STYLE_OPTIONS: SegmentOption<ZoomPresetId>[] = ZOOM_PRESET_IDS.map(
  (id) => ({
    value: id,
    label: ZOOM_PRESETS[id].label,
    ...(id === DEFAULT_ZOOM_PRESET ? { badge: "Recommended" } : {}),
    description: ZOOM_PRESETS[id].hint,
  })
);

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
 * "What should Framevo generate?" dialog — shown before every (re)analysis, and
 * the ONE place a run is configured.
 *
 * It carries the whole flow, top to bottom: the Director brief (what video you
 * want), then the video type, then the automatic edit types, then the detail.
 * The Director is the final STAGE of analysis, not a second pass bolted on
 * afterwards — so there is no separate Director dialog and no second button.
 * Writing a brief here directs the run; leaving it empty runs a plain analysis.
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
  directorBrief,
  onSaveDirectorBrief,
  zoomPreset,
  onSelectZoomPreset,
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
  /** The project's saved Director brief — seeds the brief editor at the top. */
  directorBrief?: DirectorBrief | null;
  /**
   * Persist the brief. Awaited BEFORE the run starts: the analyze route reads the
   * brief off the project document server-side, so a brief that lands 600ms later
   * is a brief this run never saw.
   */
  onSaveDirectorBrief: (prompt: string, form: DirectorRequestForm) => Promise<void>;
  /** The project's zoom style (`effectsSettings.zoomPreset`). */
  zoomPreset: ZoomPresetId;
  /**
   * Persist the zoom style. Applied immediately, like the video type — it
   * changes what the preview shows, not just what the next run generates.
   */
  onSelectZoomPreset: (p: ZoomPresetId) => void;
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
  const [mode, setMode] = React.useState<ExistingEditMode>("replace-selected");
  const [chunkMode, setChunkMode] = React.useState<ChunkMode>(initialDetail.chunkMode);
  const [customBy, setCustomBy] = React.useState<"size" | "count">("size");
  const [customSize, setCustomSize] = React.useState<number>(initialDetail.chunkSizeSeconds);
  const [customCount, setCustomCount] = React.useState<number>(() =>
    Math.max(1, chunkCountFor(videoDuration, initialDetail.chunkSizeSeconds) || 4)
  );
  // The Director brief, seeded from what the user last wrote. This dialog IS the
  // brief editor now — there is no other one — so the box's contents are the
  // brief: fill it in and the run is directed, clear it and it isn't.
  const [brief, setBrief] = React.useState<DirectorBriefDraft>(() =>
    directorDraftFromBrief(directorBrief)
  );
  const [saving, setSaving] = React.useState(false);
  const [briefError, setBriefError] = React.useState<string | null>(null);
  const directing = directorDraftHasPrompt(brief);

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
    setMode("replace-selected");
    setBrief(directorDraftFromBrief(directorBrief));
    setSaving(false);
    setBriefError(null);
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

  const setToggle = (key: keyof GenerationToggles, value: boolean) =>
    setGen((prev) => ({ ...prev, [key]: value }));

  const resolvedSize = resolveChunkSize(chunkMode, {
    customSize,
    customCount: customBy === "count" ? customCount : undefined,
    duration: videoDuration,
  });
  const estimatedChunks = chunkCountFor(videoDuration, resolvedSize);
  const showWarning = resolvedSize <= 10 && estimatedChunks >= 12;

  const handleConfirm = async () => {
    if (coreOff || saving) return;
    if (gen.generateCameraEdits) logFramevoEvent(EVENTS.CAMERA_EDITS_ENABLED);
    if (gen.generateCut) logFramevoEvent(EVENTS.CUTS_ENABLED);
    if (gen.generateSpeed) logFramevoEvent(EVENTS.SPEED_ENABLED);
    logFramevoEvent(EVENTS.CHUNK_SIZE_SELECTED, { chunkMode, chunkSizeSeconds: resolvedSize });
    onPersistCorePrefs({
      generateCameraEdits: gen.generateCameraEdits,
      generateCut: gen.generateCut,
      generateSpeed: gen.generateSpeed,
    });
    onPersistDetail({ chunkMode, chunkSizeSeconds: resolvedSize });
    onSelectVideoType(videoType);

    // The brief goes to Firestore BEFORE the run is started, because the analyze
    // route reads it from the project document, not from this request. An empty
    // prompt is saved too — that's how you clear a brief you no longer want.
    //
    // A failed write STOPS the run. Starting anyway would analyze against the
    // brief still on the document — the old one, or none — and hand back a video
    // directed by instructions the user didn't give.
    setSaving(true);
    setBriefError(null);
    try {
      await onSaveDirectorBrief(brief.prompt.trim(), directorDraftToForm(brief));
    } catch (err) {
      setBriefError(
        err instanceof Error
          ? `Couldn't save your Director brief — ${err.message}`
          : "Couldn't save your Director brief. Check your connection and try again."
      );
      return;
    } finally {
      setSaving(false);
    }

    // Captions are DECOUPLED — never send a caption/transcription instruction
    // from the analyze dialog. Strip generateCaptions so analysis can't start
    // ASR or touch captions.
    const { generateCaptions: _captionsDecoupled, ...editToggles } = gen;
    void _captionsDecoupled;
    onConfirm({
      ...editToggles,
      selectedVideoType: videoType,
      existingEditMode: hasExistingEdits ? mode : "replace-selected",
      chunkMode,
      chunkSizeSeconds: resolvedSize,
      // An empty brief can't be applied anyway (`shouldRunDirectorStage` checks
      // for a prompt) — this just says the same thing at the call site.
      applyDirectorBrief: directing,
      ...(chunkMode === "custom" && customBy === "count" ? { chunkCount: customCount } : {}),
    });
  };

  return (
    <EditorSheet
      open={open}
      onClose={onClose}
      title="Choose what Framevo should generate"
      subtitle="Describe the video you want, then pick the automatic edits for this analysis."
      icon={<Sparkles size={17} />}
      size="wide"
      footer={
        <div className="flex items-center justify-end gap-2">
          {briefError && (
            <p className="mr-auto flex min-w-0 items-start gap-1.5 text-[11.5px] leading-relaxed text-rose-200/90">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{briefError}</span>
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={coreOff || saving}
            leftIcon={
              saving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />
            }
            title={coreOff ? "Turn on at least one of Zooms & focus, Cuts, or Speed to continue." : undefined}
          >
            {saving ? "Starting…" : "Start analysis"}
          </Button>
        </div>
      }
    >
      <div className="space-y-7 px-6 py-6">
        {/* ── The Director brief ────────────────────────────────────────────
            FIRST, and always — this is the only place the brief is written. The
            Director runs as the final stage of the analysis this dialog starts,
            so its brief belongs in the same dialog, above the mechanical choices
            it will act on. */}
        <DirectorBriefFields value={brief} onChange={setBrief} disabled={saving} />

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

        {/* ── Zoom style ────────────────────────────────────────────────────
            One choice, four surfaces: the editor preview, the browser export,
            the desktop export and the cloud render all resolve the camera
            through the same table this picks. Individual edits can still
            override it from the inspector. */}
        <section className="space-y-3 border-t border-white/[0.06] pt-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
            Zoom style
          </h3>
          <p className="text-[11.5px] leading-relaxed text-fog/80">
            How far the camera pushes in and how long it takes to get there.
            Applies to every zoom in this project — preview and export alike —
            unless you override a single edit in the inspector.
          </p>
          <SegmentedControl
            value={zoomPreset}
            onChange={onSelectZoomPreset}
            options={ZOOM_STYLE_OPTIONS}
            ariaLabel="How the camera should zoom"
          />
        </section>

        {/* Captions are generated separately via "Generate AI Captions" — no
            caption toggle, spoken-language picker, or quota lives here. */}

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
