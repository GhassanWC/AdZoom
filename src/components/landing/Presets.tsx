"use client";

import * as React from "react";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { presets } from "@/lib/mockData";
import { PresetThumb } from "./PresetThumb";

/**
 * Idea selector adapted from Shipper's category-chip pattern.
 *
 * A row of tabs filters the presets[] grid by `category`. "All" is the
 * default. Filtering is client-side over the already-bundled
 * `presets[]` data — no fetch, no state machine, just a `useState` and
 * an array filter.
 */

const CATEGORIES: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "creator", label: "Creator" },
  { id: "product", label: "Product" },
  { id: "tutorial", label: "Tutorial" },
];

export function Presets() {
  const [active, setActive] = React.useState<string>("all");

  const filtered = React.useMemo(
    () =>
      active === "all"
        ? presets
        : presets.filter((p) => p.category === active),
    [active]
  );

  return (
    <Section
      id="presets"
      eyebrow="Pick your starting point"
      title={
        <>
          A whole aesthetic,{" "}
          <span className="text-gradient-violet">one tap away.</span>
        </>
      }
      subtitle="Each preset wires pacing, cursor styling, click effects, and motion behaviour for a specific format. Apply one, refine from there."
    >
      {/* Category filter — Shipper-style tab row */}
      <div className="mb-10 flex justify-center">
        <div
          role="tablist"
          aria-label="Preset category"
          className="inline-flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-md"
        >
          {CATEGORIES.map(({ id, label }) => {
            const on = active === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={on}
                onClick={() => setActive(id)}
                className={
                  "rounded-xl px-4 py-2 text-[12.5px] font-semibold transition-colors duration-200 " +
                  (on
                    ? "bg-violet-500/85 text-white shadow-[0_8px_24px_-12px_rgba(139,92,246,0.7)]"
                    : "text-fog hover:bg-white/[0.04] hover:text-white")
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((p, i) => (
          <RevealOnView key={p.id} delay={(i % 6) * 0.04}>
            <article className="group glass overflow-hidden rounded-2xl transition-colors duration-200 hover:border-white/[0.12]">
              <div className="aspect-[16/10] overflow-hidden border-b border-white/[0.06]">
                <PresetThumb vibe={p.vibe} />
              </div>
              <div className="flex items-start justify-between gap-3 p-5">
                <div>
                  <h3 className="font-display text-base font-semibold tracking-tight text-white">
                    {p.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-fog">
                    {p.description}
                  </p>
                </div>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 group-hover:border-violet-400/40 group-hover:bg-violet-500/10 group-hover:text-violet-300">
                  <ArrowUpRight size={14} />
                </span>
              </div>
            </article>
          </RevealOnView>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="mt-12 text-center text-[13px] text-fog">
          No presets in this category yet.
        </p>
      )}
    </Section>
  );
}
