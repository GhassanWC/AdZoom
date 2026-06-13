import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";

/**
 * Closing CTA panel — adapted from Shipper's "Your idea deserves to
 * be live" bottom-of-page moment. Single dramatic dark panel with
 * vertical-stripe backdrop, large mixed serif/italic headline,
 * subhead, and a single chunky primary button.
 *
 * Honest copy note: no "Join thousands of builders" — Framevo has no
 * user-count to claim. The subhead leads with the value proposition
 * instead.
 */
export function FinalCTA() {
  return (
    <section className="relative overflow-hidden px-4 pb-24 pt-12 lg:px-8 lg:pb-32">
      <Container size="wide">
        <div className="relative isolate overflow-hidden rounded-[40px] border border-white/10 bg-[#0A0A1A] px-6 py-24 text-center sm:py-28 lg:py-36">
          {/* vertical stripe pattern — Shipper's curtain backdrop */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 opacity-[0.45]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 26px)",
            }}
          />
          {/* deep radial pool */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[640px] w-[1100px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(60,40,160,0.55),rgba(15,8,40,0)_65%)] blur-2xl"
          />
          {/* edge vignette */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55)_100%)]"
          />

          {/* Panel is always visually dark (Shipper's curtain) — bypass
              the global light-mode text-white → slate override by using
              arbitrary color values that don't match the override
              selector. */}
          <h2
            className="mx-auto max-w-[1000px] font-display text-[clamp(2.5rem,7.5vw,5.5rem)] font-semibold leading-[1] tracking-[-0.04em] text-[#fff]"
          >
            Make your next video{" "}
            <em className="font-serif font-normal italic text-[#fff]">
              look finished
            </em>
          </h2>

          <p className="mx-auto mt-7 max-w-xl text-[15.5px] leading-relaxed text-[rgba(255,255,255,0.78)] sm:text-[16.5px]">
            Upload a video or record your screen, and Framevo drafts the cuts,
            speed-ups, and camera edits. Review the timeline and export for any
            platform.
          </p>

          <div className="mt-12">
            <Button href="/dashboard/upload" variant="primary" size="lg">
              Start editing free
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
