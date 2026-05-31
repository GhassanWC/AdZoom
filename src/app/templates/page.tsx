import Link from "next/link";
import { ArrowLeft, ArrowRight, Sparkles, Layers } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";
import { presets } from "@/lib/mockData";
import { PresetThumb } from "@/components/landing/PresetThumb";

export const metadata = {
  title: "Templates — AdZoom",
  description: "Starter presets and project templates for every recording format.",
};

const CATEGORY_LABEL: Record<string, string> = {
  creator: "Creator",
  tutorial: "Tutorial",
  product: "Product",
};

export default function TemplatesPage() {
  const byCategory = presets.reduce<Record<string, typeof presets>>(
    (acc, p) => {
      const cat = p.category ?? "other";
      (acc[cat] ??= []).push(p);
      return acc;
    },
    {}
  );

  return (
    <>
      <Navbar />
      <main className="relative min-h-screen px-4 pb-24 pt-28 sm:pt-36">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_65%)] blur-3xl"
        />

        <div className="mx-auto max-w-5xl">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={12} />
            Back to home
          </Link>

          <div className="mt-7 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
              <Layers size={11} />
              Templates
            </span>
            <h1 className="mx-auto mt-5 max-w-3xl font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              A starting point for{" "}
              <span className="text-gradient-violet">every format.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-[16px] leading-relaxed text-fog">
              Each preset wires pacing, cursor styling, click effects, and
              motion behaviour together. Pick one to skip a hundred
              decisions and start refining from a polished baseline.
            </p>
          </div>

          {(["creator", "product", "tutorial"] as const).map((cat) => {
            const items = byCategory[cat];
            if (!items || items.length === 0) return null;
            return (
              <section key={cat} className="mt-16">
                <div className="mb-6 flex items-baseline justify-between">
                  <h2 className="font-display text-[24px] font-semibold tracking-tight text-white">
                    {CATEGORY_LABEL[cat] ?? cat}
                  </h2>
                  <span className="text-[11.5px] uppercase tracking-[0.18em] text-fog">
                    {items.length} preset{items.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {items.map((p) => (
                    <article
                      key={p.id}
                      className="group glass overflow-hidden rounded-2xl transition-colors duration-200 hover:border-white/[0.18]"
                    >
                      <div className="aspect-[16/10] overflow-hidden border-b border-white/[0.06]">
                        <PresetThumb vibe={p.vibe} />
                      </div>
                      <div className="flex items-start justify-between gap-3 p-5">
                        <div>
                          <h3 className="font-display text-[15px] font-semibold tracking-tight text-white">
                            {p.name}
                          </h3>
                          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">
                            {p.description}
                          </p>
                        </div>
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 group-hover:border-violet-400/40 group-hover:bg-violet-500/10 group-hover:text-violet-300">
                          <ArrowRight size={13} />
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}

          <div className="mt-20 rounded-3xl border border-white/[0.06] bg-gradient-to-br from-violet-500/[0.06] to-transparent p-8 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
              <Sparkles size={18} />
            </span>
            <h3 className="mt-5 font-display text-[24px] font-semibold tracking-tight text-white">
              Open the editor to apply one.
            </h3>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-fog">
              Templates apply as presets inside the editor. Pick one,
              tweak what you like, save your own variants.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                href="/dashboard"
                variant="primary"
                size="md"
                rightIcon={<ArrowRight size={14} />}
              >
                Start Free
              </Button>
              <Button href="/docs" variant="ghost" size="md">
                Read the docs
              </Button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
