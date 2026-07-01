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
import { Sparkles, Check, Clock } from "lucide-react";
import {
  CATEGORY_LABELS,
  IMPLEMENTED_CATEGORIES,
  type EditOperationCategory,
  type EditRecipePlan,
} from "@/lib/analysis/edit-recipe";
import { VIDEO_TYPE_META } from "@/lib/analysis/video-type";
import type { DetectedMoment } from "@/lib/firebase/schema";

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
}: {
  recipe: EditRecipePlan;
  moments: DetectedMoment[];
}) {
  // Applied = implemented, recipe-enabled categories that ACTUALLY produced
  // edits on the timeline (count > 0). This is the honest bar: a category is
  // shown as applied only when it really ran + is export-supported — never just
  // because the recipe wanted it. Deduped (a type can list a category twice).
  const appliedCats = Array.from(
    new Set(
      recipe.operations
        .filter((o) => IMPLEMENTED_CATEGORIES.has(o.category) && o.enabled && !o.planned)
        .map((o) => o.category)
    )
  )
    .map((category) => ({ category, count: countForCategory(category, moments) }))
    .filter((a) => a.count > 0);
  const appliedTotal = appliedCats.reduce((n, a) => n + a.count, 0);

  // Planned = declared-but-not-executed categories (captions, music, blur …).
  // Also includes any implemented-but-not-yet-generated category so the user
  // never sees it counted as applied. Dedupe.
  const planned: EditOperationCategory[] = Array.from(
    new Set(
      recipe.operations
        .filter((o) => o.planned || (o.enabled && countForCategory(o.category, moments) === 0))
        .map((o) => o.category)
    )
  );

  const requestedLabel = VIDEO_TYPE_META[recipe.requestedVideoType]?.label;
  const effectiveLabel =
    VIDEO_TYPE_META[recipe.effectiveVideoType]?.label ?? recipe.recipeName;
  const autoResolved =
    recipe.requestedVideoType === "auto" &&
    recipe.effectiveVideoType !== "auto";

  return (
    <section className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-violet-300" />
          <span className="text-[12.5px] font-semibold tracking-tight text-white/90">
            AI Edit Recipe
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
          {appliedTotal} edit{appliedTotal === 1 ? "" : "s"} applied
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
    </section>
  );
}
