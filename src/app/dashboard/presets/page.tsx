"use client";

import * as React from "react";
import { Sparkles, Plus, Loader2, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import {
  BUILTIN_PRESETS,
  BUILTIN_PRESETS_BY_ID,
  PRESET_CATEGORIES,
  applyPresetToSettings,
} from "@/lib/presets";
import {
  createCustomPreset,
  deleteCustomPreset,
  subscribeCustomPresets,
} from "@/lib/firebase/custom-presets";
import { subscribeProjects } from "@/lib/firebase/projects";
import type {
  Preset,
  PresetCategory,
  ProjectDoc,
} from "@/lib/firebase/schema";
import { serverTimestamp, setDoc, doc } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";

import { PageHeader } from "@/components/dashboard/PageHeader";
import { PresetCard } from "@/components/dashboard/PresetCard";
import { PresetDetailModal } from "@/components/dashboard/PresetDetailModal";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type CategoryFilter = "All" | PresetCategory | "My Presets";
const TABS: CategoryFilter[] = ["All", ...PRESET_CATEGORIES, "My Presets"];

export default function PresetsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [custom, setCustom] = React.useState<Preset[]>([]);
  const [projects, setProjects] = React.useState<ProjectDoc[]>([]);
  const [tab, setTab] = React.useState<CategoryFilter>("All");
  const [open, setOpen] = React.useState<Preset | null>(null);
  const [applyTarget, setApplyTarget] = React.useState<{
    preset: Preset;
  } | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    setLoaded(false);
    const unsubP = subscribeCustomPresets(user.uid, (p) => {
      setCustom(p);
      setLoaded(true);
    });
    const unsubProj = subscribeProjects(user.uid, setProjects);
    return () => {
      unsubP();
      unsubProj();
    };
  }, [user]);

  const allPresets = React.useMemo(
    () => [...BUILTIN_PRESETS, ...custom],
    [custom]
  );

  const filtered = React.useMemo(() => {
    if (tab === "All") return allPresets;
    if (tab === "My Presets") return custom;
    return allPresets.filter((p) => p.category === tab);
  }, [allPresets, custom, tab]);

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
      toast.success("Duplicated", `Saved as "${preset.name} copy"`);
      setOpen(null);
      setTab("My Presets");
    } catch (err) {
      toast.error("Could not duplicate", errMsg(err));
    }
  };

  const onDelete = async (preset: Preset) => {
    if (!user || !preset.isCustom) return;
    try {
      await deleteCustomPreset(user.uid, preset.id);
      toast.success("Deleted", `Removed "${preset.name}"`);
      setOpen(null);
    } catch (err) {
      toast.error("Could not delete", errMsg(err));
    }
  };

  const applyToProject = async (preset: Preset, project: ProjectDoc) => {
    if (!user) return;
    try {
      const next = applyPresetToSettings(project.effectsSettings, preset);
      // Direct merge write so we set both fields + selectedPresetId atomically.
      const { db } = getFirebase();
      await setDoc(
        doc(db, "users", user.uid, "projects", project.id),
        {
          effectsSettings: next,
          selectedPresetId: preset.id,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      toast.success("Preset applied", `${preset.name} → ${project.title}`);
      setApplyTarget(null);
      setOpen(null);
    } catch (err) {
      toast.error("Could not apply", errMsg(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Presets"
        title="Preset library"
        subtitle="Each preset is a real bundle of editor settings. Apply one to any project to retune zoom, cursor, pacing, and export format."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="-mx-1 flex max-w-full flex-1 gap-1 overflow-x-auto px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                tab === t
                  ? "border-violet-400/30 bg-violet-500/15 text-violet-200"
                  : "border-white/10 bg-white/[0.02] text-fog hover:border-white/20 hover:text-white"
              )}
            >
              {t}
              {t === "My Presets" && custom.length > 0 && (
                <span className="ml-1.5 inline-flex h-4 items-center rounded-full bg-white/[0.06] px-1.5 text-[10px] font-medium text-white/85">
                  {custom.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "My Presets" && custom.length === 0 ? (
        <EmptyCustom />
      ) : !loaded ? (
        <div className="glass grid place-items-center rounded-2xl p-12 text-sm text-fog">
          <Loader2 size={14} className="mr-2 inline animate-spin text-violet-300" />
          Loading presets…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              onOpen={() => setOpen(p)}
            />
          ))}
        </div>
      )}

      {open && (
        <PresetDetailModal
          preset={open}
          open={Boolean(open)}
          onClose={() => setOpen(null)}
          applyLabel="Apply to a project"
          onApply={() => setApplyTarget({ preset: open })}
          onDuplicate={() => onDuplicate(open)}
          onDelete={open.isCustom ? () => onDelete(open) : undefined}
        />
      )}

      {applyTarget && (
        <ApplyToProjectDialog
          preset={applyTarget.preset}
          projects={projects}
          onClose={() => setApplyTarget(null)}
          onPick={(project) => applyToProject(applyTarget.preset, project)}
        />
      )}
    </div>
  );
}

function ApplyToProjectDialog({
  preset,
  projects,
  onClose,
  onPick,
}: {
  preset: Preset;
  projects: ProjectDoc[];
  onClose: () => void;
  onPick: (p: ProjectDoc) => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[110] grid place-items-center bg-ink/85 px-4 backdrop-blur-xl"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-strong w-full max-w-md rounded-2xl p-6 shadow-cinematic"
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
          Apply preset
        </div>
        <h3 className="mt-1 font-display text-xl font-semibold text-white">
          Apply {preset.name} to…
        </h3>
        <p className="mt-1 text-sm text-fog">
          Pick a project to retune. The preset rewrites zoom, cursor, pacing, and export format.
        </p>

        <div className="mt-5 max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02]">
          {projects.length === 0 ? (
            <div className="grid place-items-center p-8 text-sm text-fog">
              No projects yet. Upload a video first.
            </div>
          ) : (
            projects.map((p) => {
              const applied = p.selectedPresetId === preset.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onPick(p)}
                  className="flex w-full items-center gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors duration-150 last:border-b-0 hover:bg-white/[0.04]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {p.title}
                    </div>
                    <div className="truncate text-[11px] text-fog">
                      {p.status}{" "}
                      {p.selectedPresetId && (
                        <span className="text-violet-300">
                          · current: {BUILTIN_PRESETS_BY_ID[p.selectedPresetId]?.name ?? "custom"}
                        </span>
                      )}
                    </div>
                  </div>
                  {applied ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                      Applied
                    </span>
                  ) : (
                    <Sparkles size={12} className="text-violet-300" />
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <Button onClick={onClose} variant="ghost" size="sm">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyCustom() {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-10 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-40 w-72 -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),transparent_60%)] blur-2xl"
      />
      <div className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/10 text-violet-300">
        <Plus size={20} />
      </div>
      <h3 className="mt-4 font-display text-lg font-semibold text-white">
        No custom presets yet
      </h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-fog">
        Open any project, tune the sliders, then click <strong className="text-white">Save current as…</strong> in the presets rail.
      </p>
      <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-fog">
        <ChevronDown size={11} />
        Or duplicate any built-in preset.
      </div>
    </div>
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
