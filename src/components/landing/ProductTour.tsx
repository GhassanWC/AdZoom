"use client";

import {
  Sparkles,
  Check,
  X,
  Download,
  ZoomIn,
  Target,
  Scissors,
  FastForward,
  MousePointer2,
  Lightbulb,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

/**
 * Product tour — a bento that shows the four parts of the Framevo editor the
 * way a user actually experiences them: a live preview, an editable timeline of
 * AI edits, AI suggestions you accept or dismiss, and an export with a clear
 * status. Each pane is labeled so the section doubles as an annotated walkthrough.
 *
 * Pure presentational mock (no real editor wiring) — token-based so it adapts to
 * light + dark mode.
 */

const PANE_LABEL =
  "inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog";

export function ProductTour() {
  return (
    <Section
      id="product"
      eyebrow="Product tour"
      title={
        <>
          A real editor,{" "}
          <span className="text-gradient-violet">not a black box.</span>
        </>
      }
      subtitle="See exactly what the AI did — preview it, retime it on the timeline, accept or dismiss suggestions, and export a clean MP4. You stay in control the whole way."
    >
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Preview — spans 2 cols on lg */}
        <RevealOnView className="lg:col-span-2">
          <PreviewPane />
        </RevealOnView>

        {/* AI suggestions */}
        <RevealOnView delay={0.06}>
          <SuggestionsPane />
        </RevealOnView>

        {/* Timeline — spans 2 cols on lg */}
        <RevealOnView delay={0.04} className="lg:col-span-2">
          <TimelinePane />
        </RevealOnView>

        {/* Export status */}
        <RevealOnView delay={0.08}>
          <ExportPane />
        </RevealOnView>
      </div>
    </Section>
  );
}

function PreviewPane() {
  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className={PANE_LABEL}>
          <span className="text-violet-300">1</span> Live preview
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-black/30 px-2 py-0.5 text-[10px] font-medium text-[#C4B5FD]">
          <span className="relative inline-flex size-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-violet-400/70" />
            <span className="relative inline-block size-1.5 rounded-full bg-violet-400" />
          </span>
          AI tracking
        </span>
      </div>
      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-br from-white/[0.04] to-white/[0.01]">
        {/* fake recorded app */}
        <div className="absolute inset-y-0 left-0 w-[20%] border-r border-white/[0.05] bg-white/[0.015] p-2.5">
          <div className="h-2.5 w-2/3 rounded bg-white/10" />
          <div className="mt-3 space-y-1.5">
            <div className="h-2 rounded bg-white/[0.06]" />
            <div className="h-2 w-4/5 rounded bg-violet-500/40" />
            <div className="h-2 w-3/4 rounded bg-white/[0.06]" />
          </div>
        </div>
        <div className="absolute inset-y-0 left-[20%] right-0 p-3">
          <div className="mb-2.5 h-3 w-2/5 rounded bg-white/10" />
          <div className="grid grid-cols-3 gap-2">
            <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
            <div className="aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/15 to-cyan-400/10 ring-1 ring-inset ring-violet-400/30" />
            <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
          </div>
        </div>

        {/* static AI zoom box framing the highlighted card */}
        <div
          className="absolute rounded-md ring-2 ring-violet-400/70 shadow-[0_0_0_4px_rgba(139,92,246,0.15)]"
          style={{ left: "54%", top: "30%", width: "34%", height: "34%" }}
        >
          <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
          <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
          <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
          <span className="absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
            <Sparkles size={9} /> Auto Zoom
          </span>
        </div>

        {/* cursor */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 20 20"
          className="absolute drop-shadow-[0_2px_6px_rgba(139,92,246,0.6)]"
          style={{ left: "66%", top: "44%" }}
        >
          <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
        </svg>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-fog">
        A WYSIWYG preview of the finished edit — the camera follows the action,
        and what you see is exactly what exports.
      </p>
    </div>
  );
}

const SUGGESTIONS = [
  { Icon: ZoomIn, title: "Add a zoom on the pricing reveal", at: "0:42" },
  { Icon: Scissors, title: "Trim 6s of idle loading", at: "1:18" },
];

function SuggestionsPane() {
  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className={PANE_LABEL}>
          <span className="text-violet-300">2</span> AI suggestions
        </span>
        <span className="inline-flex size-6 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300">
          <Lightbulb size={13} />
        </span>
      </div>
      <ul className="space-y-2">
        {SUGGESTIONS.map((s) => (
          <li
            key={s.title}
            className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-violet-300">
                <s.Icon size={13} />
              </span>
              <span className="min-w-0 flex-1 text-[12px] font-medium leading-snug text-white/90">
                {s.title}
              </span>
              <span className="shrink-0 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-fog">
                {s.at}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-100">
                <Check size={10} />
                Accept
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-[10px] font-medium text-fog">
                <X size={10} />
                Dismiss
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-auto pt-3 text-[12px] leading-relaxed text-fog">
        The AI proposes; you decide. Nothing is applied without your say.
      </p>
    </div>
  );
}

const PILLS = [
  { Icon: ZoomIn, label: "Zoom", left: 3, width: 19, tone: "violet" },
  { Icon: Target, label: "Click", left: 25, width: 10, tone: "fuchsia" },
  { Icon: Scissors, label: "Cut", left: 38, width: 13, tone: "rose" },
  { Icon: ZoomIn, label: "Zoom", left: 54, width: 21, tone: "violet" },
  { Icon: FastForward, label: "Speed", left: 79, width: 16, tone: "amber" },
] as const;

const TONE: Record<string, string> = {
  violet: "border-violet-400/40 bg-violet-500/20 text-violet-100",
  fuchsia: "border-fuchsia-400/40 bg-fuchsia-500/20 text-fuchsia-100",
  rose: "border-rose-400/40 bg-rose-500/20 text-rose-100",
  amber: "border-amber-300/40 bg-amber-400/20 text-amber-100",
};

function TimelinePane() {
  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className={PANE_LABEL}>
          <span className="text-violet-300">3</span> Editable timeline
        </span>
        <div className="flex items-center gap-2.5 text-[10px] text-fog">
          <span className="inline-flex items-center gap-1">
            <Sparkles size={10} className="text-violet-300" /> AI edit
          </span>
          <span className="inline-flex items-center gap-1">
            <MousePointer2 size={10} className="text-cyan-300" /> Your edit
          </span>
        </div>
      </div>

      {/* ruler */}
      <div className="mb-2 flex items-center gap-1">
        {Array.from({ length: 16 }).map((_, i) => (
          <span key={i} className="h-2 flex-1 border-l border-white/[0.06]" />
        ))}
      </div>

      {/* two lanes */}
      <div className="space-y-2">
        <div className="relative h-9 rounded-lg bg-white/[0.02]">
          {PILLS.map((p, i) => (
            <div
              key={i}
              className={`absolute inset-y-1 inline-flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[9.5px] font-semibold ${TONE[p.tone]}`}
              style={{ left: `${p.left}%`, width: `${p.width}%` }}
            >
              <p.Icon size={10} className="shrink-0" />
              <span className="hidden truncate sm:inline">{p.label}</span>
            </div>
          ))}
          <span className="absolute inset-y-0 left-[46%] z-10 w-px bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,0.8)]">
            <span className="absolute -top-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-cyan-300" />
          </span>
        </div>
        <div className="relative h-6 rounded-lg bg-white/[0.015]">
          <div
            className="absolute inset-y-1 rounded-md border border-cyan-300/40 bg-cyan-400/15 text-cyan-100"
            style={{ left: "63%", width: "18%" }}
          />
        </div>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-fog">
        Drag to move, pull the edges to retime, duplicate or delete — every AI
        edit is yours to adjust, plus undo/redo and keyboard shortcuts.
      </p>
    </div>
  );
}

function ExportPane() {
  return (
    <div className="glass flex h-full flex-col rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className={PANE_LABEL}>
          <span className="text-violet-300">4</span> Export
        </span>
        <span className="inline-flex size-6 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200">
          <Download size={13} />
        </span>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-medium text-white/90">Rendering MP4</span>
          <span className="font-mono tabular-nums text-fog">72%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 shadow-[0_0_12px_rgba(139,92,246,0.5)]"
            style={{ width: "72%" }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag>MP4</Tag>
          <Tag>1080p</Tag>
          <Tag>16:9</Tag>
        </div>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-fog">
        Render in your browser on the free plan, or unlock 1080p, watermark-free
        cloud exports on Pro. Reframe the same edit for vertical and square too.
      </p>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-fog">
      {children}
    </span>
  );
}
