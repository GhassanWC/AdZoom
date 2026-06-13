import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Features } from "@/components/landing/Features";
import { CanvasExport } from "@/components/landing/CanvasExport";
import { Control } from "@/components/landing/Control";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildMetadata, softwareApplicationLd } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Features — Framevo",
  description:
    "Explore Framevo's features: AI camera edits, automatic cuts, smart speed-ups, Canvas Fit multi-format export, a manual editing timeline, and background browser rendering.",
  path: "/features",
});

export default function FeaturesPage() {
  return (
    <>
      <JsonLd data={softwareApplicationLd()} />
      <Navbar />
      <main className="relative">
        <section className="relative overflow-hidden pt-32 pb-8 lg:pt-44 lg:pb-12">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[600px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.2),transparent_62%)] blur-3xl"
          />
          <Container>
            <div className="mx-auto max-w-3xl text-center">
              <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-fog">
                Features
              </p>
              <h1 className="font-display text-[clamp(2.5rem,6.5vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-white">
                Six AI engines,{" "}
                <span className="text-gradient-violet">one timeline.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-fog">
                Framevo's editing engines run automatically on every video — and
                every result is yours to review, adjust, or undo.
              </p>
              <div className="mt-9 flex justify-center">
                <Button
                  href="/dashboard/upload"
                  variant="primary"
                  size="lg"
                  rightIcon={<ArrowRight size={15} />}
                >
                  Start editing free
                </Button>
              </div>
            </div>
          </Container>
        </section>

        <Features />
        <CanvasExport />
        <Control />
        <HowItWorks />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
