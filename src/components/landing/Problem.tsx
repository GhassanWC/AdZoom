import { Clock, Hourglass, EyeOff } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";

const PAINS = [
  {
    Icon: Hourglass,
    title: "Your videos run too long",
    body: "Dead time, loading screens, and idle pauses bury the parts that actually matter.",
  },
  {
    Icon: EyeOff,
    title: "Flat footage is hard to watch",
    body: "No zooms, no emphasis, no pacing — viewers don't know where to look and drop off.",
  },
  {
    Icon: Clock,
    title: "Manual editing eats hours",
    body: "Cutting, zooming, speeding up, and reformatting for each platform takes longer than the recording did.",
  },
];

export function Problem() {
  return (
    <Section
      id="problem"
      eyebrow="The problem"
      title={
        <>
          Raw footage isn&apos;t{" "}
          <span className="text-gradient-violet">a finished video.</span>
        </>
      }
      subtitle="The video is there — but it's long, flat, and slow, and polishing it by hand is the part nobody enjoys."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PAINS.map((p, i) => (
          <RevealOnView key={p.title} delay={i * 0.05}>
            <GlassCard className="h-full p-6">
              <div className="mb-5 inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-fog">
                <p.Icon size={18} />
              </div>
              <h3 className="font-display text-[15.5px] font-semibold tracking-tight text-white">
                {p.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fog">{p.body}</p>
            </GlassCard>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
