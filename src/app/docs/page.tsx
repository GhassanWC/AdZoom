import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Video,
  Sparkles,
  Wand2,
  Download,
  Code,
  Keyboard,
} from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

export const metadata = {
  title: "Docs — Framevo",
  description: "Documentation for recording, analysing, editing, and exporting with Framevo.",
};

const SECTIONS = [
  {
    href: "#recording",
    Icon: Video,
    title: "Recording",
    body: "Capture a browser tab or your desktop. What gets captured, what doesn't, and where the interaction sidecar lives.",
  },
  {
    href: "#analysis",
    Icon: Sparkles,
    title: "AI analysis",
    body: "How the four-pass pipeline reads your recording: capture → understanding → camera → edit. What each stage decides.",
  },
  {
    href: "#editing",
    Icon: Wand2,
    title: "Editor",
    body: "Timeline, inspector, presets, keyframes, focus regions. Override anything the AI proposed without leaving the timeline.",
  },
  {
    href: "#export",
    Icon: Download,
    title: "Export",
    body: "Render 1080p or 4K. Switch to vertical for Shorts and Reels. What changes when you pick a preset.",
  },
  {
    href: "/api-reference",
    Icon: Code,
    title: "API",
    body: "REST endpoints for integrating Framevo into your own workflow. Bearer-token auth with API keys.",
  },
  {
    href: "#shortcuts",
    Icon: Keyboard,
    title: "Shortcuts",
    body: "Keyboard shortcuts that speed up timeline editing. Multi-select, nudge, duplicate, delete.",
  },
];

export default function DocsPage() {
  return (
    <>
      <Navbar />
      <main className="relative min-h-screen px-4 pb-24 pt-28 sm:pt-36">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.18),transparent_65%)] blur-3xl"
        />

        <div className="mx-auto max-w-4xl">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
          >
            <ArrowLeft size={12} />
            Back to home
          </Link>

          <div className="mt-7">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
              <BookOpen size={11} />
              Docs
            </span>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
              How Framevo{" "}
              <span className="text-gradient-violet">actually works.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-fog">
              Reference docs for the recording engine, the AI pipeline, the
              editor, and the export surface. Written by the team that
              built each one.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <Link
                key={s.title}
                href={s.href}
                className="glass group relative h-full overflow-hidden rounded-2xl p-6 transition-colors duration-200 hover:border-white/[0.18]"
              >
                <div className="flex items-start gap-4">
                  <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <s.Icon size={17} />
                  </span>
                  <div>
                    <h2 className="font-display text-[16px] font-semibold tracking-tight text-white">
                      {s.title}
                    </h2>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-fog">
                      {s.body}
                    </p>
                  </div>
                </div>
                <span className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.02] text-fog transition-all duration-200 group-hover:border-violet-400/40 group-hover:bg-violet-500/10 group-hover:text-violet-300">
                  <ArrowRight size={12} />
                </span>
              </Link>
            ))}
          </div>

          {/* ── Recording section ─────────────────────────────── */}
          <Article id="recording" title="Recording">
            <p>
              Framevo records inside your browser using the standard{" "}
              <code className="rounded bg-white/[0.05] px-1 font-mono text-[12.5px] text-violet-200">
                getDisplayMedia
              </code>{" "}
              API. You pick the source — a browser tab, a window, or the
              whole screen — and the browser handles permission.
            </p>
            <p>
              For tab captures, Framevo additionally captures coarse
              interaction events to a sidecar JSON file. Every click,
              scroll, hover, idle stretch, and typing burst is recorded,
              along with the bounding rectangle of the element you clicked
              (privacy-safe — only geometry, no DOM text or roles).
            </p>
            <p>
              External (window or monitor) captures cannot see element
              rectangles because the Framevo tab and the captured surface
              are different windows. The capture is still useful — the
              pipeline degrades to heuristic classification based on
              cursor signals and CV regions.
            </p>
          </Article>

          {/* ── AI analysis section ───────────────────────────── */}
          <Article id="analysis" title="AI analysis">
            <p>The analyze pipeline runs four passes in order:</p>
            <ol className="list-decimal space-y-3 pl-6 marker:text-violet-400">
              <li>
                <strong className="text-white">Capture.</strong>{" "}
                Interaction sidecar is downloaded from Storage and parsed.
                Every click is classified into one of five tiers —
                primary-cta, icon, nav, form, background — by an element
                geometry + cursor intent heuristic.
              </li>
              <li>
                <strong className="text-white">Understanding.</strong>{" "}
                Gemini reads the video, classifies the recording type
                (SaaS demo, tutorial, talking-head, vertical short, …),
                and segments it into narrative beats (intro / action /
                result).
              </li>
              <li>
                <strong className="text-white">Camera.</strong> The
                balancer fuses event-derived moments, CV peaks, and AI
                gap-fills into a candidate pool. Overlaps collapse, low-
                signal moments get rejected, and a greedy selector picks
                the kept set under per-provenance pacing rules.
              </li>
              <li>
                <strong className="text-white">Edit.</strong> The
                finished timeline lands in the editor with focus regions
                sized per tier, narrative chapters on top, and the
                attention curve behind every moment.
              </li>
            </ol>
            <p>
              If a recording loses clicks somewhere in this pipeline, the
              editor&apos;s Analysis Debug panel surfaces exactly which
              stage dropped them.
            </p>
          </Article>

          {/* ── Editor section ─────────────────────────────────── */}
          <Article id="editing" title="Editor">
            <p>
              The editor is a single page: video preview, timeline below
              it, presets rail, and an inspector for the selected moment.
              The AI gave you a first draft — nothing is locked.
            </p>
            <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
              <li>
                <strong className="text-white">Drag a moment pill</strong>{" "}
                to retime it. Hold the edge to resize. The pill renders
                its tier and effect type inline.
              </li>
              <li>
                <strong className="text-white">Open the inspector</strong>{" "}
                to tune the focus region, intensity, and effect type
                without leaving the timeline.
              </li>
              <li>
                <strong className="text-white">Pick a preset</strong> to
                swap pacing + cursor styling + click effects in one tap.
                Presets are reversible.
              </li>
              <li>
                <strong className="text-white">Add keyframes</strong> for
                a moving focal point inside a single moment.
              </li>
              <li>
                <strong className="text-white">Re-analyze</strong> after
                changing the preset or pacing. Cached analysis is re-used
                where possible — Gemini is only called when needed.
              </li>
            </ul>
          </Article>

          {/* ── Export section ─────────────────────────────────── */}
          <Article id="export" title="Export">
            <p>
              Export renders the timeline into a video file. The renderer
              honours your preset, effects settings, and any manual edits
              you made.
            </p>
            <ul className="list-disc space-y-2 pl-6 marker:text-violet-400">
              <li>1080p on Free; 4K on Creator and above.</li>
              <li>16:9, 9:16 (vertical), or square output.</li>
              <li>Watermark on Free; watermark-free on paid plans.</li>
              <li>
                The exact renderer settings are visible in the export
                modal — what you preview is what ships.
              </li>
            </ul>
          </Article>

          {/* ── Shortcuts section ──────────────────────────────── */}
          <Article id="shortcuts" title="Keyboard shortcuts">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Shortcut keys={["Space"]} body="Play / pause" />
              <Shortcut keys={["←", "→"]} body="Nudge playhead one frame" />
              <Shortcut
                keys={["Shift", "Click"]}
                body="Multi-select moment pills"
              />
              <Shortcut keys={["⌘", "D"]} body="Duplicate selected moment" />
              <Shortcut keys={["Delete"]} body="Delete selected moment" />
              <Shortcut
                keys={["Ctrl", "Shift", "D"]}
                body="Toggle developer debug overlay"
              />
            </div>
          </Article>
        </div>
      </main>
      <Footer />
    </>
  );
}

function Article({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article
      id={id}
      className="mt-20 scroll-mt-28 border-t border-white/[0.06] pt-12"
    >
      <h2 className="font-display text-[26px] font-semibold tracking-tight text-white">
        {title}
      </h2>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-fog">
        {children}
      </div>
    </article>
  );
}

function Shortcut({ keys, body }: { keys: string[]; body: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
      <div className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-fog">+</span>}
            <kbd className="rounded border border-white/15 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-white/85">
              {k}
            </kbd>
          </span>
        ))}
      </div>
      <span className="text-[13px] text-fog">{body}</span>
    </div>
  );
}
