import { Section } from "@/components/ui/Section";
import { BeforeAfter } from "./BeforeAfter";

export function BeforeAfterSection() {
  return (
    <Section
      id="product"
      eyebrow="Before / After"
      title={
        <>
          See the AI transformation —{" "}
          <span className="text-gradient-violet">drag to compare.</span>
        </>
      }
      subtitle="Same recording, zero edits. AdZoom analyzes cursor movement, clicks, and focus regions in real time, then composes a cinematic cut you can ship."
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
