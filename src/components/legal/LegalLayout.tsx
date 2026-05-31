import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

/**
 * Shared wrapper for /privacy, /terms, /security. Keeps the chrome,
 * disclaimer banner, and "Last updated" line consistent across all
 * three pages.
 *
 * The disclaimer is intentional: these pages are starter content, not
 * lawyer-reviewed. They name AdZoom's actual data flows (Firestore,
 * Gemini, Lemon Squeezy, browser recording) but the legal language
 * should be reviewed before going public.
 */
export function LegalLayout({
  eyebrow,
  title,
  intro,
  lastUpdated,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
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
              {eyebrow}
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              {title}
            </h1>
            <p className="mt-5 text-[15.5px] leading-relaxed text-fog">
              {intro}
            </p>
            <p className="mt-3 text-[12.5px] uppercase tracking-[0.18em] text-fog/70">
              Last updated · {lastUpdated}
            </p>
          </div>

          <div className="mt-8 flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/[0.06] px-4 py-3.5 text-[13px] text-amber-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
            <p>
              <strong className="text-white">Starter language.</strong> This
              page describes AdZoom&apos;s actual data flows but is not yet
              lawyer-reviewed. Treat the wording as a template until a legal
              professional adapts it to your jurisdiction.
            </p>
          </div>

          <div className="legal-prose mt-12 space-y-12">{children}</div>

          <div className="mt-20 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 text-center">
            <p className="text-[13.5px] text-fog">
              Questions about this page?{" "}
              <a
                href="mailto:hello@adzoom.app"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 transition-colors hover:text-violet-200"
              >
                hello@adzoom.app
              </a>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

/**
 * Section primitive used by all three legal pages. Renders a numbered
 * heading + a body slot. Kept simple — these pages render long-form
 * prose, not interactive widgets.
 */
export function LegalSection({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="scroll-mt-28" id={`s-${n}`}>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-[11.5px] tracking-wider text-fog/70">
          {n}
        </span>
        <h2 className="font-display text-[22px] font-semibold tracking-tight text-white">
          {title}
        </h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-fog">
        {children}
      </div>
    </section>
  );
}
