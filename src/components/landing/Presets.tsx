import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { presets } from "@/lib/mockData";
import { PresetThumb } from "./PresetThumb";

export function Presets() {
  const featured = presets.slice(0, 6);
  return (
    <Section
      eyebrow="Presets"
      title={
        <>
          One click. A whole{" "}
          <span className="text-gradient-violet">aesthetic.</span>
        </>
      }
      subtitle="Each preset combines zoom rhythm, cursor styling, click effects, and motion behavior — engineered for the format."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {featured.map((p, i) => (
          <RevealOnView key={p.id} delay={i * 0.04}>
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
    </Section>
  );
}
