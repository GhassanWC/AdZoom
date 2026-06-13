import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { UseCases } from "@/components/landing/UseCases";
import { CanvasExport } from "@/components/landing/CanvasExport";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildMetadata, softwareApplicationLd } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: "Use Cases — Framevo",
  description:
    "See how Framevo edits screen recordings for SaaS product demos, YouTube tutorials, course videos, app walkthroughs, startup launches, social clips, and support how-tos.",
  path: "/use-cases",
});

export default function UseCasesPage() {
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
                Use cases
              </p>
              <h1 className="font-display text-[clamp(2.5rem,6.5vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-white">
                One editor for the{" "}
                <span className="text-gradient-violet">videos you make.</span>
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-fog">
                Product demos, tutorials, courses, walkthroughs, launches,
                social clips, and screen recordings — Framevo turns your raw
                footage into a finished, format-ready video.
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

        <UseCases />
        <CanvasExport />
        <HowItWorks />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
