"use client";

import * as React from "react";
import Link from "next/link";
import {
  Plus,
  Sparkles,
  Wand2,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import type { Preset } from "@/lib/firebase/schema";
import { BUILTIN_PRESETS, inferPresetFromSettings } from "@/lib/presets";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  createCustomPreset,
  deleteCustomPreset,
  subscribeCustomPresets,
} from "@/lib/firebase/custom-presets";
import { useToast } from "@/components/ui/Toast";
import { PresetCard } from "@/components/dashboard/PresetCard";
import { PresetDetailModal } from "@/components/dashboard/PresetDetailModal";
import { useEditorReal } from "./context";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

export function PresetsRail() {
  const { user } = useAuth();
  const { project, applyPreset, clearSelectedPreset } = useEditorReal();
  const { plan } = useStoragePlan();
  const router = useRouter();
  const toast = useToast();
  const [custom, setCustom] = React.useState<Preset[]>([]);
  const [openPreset, setOpenPreset] = React.useState<Preset | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * A preset is "locked" when its requiredPlan exceeds the viewer's tier.
   * Custom presets never carry requiredPlan (their owner authored them, so
   * they're free to use even after a downgrade).
   */
  const isLocked = React.useCallback(
    (p: Preset): boolean => {
      if (!p.requiredPlan) return false;
      return !planMeetsMinimum(plan.tier, p.requiredPlan);
    },
    [plan.tier]
  );

  React.useEffect(() => {
    if (!user) return;
    const unsub = subscribeCustomPresets(user.uid, setCustom);
    return () => unsub();
  }, [user]);

  const recommendedIds = project.analysis?.recommendedPresetIds ?? [];
  const recommendedSet = new Set(recommendedIds);

  // Surface recommended built-ins first.
  const allPresets = React.useMemo(() => {
    const recommended = BUILTIN_PRESETS.filter((p) => recommendedSet.has(p.id));
    const others = BUILTIN_PRESETS.filter((p) => !recommendedSet.has(p.id));
    return [...recommended, ...others, ...custom];
  }, [custom, recommendedSet]);

  // Resolve which preset is "applied" — explicit, then inferred.
  const activePresetId = React.useMemo(() => {
    if (project.selectedPresetId) return project.selectedPresetId;
    const inferred = inferPresetFromSettings(project.effectsSettings, [
      ...BUILTIN_PRESETS,
      ...custom,
    ]);
    return inferred?.id ?? null;
  }, [project.selectedPresetId, project.effectsSettings, custom]);

  const onApply = async (preset: Preset) => {
    try {
      await applyPreset(preset);
      toast.success(
        "Preset applied to your current edit.",
        `${preset.name} — your AI moments and timeline are unchanged.`
      );
      setOpenPreset(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to apply preset";
      toast.error("Could not apply preset", msg);
    }
  };

  const onDuplicate = async (preset: Preset) => {
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
      toast.success("Duplicated", `Saved as "${preset.name} copy" under My Presets`);
      setOpenPreset(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to duplicate";
      toast.error("Could not duplicate", msg);
    }
  };

  const onDelete = async (preset: Preset) => {
    if (!user || !preset.isCustom) return;
    try {
      await deleteCustomPreset(user.uid, preset.id);
      toast.success("Deleted", `Removed "${preset.name}"`);
      setOpenPreset(null);
      if (project.selectedPresetId === preset.id) {
        await clearSelectedPreset();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      toast.error("Could not delete", msg);
    }
  };

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  return (
    <div className="glass rounded-2xl">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-6 py-4">
        <span className="inline-flex size-8 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-white">All presets</h3>
          <p className="text-[12px] text-fog">
            {recommendedIds.length > 0
              ? `${recommendedIds.length} recommended for this video · browse the full library`
              : "Browse the full library — one click to retune the editor"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/dashboard/presets"
            className="text-[12px] text-fog underline-offset-4 transition-colors duration-200 hover:text-white hover:underline"
          >
            Browse all
          </Link>
          <button
            onClick={() => setSaveOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[12px] font-medium text-fog transition-colors duration-200 hover:border-white/25 hover:text-white"
          >
            <Plus size={12} />
            Save current as…
          </button>
        </div>
      </div>

      <div className="relative">
        <button
          aria-label="Scroll left"
          onClick={() => scrollBy(-360)}
          className="absolute left-3 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-ink/85 text-white shadow-cinematic backdrop-blur-md transition-colors duration-200 hover:bg-ink lg:inline-flex"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          aria-label="Scroll right"
          onClick={() => scrollBy(360)}
          className="absolute right-3 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-ink/85 text-white shadow-cinematic backdrop-blur-md transition-colors duration-200 hover:bg-ink lg:inline-flex"
        >
          <ChevronRight size={15} />
        </button>

        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto px-6 py-5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {allPresets.map((p) => {
            const locked = isLocked(p);
            return (
              <div key={p.id} className="w-56 shrink-0">
                <PresetCard
                  preset={p}
                  active={activePresetId === p.id}
                  recommended={recommendedSet.has(p.id)}
                  locked={locked}
                  onOpen={() => {
                    if (locked) {
                      router.push("/pricing");
                      return;
                    }
                    setOpenPreset(p);
                  }}
                />
              </div>
            );
          })}
          {allPresets.length === 0 && (
            <div className="grid h-32 w-full place-items-center text-xs text-fog">
              No presets available.
            </div>
          )}
        </div>
      </div>

      {openPreset && (
        <PresetDetailModal
          preset={openPreset}
          open={Boolean(openPreset)}
          onClose={() => setOpenPreset(null)}
          applied={activePresetId === openPreset.id}
          currentSettings={project.effectsSettings}
          onApply={() => onApply(openPreset)}
          onDuplicate={() => onDuplicate(openPreset)}
          onDelete={openPreset.isCustom ? () => onDelete(openPreset) : undefined}
        />
      )}

      {saveOpen && (
        <SaveAsCustomDialog
          open={saveOpen}
          onClose={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

function SaveAsCustomDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { project } = useEditorReal();
  const toast = useToast();
  const [name, setName] = React.useState("My preset");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const onSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await createCustomPreset(user.uid, {
        name: name.trim() || "Untitled preset",
        description: description.trim(),
        useCase: "",
        category: "Creator",
        vibe: "cinematic",
        effects: project.effectsSettings,
      });
      toast.success("Saved", `"${name.trim()}" added under My Presets`);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      toast.error("Could not save", msg);
    } finally {
      setSaving(false);
    }
  };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] grid place-items-center bg-ink/80 px-4 backdrop-blur-xl"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-strong w-full max-w-md rounded-2xl p-6 shadow-cinematic"
      >
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          <Wand2 size={11} className="text-violet-300" />
          New custom preset
        </div>
        <h3 className="mt-1 font-display text-xl font-semibold text-white">
          Save current settings
        </h3>
        <p className="mt-1 text-sm text-fog">
          Your current sliders and toggles will be saved as a reusable preset under <strong className="text-white">My Presets</strong>.
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
          <button
            onClick={onClose}
            disabled={saving}
            className={cn(
              "rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-sm text-white/85 transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.04]"
            )}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-full bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.6)] transition-colors duration-200 hover:bg-violet-500/90 disabled:opacity-50"
          >
            <Plus size={13} />
            {saving ? "Saving…" : "Save preset"}
          </button>
        </div>
      </div>
    </div>
  );
}
