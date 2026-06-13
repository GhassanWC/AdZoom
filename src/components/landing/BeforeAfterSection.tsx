import { Section } from "@/components/ui/Section";
import { BeforeAfter } from "./BeforeAfter";

export function BeforeAfterSection() {
  return (
    <Section
      id="before-after"
      eyebrow="Before / after"
      title={
        <>
          Long and flat{" "}
          <span className="text-gradient-violet">becomes export-ready.</span>
        </>
      }
      subtitle="Before: a long, flat, raw recording. After: cut, paced, zoomed, and formatted — a finished video, without changing what you said."
    >
      <div className="mx-auto max-w-5xl">
        <BeforeAfter />
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-fog">
          <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px]">←</kbd>
          <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px]">→</kbd>
          <span>or drag</span>
        </div>
      </div>
    </Section>
  );
}
