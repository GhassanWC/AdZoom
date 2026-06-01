import Link from "next/link";
import { ArrowLeft, Mail, Sparkles } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "Careers — Framevo",
  description: "No open roles right now — but we'd love to hear from you.",
};

export default function CareersPage() {
  return (
    <>
      <Navbar />
      <main className="relative min-h-[80vh] px-4 pb-24 pt-28 sm:pt-36">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_65%)] blur-3xl"
        />

        <div className="mx-auto max-w-2xl">
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
              Careers
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              No open roles{" "}
              <span className="text-gradient-violet">right now.</span>
            </h1>
            <p className="mt-6 text-[16px] leading-relaxed text-fog">
              We&apos;re a small team, still finding our shape. There are no
              positions to apply for today. That will change as the product
              grows.
            </p>
          </div>

          <div className="glass mt-12 rounded-2xl p-7">
            <div className="flex items-start gap-4">
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <Mail size={18} />
              </span>
              <div>
                <h2 className="font-display text-[19px] font-semibold tracking-tight text-white">
                  Tell us why you&apos;d be a fit anyway.
                </h2>
                <p className="mt-2 text-[14px] leading-relaxed text-fog">
                  If you work on creator tools, video pipelines,
                  attention-aware editing, or pixel-perfect product UI — and
                  Framevo resonates with you — write to us. We keep a short
                  list of people we&apos;d call first when we open a role.
                </p>
                <p className="mt-2 text-[14px] leading-relaxed text-fog">
                  Send a short note, links to anything you&apos;ve built that
                  you&apos;re proud of, and what you&apos;d want to work on.
                  Skip the long CV.
                </p>
                <div className="mt-5">
                  <Button
                    href="mailto:support@framevo.app?subject=Future%20role%20at%20Framevo"
                    variant="primary"
                    size="md"
                    leftIcon={<Mail size={13} />}
                  >
                    support@framevo.app
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PrincipleCard
              title="Honest about scope"
              body="We don't pretend to be bigger than we are. The product page only ships features that exist."
            />
            <PrincipleCard
              title="Editing earns the move"
              body="Every camera move has to justify itself. The same standard goes for the code we ship."
            />
            <PrincipleCard
              title="Quiet UI"
              body="Less chrome, more product. We sweat typography, spacing, and motion at Linear / Arc level."
            />
          </div>

          <p className="mt-12 text-center text-[12.5px] text-fog/80">
            Check back here when roles open. We&apos;ll post them with the
            full scope, comp band, and what success looks like in the first
            90 days.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}

function PrincipleCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <h3 className="font-display text-[14px] font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fog">{body}</p>
    </div>
  );
}
