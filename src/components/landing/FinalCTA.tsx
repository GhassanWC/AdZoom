import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";

export function FinalCTA() {
  return (
    <section className="relative overflow-hidden py-28 lg:py-36">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[500px] w-[1100px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.22),transparent_60%)] blur-3xl"
      />
      <div
        aria-hidden
        className="bg-grid mask-radial pointer-events-none absolute inset-0 -z-10 opacity-50"
      />

      <Container size="narrow">
        <div className="text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-fog backdrop-blur-md">
            <span className="size-1.5 rounded-full bg-violet-400" />
            Free to start
          </div>
          <h2 className="font-display text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[1] tracking-[-0.04em] text-white">
            Make every recording{" "}
            <span className="text-gradient-violet">cinematic.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base text-fog sm:text-lg">
            Drop in any screen recording. AdZoom does the rest — automatic
            zoom, smoothing, click effects, and reframes in seconds.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button
              href="/dashboard"
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight size={16} />}
            >
              Start Free
            </Button>
            <Button href="/dashboard" variant="glass" size="lg">
              Open Editor
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
