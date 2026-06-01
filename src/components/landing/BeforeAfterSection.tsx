import { Section } from "@/components/ui/Section";
import { BeforeAfter } from "./BeforeAfter";

export function BeforeAfterSection() {
  return (
    <Section
      id="product"
      eyebrow="Raw vs guided"
      title={
        <>
          Same recording.{" "}
          <span className="text-gradient-violet">Two stories.</span>
        </>
      }
      subtitle="The raw capture leaves the viewer to find what matters. Framevo directs their attention — click by click, beat by beat — without changing what you said."
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
