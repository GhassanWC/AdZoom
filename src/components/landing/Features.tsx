import {
  MousePointerClick,
  BookMarked,
  Crosshair,
  Compass,
  Camera,
  Layers,
  SlidersHorizontal,
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

const features: FeatureCard[] = [
  {
    Icon: MousePointerClick,
    title: "Click-aware zooms",
    description:
      "Every click is classified — primary CTA, icon, nav, form, or background — and gets a camera move sized to match.",
  },
  {
    Icon: BookMarked,
    title: "AI chapters",
    description:
      "Gemini segments the recording into narrative beats. Intro, action, result — labelled and laid out above the timeline.",
  },
  {
    Icon: Compass,
    title: "Follow cursor",
    description:
      "Cursor smoothing plus a focus mode that holds the camera on the cursor while you talk through what's on screen.",
  },
  {
    Icon: Crosshair,
    title: "Focus regions",
    description:
      "Directional framing onto the element you actually clicked. No more zooms that frame the whole tab.",
  },
  {
    Icon: Camera,
    title: "Smart camera framing",
    description:
      "Pan + zoom keyframes, scene-aware nudges, vignette and vertical reframing. Built for shipped video, not preview.",
  },
  {
    Icon: Layers,
    title: "Presets",
    description:
      "Pacing, cursor styling, click effects, motion behaviour — bundled per format. Pick MrBeast, Cinematic, Tutorial.",
  },
  {
    Icon: SlidersHorizontal,
    title: "Timeline editor",
    description:
      "Drag pills. Open the inspector. Tune intensity. Add manual keyframes. The AI gave you the draft — you ship the cut.",
  },
];

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title={
        <>
          Built for{" "}
          <span className="text-gradient-violet">guided attention.</span>
        </>
      }
      subtitle="Seven systems working together. Each is exposed in the editor, none are required to ship a good edit."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <RevealOnView key={f.title} delay={i * 0.04}>
            <GlassCard
              spotlight
              className="group relative h-full overflow-hidden p-6"
            >
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
