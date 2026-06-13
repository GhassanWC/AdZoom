import {
  ArrowRight,
  UploadCloud,
  Scissors,
  MousePointerClick,
  Frame,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { HeroMockup } from "./HeroMockup";
import { BRAND } from "@/lib/branding";

const PROOF = [
  { Icon: UploadCloud, label: "Upload or record" },
  { Icon: Scissors, label: "AI cuts boring parts" },
  { Icon: MousePointerClick, label: "Adds zooms, clicks & focus moments" },
  { Icon: Frame, label: "Exports for every major format" },
  { Icon: SlidersHorizontal, label: "You stay in control" },
];

export function Hero() {
  return (
    <section
      id="main"
      className="relative overflow-hidden pt-32 pb-24 lg:pt-44 lg:pb-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[760px] w-[1280px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.24),transparent_62%)] blur-3xl"
      />
      <div
        aria-hidden
        className="bg-grid mask-radial pointer-events-none absolute inset-0 -z-10 opacity-40"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-ink"
      />

      <Container>
        <div className="mx-auto max-w-[960px] text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-fog backdrop-blur-md">
            <span className="size-1.5 rounded-full bg-violet-400" />
            {BRAND.name} · AI video editor
          </div>

          <h1 className="font-display text-[clamp(2.75rem,7.5vw,5.75rem)] font-semibold leading-[0.95] tracking-[-0.05em] text-white">
            Turn your videos into{" "}
            <span className="text-gradient-violet">polished edits with AI.</span>
          </h1>

          <p className="mx-auto mt-7 max-w-[700px] text-[17.5px] leading-relaxed text-fog">
            Framevo helps you cut boring parts, add zooms, highlight clicks,
            focus attention, speed up slow sections, and export for YouTube,
            TikTok, Reels, Shorts, and more.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button
              href="/dashboard/upload"
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight size={15} />}
            >
              Start editing free
            </Button>
            <Button href="#demo" variant="glass" size="lg">
              Watch demo
            </Button>
          </div>

          {/* Hero proof points */}
          <ul className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-[13px] text-fog">
            {PROOF.map(({ Icon, label }) => (
              <li key={label} className="inline-flex items-center gap-2">
                <Icon size={14} className="text-violet-300" />
                {label}
              </li>
            ))}
          </ul>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-xs text-fog/80">
            <span>No credit card</span>
            <span>Runs in your browser</span>
            <span>Preview matches export</span>
          </div>
        </div>

        <div id="demo" className="relative mx-auto mt-20 max-w-[1180px] scroll-mt-28 lg:mt-24">
          <HeroMockup />
        </div>
      </Container>
    </section>
  );
}
