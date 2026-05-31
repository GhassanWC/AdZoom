import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { AIWorkflow } from "@/components/landing/AIWorkflow";
import { ShowcaseGallery } from "@/components/landing/ShowcaseGallery";
import { MidCTA } from "@/components/landing/MidCTA";
import { Presets } from "@/components/landing/Presets";
import { Pricing } from "@/components/landing/Pricing";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Footer } from "@/components/landing/Footer";

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main className="relative">
        <Hero />
        <AIWorkflow />
        <ShowcaseGallery />
        <MidCTA />
        <Presets />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
