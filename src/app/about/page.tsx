import Link from "next/link";
import {
  ArrowLeft,
  Sparkles,
  MousePointerClick,
  Camera,
  ArrowRight,
} from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "About — AdZoom",
  description:
    "Why AdZoom exists and what we're trying to build.",
};

export default function AboutPage() {
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
              <Sparkles size={11} />
              About
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-[52px]">
              The viewer doesn&apos;t know{" "}
              <span className="text-gradient-violet">where to look.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-[16.5px] leading-relaxed text-fog">
              Most screen recordings are flat. The camera holds the whole
              tab while the action happens in a 200-pixel corner. The
              viewer drifts. The message gets lost. AdZoom exists to fix
              that — by reading what you actually did and directing the
              camera so the viewer follows.
            </p>
          </div>

          <section className="mt-16 space-y-5">
            <h2 className="font-display text-[26px] font-semibold tracking-tight text-white">
              What we&apos;re building
            </h2>
            <p className="text-[15.5px] leading-relaxed text-fog">
              An attention-aware video editor that turns raw browser
              recordings into guided cinematic edits. Not just zooms.
              Camera moves that earn themselves — anchored to the clicks,
              navigations, and beats that actually happened during your
              recording.
            </p>
            <p className="text-[15.5px] leading-relaxed text-fog">
              Under the hood, AdZoom runs a four-pass pipeline: capture
              every interaction alongside the pixels, ask Gemini to read
              the recording at a structural level, balance candidate
              moments against attention and pacing rules, then hand you a
              finished timeline you can refine. The AI gives you a draft.
              You ship the cut.
            </p>
          </section>

          <section className="mt-16">
            <h2 className="font-display text-[26px] font-semibold tracking-tight text-white">
              How we think about it
            </h2>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Principle
                Icon={MousePointerClick}
                title="Interaction is signal"
                body="Every click is data. We use it to size the camera, not to throw a ring on the screen."
              />
              <Principle
                Icon={Camera}
                title="Earn every move"
                body="A camera move that doesn't serve the viewer's attention shouldn't exist. We'd rather hold still than zoom for vibe."
              />
              <Principle
                Icon={Sparkles}
                title="AI drafts, you ship"
                body="The first draft is automatic. The final cut is yours. We don't lock you out of the timeline."
              />
            </div>
          </section>

          <section className="mt-16 space-y-5">
            <h2 className="font-display text-[26px] font-semibold tracking-tight text-white">
              The team
            </h2>
            <p className="text-[15.5px] leading-relaxed text-fog">
              We&apos;re a small team building in public. The product
              page only ships features we&apos;ve actually wired up — if
              it&apos;s on the homepage, it&apos;s in the editor. When
              roles open, they go on the{" "}
              <Link
                href="/careers"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
              >
                careers page
              </Link>{" "}
              with scope, comp, and what success looks like.
            </p>
            <p className="text-[15.5px] leading-relaxed text-fog">
              For anything else — partnership ideas, press, security
              reports, or just a hello — email{" "}
              <a
                href="mailto:hello@adzoom.app"
                className="text-violet-300 underline decoration-violet-300/40 underline-offset-4 hover:text-violet-200"
              >
                hello@adzoom.app
              </a>
              .
            </p>
          </section>

          <div className="mt-20 rounded-3xl border border-white/[0.06] bg-gradient-to-br from-violet-500/[0.06] to-transparent p-8 text-center">
            <h3 className="font-display text-[24px] font-semibold tracking-tight text-white">
              Try the editor.
            </h3>
            <p className="mx-auto mt-3 max-w-md text-[14px] text-fog">
              Record any tab. Watch AdZoom turn it into a guided cut.
              Free to start, no card required.
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
              <Button href="/pricing" variant="ghost" size="md">
                See pricing
              </Button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

function Principle({
  Icon,
  title,
  body,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <span className="inline-flex size-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
        <Icon size={16} />
      </span>
      <h3 className="mt-4 font-display text-[14px] font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">{body}</p>
    </div>
  );
}
