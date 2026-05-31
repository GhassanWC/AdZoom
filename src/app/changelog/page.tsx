import Link from "next/link";
import { ArrowLeft, Mail, History } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { Button } from "@/components/ui/Button";

export const metadata = {
  title: "Changelog — AdZoom",
  description: "What's new in AdZoom — features shipped, fixes landed, improvements rolled out.",
};

type Tag = "feature" | "improvement" | "fix";

interface Entry {
  date: string;
  version?: string;
  title: string;
  bullets: { tag: Tag; text: string }[];
}

/**
 * Hand-curated changelog. Each new release prepends an entry.
 * Tags map 1:1 to a tone in the UI — keep them honest.
 */
const ENTRIES: Entry[] = [
  {
    date: "May 30, 2026",
    version: "v0.6",
    title: "Click pipeline diagnostics",
    bullets: [
      {
        tag: "feature",
        text: "Analysis Debug panel in the editor — capture → load → momentsFromEvents → balancer, with per-stage counts and drop reasons.",
      },
      {
        tag: "feature",
        text: "“Generate zooms from clicks only” bypass route — one zoom per click, no balancer, no Gemini.",
      },
      {
        tag: "feature",
        text: "“Force re-analyze from interactions” clears cached analysis and re-runs the pipeline end-to-end.",
      },
      {
        tag: "fix",
        text: "Balancer no longer collapses multi-click sequences. Event-vs-event uses tight focus (0.08) and 0.8s collapse window.",
      },
      {
        tag: "fix",
        text: "Greedy selection uses per-provenance spacing — clicks no longer rate-limited by the 7s AI minSpacing.",
      },
      {
        tag: "fix",
        text: "Zoom cooldown (10s) no longer applies to event-derived zooms. Real user clicks aren’t rate-limited.",
      },
    ],
  },
  {
    date: "May 28, 2026",
    version: "v0.5",
    title: "Click-aware cinematic zoom",
    bullets: [
      {
        tag: "feature",
        text: "Click classifier — primary-cta / icon / nav / form / background. Camera move sized per tier.",
      },
      {
        tag: "feature",
        text: "Browser provider captures element bounding rectangle on click for in-tab recordings.",
      },
      {
        tag: "improvement",
        text: "Gemini gap-fill defaults tightened from 50% to 35% focus box. No more “whole-video” zooms on weak AI signal.",
      },
      {
        tag: "improvement",
        text: "Defensive shrink for incoming focus regions >55% when no positive signal kicked in.",
      },
    ],
  },
  {
    date: "May 26, 2026",
    version: "v0.4",
    title: "Settings, API keys, and security rules",
    bullets: [
      {
        tag: "feature",
        text: "Settings page — workspace preferences and API key management.",
      },
      {
        tag: "feature",
        text: "API keys with separate test (ak_test_) and live (ak_live_) prefixes. Plaintext shown once; SHA-256 hash stored.",
      },
      {
        tag: "feature",
        text: "GET /api/v1/me — first public API endpoint for validating keys.",
      },
      {
        tag: "fix",
        text: "Firestore rules now scope users/{uid}/settings and apiKeys per-account; apiKeyIndex locked to server only.",
      },
      {
        tag: "improvement",
        text: "API keys section shows visible errors instead of hiding permission failures silently.",
      },
    ],
  },
  {
    date: "May 22, 2026",
    version: "v0.3",
    title: "Editor refinement",
    bullets: [
      {
        tag: "feature",
        text: "Directional zoom presets — quick chips for forward / hold / fade-out framing.",
      },
      {
        tag: "feature",
        text: "Vignette toggle baked into preview and export.",
      },
      {
        tag: "improvement",
        text: "Preview / export parity — what you see in the editor renders identically on export.",
      },
      {
        tag: "improvement",
        text: "Light-mode polish across the editor, settings, and landing chrome.",
      },
    ],
  },
];

export default function ChangelogPage() {
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
              <History size={11} />
              Changelog
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              What&apos;s new in{" "}
              <span className="text-gradient-violet">AdZoom.</span>
            </h1>
            <p className="mt-6 text-[16px] leading-relaxed text-fog">
              Every meaningful change, dated, tagged, and grouped. We
              ship in small steps — most weeks add at least one entry.
            </p>
          </div>

          <div className="mt-12 space-y-12">
            {ENTRIES.map((e) => (
              <article key={e.date} className="relative">
                <header className="flex flex-wrap items-baseline gap-3">
                  {e.version && (
                    <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-violet-200">
                      {e.version}
                    </span>
                  )}
                  <h2 className="font-display text-[22px] font-semibold tracking-tight text-white">
                    {e.title}
                  </h2>
                  <span className="ml-auto text-[11.5px] uppercase tracking-[0.18em] text-fog">
                    {e.date}
                  </span>
                </header>

                <ul className="mt-5 space-y-2.5">
                  {e.bullets.map((b, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                    >
                      <TagPill tag={b.tag} />
                      <span className="text-[13.5px] leading-relaxed text-fog">
                        {b.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="mt-20 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 text-center">
            <p className="text-[13.5px] text-fog">
              Want release notes by email?
            </p>
            <div className="mt-4">
              <Button
                href="mailto:hello@adzoom.app?subject=Subscribe%20me%20to%20the%20AdZoom%20changelog"
                variant="ghost"
                size="sm"
                leftIcon={<Mail size={12} />}
              >
                Notify me
              </Button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

function TagPill({ tag }: { tag: Tag }) {
  const styles =
    tag === "feature"
      ? "border-violet-400/40 bg-violet-500/10 text-violet-200"
      : tag === "improvement"
      ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
      : "border-emerald-400/40 bg-emerald-500/10 text-emerald-200";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.16em] ${styles}`}
    >
      {tag}
    </span>
  );
}
