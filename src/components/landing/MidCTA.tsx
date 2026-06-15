import { ArrowRight, Play } from "lucide-react";
import { Container } from "@/components/ui/Container";
import { TrackedCtaButton } from "@/components/analytics/TrackedCtaButton";
import { EVENTS } from "@/lib/analytics/events";

/**
 * Thin gradient strip between the showcase grid and the idea selector
 * — adapted from Shipper's "Ready to be amazed?" beat. One sentence,
 * one button. No grid, no extra chrome.
 */
export function MidCTA() {
  return (
    <section className="relative py-16 lg:py-20">
      <Container>
        <div className="relative overflow-hidden rounded-3xl border border-violet-400/20 bg-gradient-to-br from-violet-500/[0.12] via-violet-500/[0.05] to-transparent px-8 py-12 text-center sm:py-14">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[280px] w-[680px] -translate-x-1/2 -translate-y-1/3 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.35),transparent_65%)] blur-3xl"
          />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
            <Play size={10} className="fill-current" />
            Demo
          </span>
          <h2 className="mx-auto mt-5 max-w-2xl font-display text-[clamp(1.85rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-white">
            Ready to see your recording{" "}
            <span className="text-gradient-violet">reframed?</span>
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[14.5px] leading-relaxed text-fog">
            Drop a screen recording in, pick a preset, watch the camera
            move where it matters. Free to start.
          </p>
          <div className="mt-7">
            <TrackedCtaButton
              href="/dashboard"
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight size={15} />}
              event={EVENTS.LANDING_CTA_CLICK}
              eventParams={{ cta: "mid_cta_start_building" }}
            >
              Start Building
            </TrackedCtaButton>
          </div>
        </div>
      </Container>
    </section>
  );
}
