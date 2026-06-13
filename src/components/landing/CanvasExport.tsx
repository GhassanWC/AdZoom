import { Section } from "@/components/ui/Section";
import { GlassCard } from "@/components/ui/GlassCard";
import { RevealOnView } from "@/components/ui/RevealOnView";

interface Format {
  label: string;
  ratio: string;
  /** Tailwind aspect box for the preview tile. */
  box: string;
}

const FORMATS: Format[] = [
  { label: "YouTube", ratio: "16:9", box: "aspect-video w-full" },
  { label: "TikTok · Reels · Shorts", ratio: "9:16", box: "aspect-[9/16] w-[42%]" },
  { label: "Square", ratio: "1:1", box: "aspect-square w-[64%]" },
  { label: "Portrait", ratio: "4:5", box: "aspect-[4/5] w-[58%]" },
];

export function CanvasExport() {
  return (
    <Section
      id="canvas"
      eyebrow="Canvas Fit"
      title={
        <>
          One video,{" "}
          <span className="text-gradient-violet">every format.</span>
        </>
      }
      subtitle="Canvas Fit reframes your edit for each platform — no re-recording, no re-cropping by hand. Export the same video as wide, vertical, square, or portrait."
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {FORMATS.map((f, i) => (
          <RevealOnView key={f.label} delay={i * 0.05}>
            <GlassCard className="flex h-full flex-col items-center gap-4 p-6">
              <div className="flex h-44 w-full items-center justify-center">
                <div
                  className={`${f.box} rounded-lg border border-violet-400/30 bg-gradient-to-br from-violet-500/20 to-violet-700/10`}
                />
              </div>
              <div className="text-center">
                <div className="font-display text-[14px] font-semibold text-white">
                  {f.label}
                </div>
                <div className="mt-0.5 font-mono text-[12px] text-fog">{f.ratio}</div>
              </div>
            </GlassCard>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
