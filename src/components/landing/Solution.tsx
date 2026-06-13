import { Scissors, FastForward, MousePointerClick, Frame, Download } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";

const LAYERS = [
  { Icon: Scissors, label: "Cuts", sub: "Dead & idle sections removed" },
  { Icon: FastForward, label: "Speed-ups", sub: "Slow parts accelerated" },
  { Icon: MousePointerClick, label: "Camera edits", sub: "Zooms, clicks, focus" },
  { Icon: Frame, label: "Canvas Fit", sub: "Reframed for any platform" },
  { Icon: Download, label: "Export", sub: "Rendered in your browser" },
];

export function Solution() {
  return (
    <Section
      id="solution"
      eyebrow="The solution"
      title={
        <>
          Framevo watches your video and{" "}
          <span className="text-gradient-violet">builds the edit.</span>
        </>
      }
      subtitle="The AI analyzes your video and drafts a fully editable timeline — cuts, speed-ups, and camera moves laid down automatically, ready for you to review."
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {LAYERS.map((l, i) => (
          <RevealOnView key={l.label} delay={i * 0.05}>
            <GlassCard className="flex h-full flex-col items-center gap-3 p-6 text-center">
              <span className="inline-flex size-11 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <l.Icon size={19} />
              </span>
              <div>
                <div className="font-display text-[14px] font-semibold text-white">
                  {l.label}
                </div>
                <div className="mt-1 text-[12px] leading-snug text-fog">{l.sub}</div>
              </div>
            </GlassCard>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
