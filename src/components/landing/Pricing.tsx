import { Check, Sparkles } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";
import { pricingTiers } from "@/lib/mockData";
import { cn } from "@/lib/cn";
import { TrackedCtaButton } from "@/components/analytics/TrackedCtaButton";
import { EVENTS } from "@/lib/analytics/events";

export function Pricing() {
  return (
    <Section
      id="pricing"
      eyebrow="Pricing"
      title={
        <>
          Simple plans.{" "}
          <span className="text-gradient-violet">Polished output.</span>
        </>
      }
      subtitle="Start free. Upgrade when you need longer videos, advanced exports, and watermark-free 4K."
    >
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 lg:grid-cols-3">
        {pricingTiers.map((t, i) => (
          <RevealOnView key={t.name} delay={i * 0.06}>
            <div
              className={cn(
                "relative flex h-full flex-col rounded-2xl border bg-surface/40 p-7 backdrop-blur-xl transition-colors duration-200",
                t.highlighted
                  ? "border-violet-400/40 shadow-[0_0_60px_-12px_rgba(139,92,246,0.4),inset_0_1px_0_rgba(255,255,255,0.06)] lg:scale-[1.03]"
                  : "border-white/[0.06] hover:border-white/[0.12]"
              )}
            >
              {t.highlighted && (
                <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-violet-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white shadow-violet-glow">
                  <Sparkles size={11} />
                  Most Popular
                </span>
              )}

              <div>
                <div className="font-display text-lg font-semibold tracking-tight text-white">
                  {t.name}
                </div>
                <p className="mt-1 text-sm text-fog">{t.tagline}</p>
              </div>

              <div className="mt-6 flex items-baseline gap-1.5">
                <span className="font-display text-5xl font-semibold tracking-tight text-white">
                  {t.price}
                </span>
                <span className="text-sm text-fog">/ {t.priceUnit}</span>
              </div>

              <ul className="mt-7 space-y-3">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-white/85">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full",
                        t.highlighted
                          ? "bg-violet-500/20 text-violet-300"
                          : "bg-white/[0.04] text-fog"
                      )}
                    >
                      <Check size={11} />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-8">
                <TrackedCtaButton
                  href="/dashboard"
                  variant={t.highlighted ? "primary" : "ghost"}
                  size="md"
                  className="w-full"
                  event={EVENTS.LANDING_CTA_CLICK}
                  eventParams={{ cta: `landing_pricing_${t.name.toLowerCase()}` }}
                >
                  {t.cta}
                </TrackedCtaButton>
              </div>
            </div>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
