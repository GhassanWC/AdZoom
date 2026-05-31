import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  GraduationCap,
  Mail,
  Sparkles,
} from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "Tutorials — AdZoom",
  description: "Step-by-step guides for getting cinematic results out of your recordings.",
};

const PLANNED = [
  {
    title: "Your first cinematic edit in 5 minutes",
    body: "Record a tab, run analyze, refine three pills, export 1080p. End-to-end happy path.",
    level: "Starter",
  },
  {
    title: "Reading the timeline",
    body: "Chapters band, attention waveform, two tracks, inspector — what each part is telling you.",
    level: "Starter",
  },
  {
    title: "Picking the right preset",
    body: "MrBeast vs Cinematic vs Tutorial — what changes, when each fits, and how to fork your own.",
    level: "Starter",
  },
  {
    title: "Tuning a moment with keyframes",
    body: "When the static focus region isn't enough — adding a moving focal point across a single moment.",
    level: "Advanced",
  },
  {
    title: "Refining framing on imported recordings",
    body: "When you upload an old recording with no interaction sidecar, how to coax a good edit anyway.",
    level: "Advanced",
  },
  {
    title: "Debugging missing zooms",
    body: "The Analysis Debug panel walkthrough. Capture → load → balancer — where clicks get lost.",
    level: "Power user",
  },
];

export default function TutorialsPage() {
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
              <GraduationCap size={11} />
              Tutorials
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              Learn the editor by{" "}
              <span className="text-gradient-violet">doing.</span>
            </h1>
            <p className="mt-6 text-[16px] leading-relaxed text-fog">
              Short, guided walkthroughs of the AdZoom workflow — from
              your first recording to debugging an edit the AI got wrong.
              The first set of tutorials lands soon.
            </p>
          </div>

          {/* Empty state */}
          <section className="mt-12 rounded-3xl border border-dashed border-white/10 bg-white/[0.015] px-8 py-14 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
              <Sparkles size={18} />
            </span>
            <h2 className="mt-5 font-display text-[22px] font-semibold tracking-tight text-white">
              Tutorials coming soon.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-fog">
              Until they ship, the{" "}
              <Link
                href="/docs"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
              >
                docs
              </Link>{" "}
              cover most of what you need. The editor is designed to be
              explorable — open a project and the inspector explains
              every decision the AI made.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button
                href="mailto:hello@adzoom.app?subject=Notify%20me%20when%20AdZoom%20tutorials%20ship"
                variant="primary"
                size="md"
                leftIcon={<Mail size={13} />}
              >
                Notify me
              </Button>
              <Button
                href="/dashboard"
                variant="ghost"
                size="md"
                rightIcon={<ArrowRight size={13} />}
              >
                Open the editor
              </Button>
            </div>
          </section>

          <section className="mt-16">
            <h2 className="font-display text-[20px] font-semibold tracking-tight text-white">
              What we&apos;re writing
            </h2>
            <p className="mt-2 text-[13.5px] text-fog">
              The planned list, grouped by skill level. Tell us at{" "}
              <a
                href="mailto:hello@adzoom.app"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
              >
                hello@adzoom.app
              </a>{" "}
              if you&apos;d like one written next.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PLANNED.map((t) => (
                <div
                  key={t.title}
                  className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5"
                >
                  <span className="inline-flex rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-fog">
                    {t.level}
                  </span>
                  <h3 className="mt-3 font-display text-[14.5px] font-semibold tracking-tight text-white">
                    {t.title}
                  </h3>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">
                    {t.body}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
