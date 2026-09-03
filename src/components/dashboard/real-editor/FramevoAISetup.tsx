"use client";

/**
 * Framevo AI — the SETUP state (approved rules 5–8).
 *
 * Outcome-first: the default view is three compact rows (Video · Style ·
 * Output), an optional instruction, and one [Edit video] button. The template
 * is the main editorial choice. Structured controls live behind "Change
 * setup"; technical generation controls behind "Advanced" — nothing was lost
 * from the old dialog, it just stopped being the front door:
 *   • core-engine guard            → kept (Edit video blocks, with the reason)
 *   • caption separation rule      → structural (the run-request builder)
 *   • existing-edit mode           → kept, re-runs only, under Advanced
 *   • per-user preference persist  → kept (engines + detail save on run)
 *   • carry-over semantics         → unchanged (same options contract)
 *   • Instant/Plan                 → same switch, same session ownership
 *
 * On [Edit video] everything funnels through `buildAnalysisRunRequest` — the
 * one canonical builder — with the brief merged as a DELTA.
 */
import * as React from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Settings2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorReal } from "./context";
import { useWorkspaceSettings } from "@/lib/firebase/workspace-settings";
import { VideoTypePicker } from "./VideoTypePicker";
import { ModeSwitch } from "./DirectorChatPanel";
import type { ChatMode } from "@/lib/director/chat";
import { buildAnalysisRunRequest } from "@/lib/analysis/run-request";
import {
  recipeGenerationDefaults,
  resolveInitialGenerationToggles,
  type GenerationToggles,
} from "@/lib/analysis/edit-recipe";
import {
  AI_EDIT_GROUPS,
  AI_EDIT_EXTRA_KEYS,
  AI_EDIT_TOGGLE_KEYS,
} from "@/lib/analysis/analyze-dialog-config";
import type { AnalysisOptions, ExistingEditMode } from "@/lib/analysis/engine-layers";
import { CHUNK_MODE_SIZES, type ChunkMode } from "@/lib/analysis/chunk-config";
import { ZOOM_PRESET_IDS, type ZoomPresetId } from "@/lib/timeline/zoom-presets";
import type { SelectedVideoType } from "@/lib/firebase/schema";
import type {
  DirectorAspect,
  DirectorCaptionStyle,
  DirectorCtaMode,
  DirectorPlatform,
} from "@/lib/director/types";
import {
  DIRECTOR_ASPECTS,
  DIRECTOR_CAPTION_STYLES,
  DIRECTOR_CTA_MODES,
  DIRECTOR_PLATFORMS,
} from "@/lib/director/types";
import {
  outputRowLabel,
  platformLabel,
  templateChips,
  templateChoicesForProject,
  videoRowLabel,
} from "@/lib/framevo-ai/state";
import type { EditingTemplate } from "@/lib/editorial/templates";

const FIELD =
  "h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-[12px] text-white outline-none transition-colors duration-150 focus:border-violet-400/50 disabled:opacity-50 [&>option]:bg-ink [&>option]:text-white";

const CAPTION_LABEL: Record<DirectorCaptionStyle, string> = {
  none: "No captions",
  clean: "Clean",
  bold_social: "Bold social",
  minimal: "Minimal",
  podcast: "Podcast",
  tutorial: "Tutorial",
};
const CTA_LABEL: Record<DirectorCtaMode, string> = {
  auto: "Auto — decide for me",
  always: "Always end with a CTA",
  never: "Never add a CTA",
};

interface SetupDraft {
  videoType: SelectedVideoType;
  templateId: string;
  platform: DirectorPlatform;
  aspectRatio: DirectorAspect;
  /** Raw text — half-typed numbers are valid things to look at. */
  target: string;
  captionStyle: DirectorCaptionStyle;
  cta: DirectorCtaMode;
  toggles: GenerationToggles;
  zoomPreset: ZoomPresetId;
  chunkMode: ChunkMode;
  existingEditMode: ExistingEditMode;
}

export function FramevoAISetup({
  mode,
  onModeChange,
  canAnalyze,
  analyzeBlockedReason,
  hasExistingEdits,
  onClose,
  initialChangeOpen = false,
  initialAdvancedOpen = false,
}: {
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  canAnalyze: boolean;
  analyzeBlockedReason?: string;
  hasExistingEdits: boolean;
  /** Present when setup was opened over an existing conversation. */
  onClose?: () => void;
  /** Dev-preview affordances (screenshot rig) — start with a section expanded. */
  initialChangeOpen?: boolean;
  initialAdvancedOpen?: boolean;
}) {
  const {
    project,
    analyzing,
    startAnalyze,
    saveDirectorBrief,
    setSelectedVideoType,
    writeProject,
    updateEffects,
  } = useEditorReal();
  const { settings, save } = useWorkspaceSettings();

  const lastRun = project.analysis?.lastRunOptions as Partial<AnalysisOptions> | undefined;
  const seedToggles = React.useCallback(
    (t: SelectedVideoType): GenerationToggles =>
      resolveInitialGenerationToggles({
        recipeDefaults: recipeGenerationDefaults(t),
        lastRun,
        corePrefs: settings.analysisEngines,
      }),
    [lastRun, settings.analysisEngines]
  );

  const [draft, setDraft] = React.useState<SetupDraft>(() => {
    const videoType = project.selectedVideoType ?? "auto";
    const form = project.directorBrief?.form ?? {};
    const choices = templateChoicesForProject(project);
    return {
      videoType,
      templateId: project.editingTemplateId ?? choices[0]?.id ?? "classic-auto",
      platform: form.platform ?? "youtube",
      aspectRatio: form.aspectRatio ?? "16:9",
      target: form.targetDurationSeconds ? String(form.targetDurationSeconds) : "",
      captionStyle: form.captionStyle ?? "clean",
      cta: form.cta ?? "auto",
      toggles: seedToggles(videoType),
      zoomPreset: project.effectsSettings?.zoomPreset ?? "standard",
      chunkMode: lastRun?.chunkMode ?? settings.analysisDetail.chunkMode ?? "balanced",
      existingEditMode: "replace-selected",
    };
  });
  const [instruction, setInstruction] = React.useState("");
  const [changeOpen, setChangeOpen] = React.useState(initialChangeOpen);
  const [advancedOpen, setAdvancedOpen] = React.useState(initialAdvancedOpen);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Switching the video type re-seeds the toggle grid to that recipe's
  // defaults — the behaviour the old dialog established — and re-offers styles.
  const pickVideoType = (t: SelectedVideoType) => {
    setDraft((d) => {
      const choices = templateChoicesForProject({ ...project, selectedVideoType: t });
      const stillOffered = choices.some((c) => c.id === d.templateId);
      return {
        ...d,
        videoType: t,
        toggles: seedToggles(t),
        templateId: stillOffered ? d.templateId : (choices[0]?.id ?? d.templateId),
      };
    });
  };

  const templateChoices = React.useMemo(
    () => templateChoicesForProject({ ...project, selectedVideoType: draft.videoType }),
    [project, draft.videoType]
  );
  const selectedTemplate =
    templateChoices.find((t) => t.id === draft.templateId) ?? templateChoices[0];

  const coreOff =
    !draft.toggles.generateCameraEdits &&
    !draft.toggles.generateCut &&
    !draft.toggles.generateSpeed;

  const editVideo = async () => {
    if (!canAnalyze || analyzing || starting || coreOff) return;
    setStarting(true);
    setError(null);
    try {
      const target = Number.parseInt(draft.target, 10);
      const req = buildAnalysisRunRequest({
        project,
        workspace: settings,
        overrides: {
          ...draft.toggles,
          selectedVideoType: draft.videoType,
          templateId: draft.templateId,
          chunkMode: draft.chunkMode,
          ...(draft.chunkMode !== "custom"
            ? { chunkSizeSeconds: CHUNK_MODE_SIZES[draft.chunkMode] }
            : {}),
          existingEditMode: hasExistingEdits ? draft.existingEditMode : "replace-selected",
        },
        briefForm: {
          platform: draft.platform,
          aspectRatio: draft.aspectRatio,
          captionStyle: draft.captionStyle,
          cta: draft.cta,
          ...(Number.isFinite(target) && target > 0
            ? { targetDurationSeconds: target }
            : {}),
        },
        instruction,
        planOnly: mode === "plan",
      });

      // Persist the choices that OUTLIVE the run — same writes the old dialog
      // made: video type + template on the project, engines + detail per-user,
      // the zoom style on the effects.
      await setSelectedVideoType(draft.videoType);
      await writeProject({ editingTemplateId: draft.templateId });
      if (draft.zoomPreset !== (project.effectsSettings?.zoomPreset ?? "standard")) {
        await updateEffects("zoomPreset", draft.zoomPreset);
      }
      void save({
        analysisEngines: {
          generateCameraEdits: draft.toggles.generateCameraEdits,
          generateCut: draft.toggles.generateCut,
          generateSpeed: draft.toggles.generateSpeed,
        },
        analysisDetail: {
          chunkMode: draft.chunkMode,
          chunkSizeSeconds: req.options.chunkSizeSeconds,
        },
      });

      // The route reads the brief off the document — the save must land first,
      // and a failed save must stop the run (the dialog's contract, kept).
      if (req.briefChanged && req.brief) {
        await saveDirectorBrief(req.brief.prompt, req.brief.form);
      }
      await startAnalyze(req.options);
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the edit.");
    } finally {
      setStarting(false);
    }
  };

  const video = videoRowLabel({ selectedVideoType: draft.videoType });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25">
            <Sparkles size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-white">
              {hasExistingEdits ? "Re-edit with Framevo AI" : "Edit with Framevo AI"}
            </p>
            <p className="text-[11.5px] text-fog">
              Pick an outcome — Framevo AI makes the editing decisions.
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-2 py-1 text-[11.5px] text-fog transition-colors hover:border-white/25 hover:text-white"
            >
              Back
            </button>
          )}
        </div>

        {/* ── Video row ── */}
        <SetupRow
          label="Video"
          value={video.label}
          detail={video.detail}
          onChange={() => setChangeOpen((v) => !v)}
        />

        {/* ── Style row — THE editorial choice ── */}
        <div className="rounded-xl border border-violet-400/25 bg-violet-500/[0.05] p-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-violet-200/80">
            Style
          </p>
          <div className="mt-2 space-y-1.5">
            {templateChoices.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                active={t.id === selectedTemplate?.id}
                onPick={() => set("templateId", t.id)}
              />
            ))}
          </div>
        </div>

        {/* ── Output row ── */}
        <SetupRow
          label="Output"
          value={outputRowLabel({
            prompt: "",
            form: {
              platform: draft.platform,
              aspectRatio: draft.aspectRatio,
              ...(Number.parseInt(draft.target, 10) > 0
                ? { targetDurationSeconds: Number.parseInt(draft.target, 10) }
                : {}),
            },
            updatedAt: 0,
          })}
          detail={
            draft.captionStyle === "none"
              ? "No captions"
              : `${CAPTION_LABEL[draft.captionStyle]} captions · ${CTA_LABEL[draft.cta]}`
          }
          onChange={() => setChangeOpen((v) => !v)}
        />

        {/* ── Change setup (structured controls) ── */}
        {changeOpen && (
          <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fog">
              Video type
            </p>
            <VideoTypePicker value={draft.videoType} onChange={pickVideoType} />
            <p className="pt-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fog">
              Output
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="Platform">
                <select
                  className={FIELD}
                  value={draft.platform}
                  onChange={(e) => set("platform", e.target.value as DirectorPlatform)}
                >
                  {DIRECTOR_PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {platformLabel(p)}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Aspect ratio">
                <select
                  className={FIELD}
                  value={draft.aspectRatio}
                  onChange={(e) => set("aspectRatio", e.target.value as DirectorAspect)}
                >
                  {DIRECTOR_ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Target length (seconds)">
                <input
                  className={FIELD}
                  type="number"
                  min={5}
                  max={3600}
                  placeholder="Auto"
                  value={draft.target}
                  onChange={(e) => set("target", e.target.value)}
                />
              </Labeled>
              <Labeled label="Captions">
                <select
                  className={FIELD}
                  value={draft.captionStyle}
                  onChange={(e) => set("captionStyle", e.target.value as DirectorCaptionStyle)}
                >
                  {DIRECTOR_CAPTION_STYLES.map((c) => (
                    <option key={c} value={c}>
                      {CAPTION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Call to action">
                <select
                  className={FIELD}
                  value={draft.cta}
                  onChange={(e) => set("cta", e.target.value as DirectorCtaMode)}
                >
                  {DIRECTOR_CTA_MODES.map((c) => (
                    <option key={c} value={c}>
                      {CTA_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Labeled>
            </div>
          </div>
        )}

        {/* ── Advanced (technical generation controls) ── */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-fog transition-colors hover:text-white"
        >
          {advancedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <Settings2 size={12} />
          Advanced settings
        </button>
        {advancedOpen && (
          <AdvancedControls
            draft={draft}
            set={set}
            hasExistingEdits={hasExistingEdits}
            coreOff={coreOff}
          />
        )}

        {error && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-[11.5px] text-rose-200">
            {error}
          </p>
        )}
      </div>

      {/* ── Instruction + Edit video ── */}
      <div className="shrink-0 space-y-2 border-t border-white/[0.06] p-3">
        <ModeSwitch mode={mode} onChange={onModeChange} />
        <textarea
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Anything else? “Make it professional for LinkedIn and keep it under 60 seconds.”"
          aria-label="Tell Framevo AI anything else"
          className="min-h-[50px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[12.5px] text-white placeholder:text-fog/60 focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-400/30"
        />
        <button
          type="button"
          onClick={() => void editVideo()}
          disabled={!canAnalyze || analyzing || starting || coreOff}
          title={
            !canAnalyze
              ? analyzeBlockedReason
              : coreOff
                ? "Turn on at least one of Zooms & focus, Cuts, or Speed under Advanced settings."
                : undefined
          }
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-fog"
        >
          {starting || analyzing ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Sparkles size={15} />
          )}
          {mode === "plan"
            ? "Plan the edit"
            : hasExistingEdits
              ? "Re-edit video"
              : "Edit video"}
        </button>
      </div>
    </div>
  );
}

function SetupRow({
  label,
  value,
  detail,
  onChange,
}: {
  label: string;
  value: string;
  detail?: string;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="min-w-0">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fog">{label}</p>
        <p className="mt-0.5 truncate text-[13px] font-medium text-white">{value}</p>
        {detail && <p className="mt-0.5 truncate text-[11px] text-fog">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={onChange}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-fog transition-colors hover:border-white/25 hover:text-white"
      >
        <Pencil size={10} />
        Change
      </button>
    </div>
  );
}

function TemplateCard({
  template,
  active,
  onPick,
}: {
  template: EditingTemplate;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={cn(
        "w-full rounded-lg border p-2.5 text-left transition-colors duration-150",
        active
          ? "border-violet-400/50 bg-violet-500/[0.12]"
          : "border-white/[0.07] bg-white/[0.02] hover:border-white/20"
      )}
    >
      <p className="text-[12.5px] font-semibold text-white">{template.name}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-fog">{template.description}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {templateChips(template).map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-fog"
          >
            {chip}
          </span>
        ))}
      </div>
    </button>
  );
}

function AdvancedControls({
  draft,
  set,
  hasExistingEdits,
  coreOff,
}: {
  draft: SetupDraft;
  set: <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) => void;
  hasExistingEdits: boolean;
  coreOff: boolean;
}) {
  const setToggle = (key: keyof GenerationToggles, v: boolean) =>
    set("toggles", { ...draft.toggles, [key]: v });
  const bulk = (fn: (t: GenerationToggles) => GenerationToggles) =>
    set("toggles", fn({ ...draft.toggles }));

  return (
    <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fog">
          AI video edits
        </p>
        <div className="flex gap-2 text-[10.5px]">
          <button
            type="button"
            className="text-fog transition-colors hover:text-white"
            onClick={() =>
              bulk((t) => {
                for (const k of AI_EDIT_TOGGLE_KEYS) t[k] = true;
                return t;
              })
            }
          >
            Select all
          </button>
          <button
            type="button"
            className="text-fog transition-colors hover:text-white"
            onClick={() =>
              bulk((t) => {
                for (const k of AI_EDIT_EXTRA_KEYS) t[k] = false;
                return t;
              })
            }
          >
            Disable extras
          </button>
        </div>
      </div>
      {AI_EDIT_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-fog/70">
            {group.title}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => (
              <label
                key={item.key}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-white/[0.03]"
                title={item.description}
              >
                <span className="text-[12px] text-white/90">{item.label}</span>
                <input
                  type="checkbox"
                  checked={draft.toggles[item.key]}
                  onChange={(e) => setToggle(item.key, e.target.checked)}
                  className="size-3.5 accent-violet-500"
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      {coreOff && (
        <p className="text-[11px] text-amber-200">
          Turn on at least one of Zooms &amp; focus, Cuts, or Speed to start an edit.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <Labeled label="Zoom style">
          <select
            className={FIELD}
            value={draft.zoomPreset}
            onChange={(e) => set("zoomPreset", e.target.value as ZoomPresetId)}
          >
            {ZOOM_PRESET_IDS.map((z) => (
              <option key={z} value={z}>
                {z[0].toUpperCase() + z.slice(1)}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Analysis detail">
          <select
            className={FIELD}
            value={draft.chunkMode}
            onChange={(e) => set("chunkMode", e.target.value as ChunkMode)}
          >
            {(["fast", "balanced", "detailed", "very-detailed"] as ChunkMode[]).map((m) => (
              <option key={m} value={m}>
                {m === "very-detailed" ? "Very detailed" : m[0].toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
        </Labeled>
      </div>

      {hasExistingEdits && (
        <Labeled label="Existing AI edits">
          <select
            className={FIELD}
            value={draft.existingEditMode}
            onChange={(e) => set("existingEditMode", e.target.value as ExistingEditMode)}
          >
            <option value="replace-selected">Replace selected layers only</option>
            <option value="keep">Keep existing and add missing</option>
            <option value="clear-all">Clear all AI edits and regenerate</option>
          </select>
        </Labeled>
      )}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10.5px] font-medium text-fog">{label}</span>
      {children}
    </label>
  );
}
