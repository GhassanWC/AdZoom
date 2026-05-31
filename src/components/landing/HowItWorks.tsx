import {
  Video,
  BrainCircuit,
  Wand2,
  Download,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

interface Step {
  n: string;
  Icon: LucideIcon;
  title: string;
  body: string;
}

const steps: Step[] = [
  {
    n: "01",
    Icon: Video,
    title: "Record",
    body: "Capture any browser tab or app window. Every click, scroll, and navigation is captured alongside the pixels.",
  },
  {
    n: "02",
    Icon: BrainCircuit,
    title: "Analyze",
    body: "Gemini reads the recording. AdZoom classifies the video, splits it into narrative chapters, and turns each meaningful click into a camera move.",
  },
  {
    n: "03",
    Icon: Wand2,
    title: "Refine",
    body: "Open the timeline. Drag pills, tune focus regions, pick a preset, adjust keyframes. The AI gave you a draft — you keep the final cut.",
  },
  {
    n: "04",
    Icon: Download,
    title: "Export",
    body: "Render in 1080p or 4K. Switch to vertical for Shorts and Reels. Watermark-free on paid plans.",
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title={
        <>
          From raw recording to{" "}
          <span className="text-gradient-violet">finished edit.</span>
        </>
      }
      subtitle="Four stages. The first three happen automatically — you join at the refine step."
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute left-[5%] right-[5%] top-[44px] hidden h-px lg:block"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.45) 50%, transparent 100%)",
          }}
        />

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <RevealOnView key={s.n} delay={i * 0.06}>
              <div className="glass relative h-full rounded-2xl p-6">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-11 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <s.Icon size={19} />
                  </span>
                  <span className="font-display text-[11px] font-semibold uppercase tracking-[0.2em] text-fog">
                    Step {s.n}
                  </span>
                </div>
                <h3 className="mt-5 font-display text-[19px] font-semibold tracking-tight text-white">
                  {s.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-fog">
                  {s.body}
                </p>
              </div>
            </RevealOnView>
          ))}
        </div>
      </div>
    </Section>
  );
}
