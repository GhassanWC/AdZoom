import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { Problem } from "@/components/landing/Problem";
import { Solution } from "@/components/landing/Solution";
import { Features } from "@/components/landing/Features";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { UseCases } from "@/components/landing/UseCases";
import { BeforeAfterSection } from "@/components/landing/BeforeAfterSection";
import { CanvasExport } from "@/components/landing/CanvasExport";
import { Control } from "@/components/landing/Control";
import { Pricing } from "@/components/landing/Pricing";
import { FAQ, FAQ_ITEMS } from "@/components/landing/FAQ";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Footer } from "@/components/landing/Footer";
import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import {
  SITE,
  buildMetadata,
  organizationLd,
  websiteLd,
  softwareApplicationLd,
  faqLd,
} from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: SITE.title,
  description: SITE.description,
  path: "/",
});

export default function HomePage() {
  return (
    <>
      <JsonLd
        data={[
          organizationLd(),
          websiteLd(),
          softwareApplicationLd(),
          faqLd(FAQ_ITEMS),
        ]}
      />
      <Navbar />
      <main className="relative">
        <Hero />
        <Problem />
        <Solution />
        <Features />
        <HowItWorks />
        <UseCases />
        <BeforeAfterSection />
        <CanvasExport />
        <Control />
        <Pricing />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
