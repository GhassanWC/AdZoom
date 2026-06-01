"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Wand2, Check, ArrowRight, Lock } from "lucide-react";
import type { Preset } from "@/lib/firebase/schema";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import { useToast } from "@/components/ui/Toast";
import { PresetThumb } from "@/components/landing/PresetThumb";
import { PresetDetailModal } from "@/components/dashboard/PresetDetailModal";
import { useEditorReal } from "./context";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { planMeetsMinimum } from "@/lib/usage/plan";
import { cn } from "@/lib/cn";

/**
 * Premium "Recommended for this recording" hero. Big cinematic thumbnails, the
 * first card promoted as a hero, the rest as supporting picks.
 */
export function RecommendedPresets() {
  const { project, applyPreset } = useEditorReal();
  const { plan } = useStoragePlan();
  const router = useRouter();
  const toast = useToast();
  const ids = project.analysis?.recommendedPresetIds ?? [];
  const [openPreset, setOpenPreset] = React.useState<Preset | null>(null);

  const recommended = React.useMemo(
    () => ids.map((id) => BUILTIN_PRESETS_BY_ID[id]).filter(Boolean),
    [ids]
  );

  if (recommended.length === 0) return null;

  const [hero, ...rest] = recommended;
  const activeId = project.selectedPresetId;

  const isLocked = (p: Preset): boolean =>
    !!p.requiredPlan && !planMeetsMinimum(plan.tier, p.requiredPlan);

  const onApply = async (preset: Preset) => {
    if (isLocked(preset)) {
      router.push("/pricing");
      return;
    }
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

  return (
    <div className="glass relative overflow-hidden rounded-2xl p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 right-0 h-48 w-[28rem] bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.22),transparent_60%)] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-16 left-0 h-40 w-80 bg-[radial-gradient(ellipse_at_bottom_left,rgba(34,211,238,0.12),transparent_70%)] blur-3xl"
      />

      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">
            <Sparkles size={11} />
            Recommended for this recording
          </div>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-white">
            One-click cinematic looks
          </h2>
          <p className="mt-1 text-[13px] text-fog">
            Tuned to what Framevo detected. Apply one as a starting point, then
            refine on the timeline.
          </p>
        </div>
      </div>

      <div className="relative mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* HERO recommendation */}
        <HeroPresetCard
          preset={hero}
          active={activeId === hero.id}
          locked={isLocked(hero)}
          onApply={() => onApply(hero)}
          onOpen={() => (isLocked(hero) ? router.push("/pricing") : setOpenPreset(hero))}
        />

        {/* Supporting recommendations */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {rest.map((p, i) => (
            <SupportingPresetCard
              key={p.id}
              preset={p}
              rank={i + 2}
              active={activeId === p.id}
              locked={isLocked(p)}
              onApply={() => onApply(p)}
              onOpen={() => (isLocked(p) ? router.push("/pricing") : setOpenPreset(p))}
            />
          ))}
        </div>
      </div>

      {openPreset && (
        <PresetDetailModal
          preset={openPreset}
          open={Boolean(openPreset)}
          onClose={() => setOpenPreset(null)}
          applied={project.selectedPresetId === openPreset.id}
          currentSettings={project.effectsSettings}
          onApply={() => onApply(openPreset)}
        />
      )}
    </div>
  );
}

function HeroPresetCard({
  preset,
  active,
  locked,
  onApply,
  onOpen,
}: {
  preset: Preset;
  active: boolean;
  locked?: boolean;
  onApply: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-white/[0.02] transition-all duration-300",
        active
          ? "border-violet-400/50 shadow-[0_0_48px_-12px_rgba(139,92,246,0.55)] ring-2 ring-violet-400/30"
          : "border-white/10 hover:-translate-y-0.5 hover:border-white/25 hover:shadow-cinematic"
      )}
    >
      <div className="relative aspect-[16/9] overflow-hidden">
        <div className="absolute inset-0 transition-transform duration-700 group-hover:scale-[1.04]">
          <PresetThumb vibe={preset.vibe} />
        </div>
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent"
        />
        {locked ? (
          <span className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-400/25 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-50 backdrop-blur-md">
            <Lock size={11} />
            {preset.requiredPlan === "pro" ? "Pro" : "Creator"} plan
          </span>
        ) : (
          <span className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-violet-400/50 bg-violet-500/30 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-100 backdrop-blur-md">
            <Sparkles size={11} />
            Top pick for you
          </span>
        )}
        {active && !locked && (
          <span className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-violet-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white shadow-violet-glow">
            <Check size={11} />
            Applied
          </span>
        )}

        <div className="absolute inset-x-4 bottom-4">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200">
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-white/90">
              {preset.category}
            </span>
            <span className="capitalize">{preset.vibe}</span>
          </div>
          <h3 className="mt-1.5 font-display text-2xl font-semibold leading-tight text-white">
            {preset.name}
          </h3>
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="line-clamp-2 text-[13px] leading-relaxed text-fog">
          {preset.description}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={onApply}
            className="group/btn inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(139,92,246,0.6)] transition-all duration-200 hover:bg-violet-500/90 active:scale-[0.98]"
          >
            {locked ? <Lock size={14} /> : <Wand2 size={14} />}
            {locked ? "Upgrade to use" : "Apply this preset"}
            <ArrowRight
              size={13}
              className="transition-transform duration-200 group-hover/btn:translate-x-0.5"
            />
          </button>
          <button
            onClick={onOpen}
            className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-[13px] font-medium text-fog transition-colors duration-200 hover:border-white/25 hover:text-white"
          >
            Details
          </button>
        </div>
      </div>
    </div>
  );
}

function SupportingPresetCard({
  preset,
  rank,
  active,
  locked,
  onApply,
  onOpen,
}: {
  preset: Preset;
  rank: number;
  active: boolean;
  locked?: boolean;
  onApply: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "group/sup relative overflow-hidden rounded-2xl border bg-white/[0.02] transition-all duration-300",
        active
          ? "border-violet-400/50 ring-2 ring-violet-400/30"
          : "border-white/10 hover:-translate-y-0.5 hover:border-white/25"
      )}
    >
      <div className="flex items-stretch gap-3 p-3">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl border border-white/10">
          <div className="absolute inset-0 transition-transform duration-500 group-hover/sup:scale-110">
            <PresetThumb vibe={preset.vibe} />
          </div>
          <span className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/55 text-[10px] font-bold text-white/90 ring-1 ring-white/10">
            #{rank}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="truncate font-display text-[15px] font-semibold leading-tight text-white">
                {preset.name}
              </h3>
              {active && (
                <Check size={12} className="shrink-0 text-violet-300" aria-label="Applied" />
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-fog">
              {preset.description}
            </p>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={onApply}
              className="inline-flex items-center gap-1 rounded-lg bg-violet-500/15 px-2.5 py-1 text-[11px] font-semibold text-violet-100 ring-1 ring-violet-400/30 transition-colors duration-200 hover:bg-violet-500/25"
            >
              {locked ? <Lock size={10} /> : <Wand2 size={10} />}
              {locked ? "Upgrade" : "Apply"}
            </button>
            <button
              onClick={onOpen}
              className="text-[11px] text-fog underline-offset-4 transition-colors duration-200 hover:text-white hover:underline"
            >
              Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
