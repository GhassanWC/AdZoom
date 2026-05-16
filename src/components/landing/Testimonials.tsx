import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { testimonials } from "@/lib/mockData";

export function Testimonials() {
  return (
    <Section
      eyebrow="Loved by creators"
      title={
        <>
          The editor your viewers{" "}
          <span className="text-gradient-violet">can feel.</span>
        </>
      }
      subtitle="Creators, founders, and educators ship faster and more cinematic with AdZoom."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {testimonials.map((t, i) => (
          <RevealOnView key={t.id} delay={i * 0.04}>
            <figure className="glass flex h-full flex-col rounded-2xl p-6">
              <blockquote className="flex-1 text-[15px] leading-relaxed text-white/85">
                <span className="font-display text-2xl leading-none text-violet-400/60">"</span>
                {t.quote}
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3 border-t border-white/[0.06] pt-4">
                <span
                  className={`inline-block size-9 rounded-full bg-gradient-to-br ${t.gradient} ring-2 ring-ink`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white">{t.name}</div>
                  <div className="truncate text-xs text-fog">{t.role}</div>
                </div>
              </figcaption>
            </figure>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
