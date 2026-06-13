import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Features } from "@/components/landing/Features";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Control } from "@/components/landing/Control";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildMetadata, softwareApplicationLd, faqLd } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "AI Screen Recording Editor — Framevo",
  description:
    "Framevo is an AI screen recording editor. Upload a screen recording and it automatically adds zooms, cuts the boring parts, speeds up slow sections, and exports for YouTube, TikTok, Reels, and Shorts.",
  path: "/screen-recording-editor",
});

const FAQ = [
  {
    q: "What is the best AI screen recording editor?",
    a: "Framevo is an AI screen recording editor built specifically for screen captures: it adds camera zooms on clicks, cuts dead time, speeds up slow sections, and reframes for any platform — all editable in the browser.",
  },
  {
    q: "Is Framevo a Screen Studio alternative?",
    a: "Yes. Framevo is a browser-based alternative to Screen Studio and a faster way to edit screen recordings than CapCut, with automatic AI cuts, zooms, and speed-ups instead of manual keyframing.",
  },
  {
    q: "Can it auto-cut my screen recordings?",
    a: "Yes — Framevo detects idle stretches, loading screens, and dead sections and suggests cuts that genuinely shorten the output. Every cut is reviewable and can be restored.",
  },
];

export default function ScreenRecordingEditorPage() {
  return (
    <>
      <JsonLd data={[softwareApplicationLd(), faqLd(FAQ)]} />
      <Navbar />
      <main className="relative">
        <section className="relative overflow-hidden pt-32 pb-16 lg:pt-44 lg:pb-20">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[640px] w-[1200px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.2),transparent_62%)] blur-3xl"
          />
          <Container>
            <div className="mx-auto max-w-3xl text-center">
              <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-fog">
                AI screen recording editor
              </p>
              <h1 className="font-display text-[clamp(2.5rem,6.5vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-white">
                The AI editor built for{" "}
                <span className="text-gradient-violet">screen recordings.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-fog">
                Most editors treat a screen capture like any other clip. Framevo
                reads it like a screen recording — following the cursor and
                clicks, cutting the dead time, speeding up the slow parts, and
                framing each moment so viewers always know where to look.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Button
                  href="/dashboard/upload"
                  variant="primary"
                  size="lg"
                  rightIcon={<ArrowRight size={15} />}
                >
                  Start editing free
                </Button>
                <Button href="/features" variant="glass" size="lg">
                  See all features
                </Button>
              </div>
            </div>
          </Container>
        </section>

        <Features />
        <HowItWorks />
        <Control />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
