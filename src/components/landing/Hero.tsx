import { Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { HeroMockup } from "./HeroMockup";

export function Hero() {
  return (
    <section
      id="main"
      className="relative overflow-hidden pt-28 pb-24 lg:pt-36 lg:pb-32"
    >
      {/* radial violet glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[600px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.22),transparent_60%)] blur-3xl"
      />
      {/* grid mask */}
      <div
        aria-hidden
        className="bg-grid mask-radial pointer-events-none absolute inset-0 -z-10 opacity-50"
      />
      {/* bottom fade */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-ink"
      />

      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="text-center lg:text-left">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-fog backdrop-blur-md">
              <Sparkles size={12} className="text-violet-300" />
              AI screen recording
            </div>

            <h1 className="font-display text-[clamp(2.75rem,7vw,5.5rem)] font-semibold leading-[0.95] tracking-[-0.04em] text-white">
              Turn boring screen recordings into{" "}
              <span className="text-gradient-violet">cinematic videos.</span>
            </h1>

            <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-fog sm:text-lg lg:mx-0">
              AdZoom is the AI editor for creators. It automatically adds
              zooms, cursor focus, click highlights, and vertical reframing —
              in seconds.
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Button href="/dashboard" variant="primary" size="lg">
                Start Free
              </Button>
              <Button
                href="#demo"
                variant="glass"
                size="lg"
                leftIcon={<Play size={14} className="fill-white" />}
              >
                Watch Demo
              </Button>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-fog lg:justify-start">
              <span className="inline-flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                No credit card
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-violet-400" />
                4K renders
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-cyan-400" />
                Mac & Windows
              </span>
            </div>
          </div>

          <div className="relative">
            <HeroMockup />
          </div>
        </div>
      </Container>
    </section>
  );
}
