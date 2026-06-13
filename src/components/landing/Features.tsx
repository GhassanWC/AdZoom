import {
  MousePointerClick,
  Scissors,
  FastForward,
  Frame,
  SlidersHorizontal,
  Download,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";

interface FeatureCard {
  Icon: LucideIcon;
  title: string;
  description: string;
}

export const FEATURE_CARDS: FeatureCard[] = [
  {
    Icon: MousePointerClick,
    title: "AI Camera Edits",
    description:
      "Automatically add zooms, click highlights, and focus moments when something important happens on screen.",
  },
  {
    Icon: Scissors,
    title: "AI Cuts",
    description:
      "Remove boring, idle, or dead sections so the final video feels tighter.",
  },
  {
    Icon: FastForward,
    title: "Smart Speed-ups",
    description: "Speed up slow parts without cutting them completely.",
  },
  {
    Icon: Frame,
    title: "Canvas Fit",
    description:
      "Prepare videos for YouTube, TikTok, Reels, Shorts, square, or portrait formats.",
  },
  {
    Icon: SlidersHorizontal,
    title: "Manual Timeline",
    description:
      "Drag, resize, delete, restore, and fine-tune every AI edit.",
  },
  {
    Icon: Download,
    title: "Background Export",
    description: "Keep working while Framevo renders your video.",
  },
];

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title={
        <>
          Everything an{" "}
          <span className="text-gradient-violet">AI video editor</span> should
          do.
        </>
      }
      subtitle="Six systems work together to turn your video into a finished edit — each one editable, none of them required."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {FEATURE_CARDS.map((f, i) => (
          <RevealOnView key={f.title} delay={i * 0.04}>
            <GlassCard spotlight className="group relative h-full overflow-hidden p-6">
              <div className="mb-5 inline-flex size-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <f.Icon size={18} />
              </div>
              <h3 className="font-display text-[15.5px] font-semibold tracking-tight text-white">
                {f.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fog">
                {f.description}
              </p>
            </GlassCard>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
