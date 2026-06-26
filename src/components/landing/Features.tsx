import {
  ZoomIn,
  Target,
  Lightbulb,
  SlidersHorizontal,
  MonitorPlay,
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
    Icon: ZoomIn,
    title: "AI-powered zooms",
    description:
      "Cinematic zooms that follow the cursor and frame whatever matters on screen — added automatically, then yours to retime.",
  },
  {
    Icon: Target,
    title: "Click & focus emphasis",
    description:
      "Highlight every click and softly focus attention so viewers always know exactly where to look.",
  },
  {
    Icon: Lightbulb,
    title: "AI suggestions",
    description:
      "Framevo flags edits worth making — add a zoom here, trim idle time there. Accept or dismiss each one; the AI assists, never dictates.",
  },
  {
    Icon: SlidersHorizontal,
    title: "Manual timeline editing",
    description:
      "Drag, resize, duplicate, delete, and restore any edit — with undo/redo and keyboard shortcuts. The AI drafts; you ship the final cut.",
  },
  {
    Icon: MonitorPlay,
    title: "Clean, true-to-export preview",
    description:
      "A WYSIWYG preview where the camera follows the action — what you see is exactly what the exported file looks like.",
  },
  {
    Icon: Download,
    title: "Flexible export",
    description:
      "Render in your browser on the free plan, or unlock 4K and watermark-free exports on Pro — and reframe the same edit for every platform.",
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
      subtitle="The AI builds a first-draft edit from your recording — every piece editable, none of it required."
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
