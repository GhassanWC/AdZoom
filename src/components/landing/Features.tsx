import {
  Sparkles,
  MousePointer2,
  Target,
  Smartphone,
  Brain,
  Activity,
  Zap,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { featureList } from "@/lib/mockData";
import type { Feature } from "@/lib/types";

const iconMap: Record<Feature["iconName"], LucideIcon> = {
  Sparkles,
  MousePointer2,
  Target,
  Smartphone,
  Brain,
  Activity,
  Zap,
  Layers,
};

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title={
        <>
          Everything you need to{" "}
          <span className="text-gradient-violet">make it cinematic.</span>
        </>
      }
      subtitle="Eight pieces of AI working together. No keyframes, no timeline scrubbing, no Premiere expertise required."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {featureList.map((f, i) => {
          const Icon = iconMap[f.iconName];
          return (
            <RevealOnView key={f.title} delay={i * 0.04}>
              <GlassCard
                spotlight
                className="group relative h-full overflow-hidden p-6"
              >
                <div className="mb-5 inline-flex size-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  <Icon size={18} />
                </div>
                <h3 className="font-display text-base font-semibold tracking-tight text-white">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-fog">
                  {f.description}
                </p>
              </GlassCard>
            </RevealOnView>
          );
        })}
      </div>
    </Section>
  );
}
