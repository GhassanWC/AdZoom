"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Lock, Plus, Sparkles, Wand2 } from "lucide-react";
import type { Preset } from "@/lib/firebase/schema";
import { BUILTIN_PRESETS, inferPresetFromSettings } from "@/lib/presets";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  createCustomPreset,
  deleteCustomPreset,
  subscribeCustomPresets,
} from "@/lib/firebase/custom-presets";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { PresetThumb } from "@/components/landing/PresetThumb";
import { PresetDetailModal } from "@/components/dashboard/PresetDetailModal";
import { useEditorReal } from "./context";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { cn } from "@/lib/cn";

/**
 * LOOKS — the whole-recording presets, as one category of the preset browser.
 *
 * A Look and a library preset are both "one click, and the video changes", which
 * is why they belong in one place. They are NOT the same kind of thing, though,
 * and the copy here says so plainly: a library preset ADDS a designed edit at
 * the playhead, while a Look RETUNES the whole recording (its `effects` bag
 * becomes the project's `effectsSettings` — the defaults every edit falls back
 * to). Applying one never touches the timeline.
 *
 * Recommendations come from the analysis (`analysis.recommendedPresetIds`) and
 * are shown first, badged. Custom Looks the user saved follow the built-ins.
 */
export function LooksGallery({ query }: { query: string }) {
  const { user } = useAuth();
  const { project, applyPreset, clearSelectedPreset } = useEditorReal();
  const { plan } = useStoragePlan();
  const router = useRouter();
  const toast = useToast();

  const [custom, setCustom] = React.useState<Preset[]>([]);
  const [openPreset, setOpenPreset] = React.useState<Preset | null>(null);
  const [applyingId, setApplyingId] = React.useState<string | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeCustomPresets(user.uid, setCustom);
    return () => unsub();
  }, [user]);

  const recommendedIds = React.useMemo(
    () => project.analysis?.recommendedPresetIds ?? [],
    [project.analysis?.recommendedPresetIds]
  );
  const recommendedSet = React.useMemo(
    () => new Set(recommendedIds),
    [recommendedIds]
  );

  /** Recommended first — the whole point of a recommendation is to be seen. */
  const looks = React.useMemo(() => {
    const all = [...BUILTIN_PRESETS, ...custom];
    const q = query.trim().toLowerCase();
    const matched = q
      ? all.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q) ||
            p.vibe.toLowerCase().includes(q)
        )
      : all;
    const rec = matched.filter((p) => recommendedSet.has(p.id));
    const rest = matched.filter((p) => !recommendedSet.has(p.id));
    return [...rec, ...rest];
  }, [custom, query, recommendedSet]);

  /**
   * Which Look is currently on? The explicit choice, else the one whose settings
   * match — a project analyzed into a look it was never explicitly given should
   * still show as wearing it.
   */
  const activeId = React.useMemo(() => {
    if (project.selectedPresetId) return project.selectedPresetId;
    const inferred = inferPresetFromSettings(project.effectsSettings, [
      ...BUILTIN_PRESETS,
      ...custom,
    ]);
    return inferred?.id ?? null;
  }, [project.selectedPresetId, project.effectsSettings, custom]);

  const isLocked = React.useCallback(
    (p: Preset): boolean =>
      !!p.requiredPlan && !planMeetsMinimum(plan.tier, p.requiredPlan),
    [plan.tier]
  );

  /** One click = applied. The card IS the button, same as a library preset. */
  const apply = React.useCallback(
    async (preset: Preset) => {
      if (isLocked(preset)) {
        router.push("/pricing");
        return;
      }
      if (applyingId) return;
      setApplyingId(preset.id);
      try {
        await applyPreset(preset);
        setOpenPreset(null);
        toast.success(
          "Look applied to your current edit.",
          `${preset.name} — your AI moments and timeline are unchanged.`
        );
      } catch (err) {
        toast.error(
          "Could not apply look",
          err instanceof Error ? err.message : "Failed to apply preset"
        );
      } finally {
        setApplyingId(null);
      }
    },
    [applyPreset, applyingId, isLocked, router, toast]
  );

  /** Clone a Look into "My looks" so it can be edited without touching the original. */
  const duplicate = React.useCallback(
    async (preset: Preset) => {
      if (!user) return;
      try {
        await createCustomPreset(user.uid, {
          name: `${preset.name} copy`,
          description: preset.description,
          useCase: preset.useCase,
          category: preset.category,
          vibe: preset.vibe,
          effects: preset.effects,
          basedOn: preset.id,
        });
        toast.success("Duplicated", `Saved as "${preset.name} copy" under your looks`);
        setOpenPreset(null);
      } catch (err) {
        toast.error(
          "Could not duplicate",
          err instanceof Error ? err.message : "Failed to duplicate"
        );
      }
    },
    [toast, user]
  );

  const remove = React.useCallback(
    async (preset: Preset) => {
      if (!user || !preset.isCustom) return;
      try {
        await deleteCustomPreset(user.uid, preset.id);
        toast.success("Deleted", `Removed "${preset.name}"`);
        setOpenPreset(null);
        // The project must not keep pointing at a look that no longer exists.
        if (project.selectedPresetId === preset.id) await clearSelectedPreset();
      } catch (err) {
        toast.error(
          "Could not delete",
          err instanceof Error ? err.message : "Failed to delete"
        );
      }
    },
    [clearSelectedPreset, project.selectedPresetId, toast, user]
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-fog">
          A <span className="text-white/90">Look</span> retunes the whole recording — zoom
          feel, click highlights, pacing — in one click. It never adds or moves a timeline
          edit; it sets the defaults every edit falls back to.
        </p>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Plus size={12} />}
          onClick={() => setSaveOpen(true)}
        >
          Save current as…
        </Button>
      </div>

      {looks.length === 0 ? (
        <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-5 text-center text-[11.5px] text-fog">
          No looks match that. Try another word, or clear the search.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
          {looks.map((preset, i) => (
            <LookCard
              key={preset.id}
              preset={preset}
              index={i}
              active={activeId === preset.id}
              recommended={recommendedSet.has(preset.id)}
              locked={isLocked(preset)}
              applying={applyingId === preset.id}
              disabled={applyingId !== null && applyingId !== preset.id}
              onApply={() => void apply(preset)}
              onOpen={() =>
                isLocked(preset) ? router.push("/pricing") : setOpenPreset(preset)
              }
            />
          ))}
        </div>
      )}

      {openPreset && (
        <PresetDetailModal
          preset={openPreset}
          open={Boolean(openPreset)}
          onClose={() => setOpenPreset(null)}
          applied={activeId === openPreset.id}
          currentSettings={project.effectsSettings}
          onApply={() => void apply(openPreset)}
          onDuplicate={() => void duplicate(openPreset)}
          onDelete={openPreset.isCustom ? () => void remove(openPreset) : undefined}
        />
      )}

      {saveOpen && <SaveLookDialog open={saveOpen} onClose={() => setSaveOpen(false)} />}
    </>
  );
}

/**
 * Save the project's CURRENT settings as a reusable Look.
 *
 * "Current settings" is `effectsSettings` — the applied look plus whatever the
 * Canvas and Export panels have changed (output canvas, vignette, format). It is
 * NOT the per-edit settings: those belong to individual edits on the timeline,
 * which is the whole point of having moved them there.
 */
function SaveLookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { project } = useEditorReal();
  const toast = useToast();
  const [name, setName] = React.useState("My look");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await createCustomPreset(user.uid, {
        name: name.trim() || "Untitled look",
        description: description.trim(),
        useCase: "",
        category: "Creator",
        vibe: "cinematic",
        effects: project.effectsSettings,
      });
      toast.success("Saved", `"${name.trim()}" added to your looks`);
      onClose();
    } catch (err) {
      toast.error("Could not save", err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[140] grid place-items-center bg-ink/80 px-4 backdrop-blur-xl"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-strong w-full max-w-md rounded-2xl p-6 shadow-cinematic"
      >
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          <Wand2 size={11} className="text-violet-300" />
          New look
        </div>
        <h3 className="mt-1 font-display text-xl font-semibold text-white">
          Save current settings
        </h3>
        <p className="mt-1 text-sm text-fog">
          This project&apos;s current look — zoom feel, click highlights, canvas and export
          defaults — saved as a reusable Look you can apply to any video.
        </p>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 text-sm text-white outline-none focus:border-white/20"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
              Description (optional)
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-white outline-none focus:border-white/20"
            />
          </label>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving}
            leftIcon={<Plus size={13} />}
          >
            {saving ? "Saving…" : "Save look"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LookCard({
  preset,
  index,
  active,
  recommended,
  locked,
  applying,
  disabled,
  onApply,
  onOpen,
}: {
  preset: Preset;
  index: number;
  active: boolean;
  recommended: boolean;
  locked: boolean;
  applying: boolean;
  disabled: boolean;
  onApply: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="group relative"
      style={{ "--fv-stagger": `${Math.min(index, 7) * 30}ms` } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={onApply}
        disabled={disabled || applying}
        title={locked ? `${preset.name} needs a higher plan` : `Apply "${preset.name}"`}
        aria-label={`Apply the ${preset.name} look. ${preset.description}`}
        className={cn(
          "fv-card-in fv-lift block w-full overflow-hidden rounded-xl border bg-white/[0.02] text-left",
          "transition-[border-color,box-shadow,transform,opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50",
          "disabled:pointer-events-none disabled:opacity-45",
          active
            ? "border-violet-400/50 ring-1 ring-violet-400/30"
            : "border-white/[0.08] hover:border-white/20 hover:shadow-[0_8px_24px_-16px_rgba(0,0,0,0.9)]"
        )}
      >
        <div className="relative aspect-[16/9] overflow-hidden">
          <div className="absolute inset-0 transition-transform duration-500 group-hover:scale-[1.04]">
            <PresetThumb vibe={preset.vibe} />
          </div>
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent"
          />
          {locked ? (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md border border-amber-300/40 bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-50 backdrop-blur-md">
              <Lock size={10} />
              {preset.requiredPlan === "pro" ? "Pro" : "Creator"}
            </span>
          ) : (
            recommended && (
              <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-violet-50 backdrop-blur-md">
                <Sparkles size={10} />
                Recommended
              </span>
            )
          )}
          {active && !locked && (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              <Check size={10} />
              Applied
            </span>
          )}
        </div>

        <div className="p-2.5">
          <div className="flex items-center gap-1.5">
            <h4 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-white">
              {preset.name}
            </h4>
            <span className="shrink-0 rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium capitalize text-violet-100">
              {preset.vibe}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fog">
            {preset.description}
          </p>
          <span
            className={cn(
              "mt-1.5 inline-flex items-center gap-1 rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-100",
              "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
            )}
          >
            <Wand2 size={10} />
            {applying ? "Applying…" : locked ? "Upgrade to use" : "Apply look"}
          </span>
        </div>
      </button>

      {/* Sibling, not a child — a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Details for ${preset.name}`}
        title="What this look changes"
        className={cn(
          "fv-press-sm absolute right-2 top-2 z-10 rounded-md border border-white/10 bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-md",
          "transition-[opacity,color,border-color] duration-150 hover:border-white/25 hover:text-white",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
          active ? "opacity-0 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        )}
      >
        Details
      </button>
    </div>
  );
}
