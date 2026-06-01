import Link from "next/link";
import { ArrowLeft, ArrowRight, Mail, PenLine, Sparkles } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "Blog — Framevo",
  description: "Notes on building Framevo, attention-aware editing, and shipped features.",
};

export default function BlogPage() {
  return (
    <>
      <Navbar />
      <main className="relative min-h-screen px-4 pb-24 pt-28 sm:pt-36">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_65%)] blur-3xl"
        />

        <div className="mx-auto max-w-3xl">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={12} />
            Back to home
          </Link>

          <div className="mt-7">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
              <PenLine size={11} />
              Blog
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              Notes from the{" "}
              <span className="text-gradient-violet">workshop.</span>
            </h1>
            <p className="mt-6 text-[16px] leading-relaxed text-fog">
              Posts on what we&apos;re building, what we learned shipping it,
              and how the pipeline actually decides where the camera goes.
              First entries land soon.
            </p>
          </div>

          {/* Empty-state list — when posts ship, replace with a map() */}
          <section className="mt-12 rounded-3xl border border-dashed border-white/10 bg-white/[0.015] px-8 py-16 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
              <Sparkles size={18} />
            </span>
            <h2 className="mt-5 font-display text-[22px] font-semibold tracking-tight text-white">
              No posts yet.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-fog">
              We&apos;re heads-down on the editor. When we surface to write,
              the first pieces will cover how the click classifier picks
              tiers, why the balancer drops clicks, and how Gemini segments
              narrative beats.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button
                href="mailto:support@framevo.app?subject=Subscribe%20me%20to%20the%20Framevo%20blog"
                variant="primary"
                size="md"
                leftIcon={<Mail size={13} />}
              >
                Get notified
              </Button>
              <Button
                href="/dashboard"
                variant="ghost"
                size="md"
                rightIcon={<ArrowRight size={13} />}
              >
                Try the editor
              </Button>
            </div>
          </section>

          <section className="mt-16">
            <h2 className="font-display text-[20px] font-semibold tracking-tight text-white">
              What we&apos;ll write about
            </h2>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Topic
                title="Click tiers"
                body="How Framevo classifies a click as primary CTA, icon, nav, form, or background — and why that decides the camera move."
              />
              <Topic
                title="The balancer"
                body="Why a 6-click recording can end up with one zoom — and the per-stage rules we added so it doesn't."
              />
              <Topic
                title="Narrative segmentation"
                body="What Gemini sees when it splits a recording into intro / action / result chapters."
              />
              <Topic
                title="Earning the move"
                body="The internal rubric we use to decide whether a moment deserves a camera move at all."
              />
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}

function Topic({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <h3 className="font-display text-[14.5px] font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">{body}</p>
    </div>
  );
}
