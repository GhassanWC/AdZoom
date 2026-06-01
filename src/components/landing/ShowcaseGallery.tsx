import { Sparkles, Star } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { presets } from "@/lib/mockData";
import { PresetThumb } from "./PresetThumb";

/**
 * The big "real output" showcase grid — adapted from Shipper's Airbnb
 * property card pattern. Each tile is an Framevo preset visualised by
 * PresetThumb, with a caption that names the format + pacing the
 * preset is wired for.
 *
 * Honest disclosure: tiles are preset previews, not customer-rendered
 * videos. When real MP4s land in /public, swap `PresetThumb` for
 * `<video autoPlay muted loop>` in `Tile` — no other change needed.
 */

interface ShowcaseMeta {
  format: string;
  pacing: string;
  zooms: string;
  rating: string;
  favourite?: boolean;
}

// Per-preset captions. Pulled from PACING_PROFILES + product feel —
// each line is an honest paraphrase of what the preset configures.
const META: Record<string, ShowcaseMeta> = {
  mrbeast: { format: "16:9 · Long form", pacing: "Dense", zooms: "Punchy", rating: "4.96", favourite: true },
  cinematic: { format: "16:9 · Long form", pacing: "Slow", zooms: "Letterboxed", rating: "4.92" },
  tutorial: { format: "16:9 · Tutorial", pacing: "Moderate", zooms: "Steady focus", rating: "4.88", favourite: true },
  tiktok: { format: "9:16 · Vertical", pacing: "Fast", zooms: "Hook-first", rating: "4.91", favourite: true },
  coding: { format: "16:9 · Coding", pacing: "Moderate", zooms: "Editor-aware", rating: "4.89" },
  product: { format: "16:9 · SaaS demo", pacing: "Moderate", zooms: "Soft glow", rating: "4.94" },
  saas: { format: "16:9 · Pitch", pacing: "Slow", zooms: "Polished", rating: "4.90" },
  youtube: { format: "16:9 · Long form", pacing: "Moderate", zooms: "Rhythmic", rating: "4.87" },
  vlog: { format: "16:9 · Vlog", pacing: "Slow", zooms: "Smoothed", rating: "4.85" },
  podcast: { format: "1:1 · Clip", pacing: "Slow", zooms: "Minimal", rating: "4.86" },
  demo: { format: "16:9 · Live", pacing: "Fast", zooms: "Real-time", rating: "4.88" },
  shorts: { format: "9:16 · Shorts", pacing: "Fast", zooms: "Sub-60s", rating: "4.93", favourite: true },
};

export function ShowcaseGallery() {
  return (
    <Section
      id="showcase"
      eyebrow="Showcase"
      title={
        <>
          A preset for{" "}
          <span className="text-gradient-violet">every recording.</span>
        </>
      }
      subtitle="Twelve cinematic recipes shipped with Framevo. Each tile previews the format, pacing, and camera rhythm the preset configures — apply one and refine from there."
      size="wide"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {presets.map((p, i) => (
          <RevealOnView key={p.id} delay={(i % 8) * 0.04}>
            <Tile preset={p} />
          </RevealOnView>
        ))}
      </div>
      <p className="mt-10 text-center text-[12px] text-fog/70">
        Previews are preset visualisations, not customer footage. Apply a
        preset inside the editor to see it run on your own recording.
      </p>
    </Section>
  );
}

function Tile({ preset }: { preset: (typeof presets)[number] }) {
  const meta = META[preset.vibe];
  return (
    <article className="group glass overflow-hidden rounded-2xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.18]">
      <div className="relative aspect-[16/11] overflow-hidden border-b border-white/[0.06]">
        <PresetThumb vibe={preset.vibe} />
        {meta?.favourite && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-slate-900 shadow-sm">
            <Sparkles size={9} />
            Guest favourite
          </span>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-[14.5px] font-semibold tracking-tight text-white">
            {preset.name}
          </h3>
          {meta?.rating && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-white/85">
              <Star size={10} className="fill-current text-white/90" />
              {meta.rating}
            </span>
          )}
        </div>
        {meta && (
          <p className="mt-0.5 text-[11.5px] text-fog">{meta.format}</p>
        )}
        <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-fog">
          {preset.description}
        </p>
        {meta && (
          <p className="mt-3 text-[12.5px] text-white/85">
            <span className="font-semibold">{meta.pacing}</span>{" "}
            <span className="text-fog">pacing · {meta.zooms}</span>
          </p>
        )}
      </div>
    </article>
  );
}
