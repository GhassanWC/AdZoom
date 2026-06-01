import {
  MousePointer2,
  BrainCircuit,
  Camera,
  Film,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

/**
 * Pipeline spotlight — text-left, visual-right split inspired by
 * Shipper's "Advisor" section. The four real passes the analyze
 * pipeline runs are stages of a single story rather than four equal
 * cards.
 *
 *   Capture (clicks) → Understanding (Gemini) → Camera (balancer) → Edit
 *
 * Each maps to code that exists today:
 *   capture        - momentsFromEvents + click classifier
 *   understanding  - classifyVideoSections in gemini.ts
 *   camera         - balanceTimeline + focal-region refinement
 *   edit           - finished timeline persisted to project doc
 */

interface Stage {
  Icon: LucideIcon;
  title: string;
  body: string;
}

const STAGES: Stage[] = [
  {
    Icon: MousePointer2,
    title: "Reads every click",
    body: "Tab recordings carry the click, scroll, hover, and idle stream. Every meaningful interaction becomes a candidate for a camera move.",
  },
  {
    Icon: BrainCircuit,
    title: "Understands the workflow",
    body: "Gemini classifies the recording type, labels narrative beats, and maps where the viewer's attention should ride.",
  },
  {
    Icon: Camera,
    title: "Frames the shot",
    body: "The balancer fuses event-derived moments, motion peaks, and gap-fills. Overlaps collapse, low-signal moments drop, the rest gets a focal region sized per click tier.",
  },
  {
    Icon: Film,
    title: "Hands you the cut",
    body: "A finished timeline lands in the editor — chapters above, attention curve behind, pills on the timeline. Refine anything, ship it as-is, or pick a preset.",
  },
];

export function AIWorkflow() {
  return (
    <Section id="director" eyebrow="The director" size="wide">
      <div className="grid items-start gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-20">
        {/* ── Left: large heading + stage list ────────────────────── */}
        <div>
          <RevealOnView>
            <h2 className="font-display text-[clamp(2.25rem,4.8vw,3.75rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-white">
              The director{" "}
              <span className="text-gradient-violet">
                behind every edit.
              </span>
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fog">
              Framevo isn&apos;t a filter. It&apos;s a four-pass pipeline
              that reads your recording the way a video editor would —
              and frames the camera so the viewer can follow.
            </p>
          </RevealOnView>

          <ol className="mt-10 space-y-5">
            {STAGES.map((s, i) => (
              <RevealOnView key={s.title} delay={0.05 + i * 0.05}>
                <li className="flex items-start gap-4">
                  <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <s.Icon size={17} />
                  </span>
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[10.5px] tracking-[0.18em] text-fog/70">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h3 className="font-display text-[17px] font-semibold tracking-tight text-white">
                        {s.title}
                      </h3>
                    </div>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-fog">
                      {s.body}
                    </p>
                  </div>
                </li>
              </RevealOnView>
            ))}
          </ol>
        </div>

        {/* ── Right: large single visual — a focus rect on a SaaS UI mock,
              with a "director chip" overlay. Replaces the 4 small visuals
              with one bigger one Shipper-style. ───────────────────── */}
        <RevealOnView delay={0.1}>
          <DirectorVisual />
        </RevealOnView>
      </div>
    </Section>
  );
}

function DirectorVisual() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[36px] bg-[radial-gradient(circle_at_60%_40%,rgba(139,92,246,0.18),transparent_60%)] blur-3xl"
      />
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#0B0D11] to-[#0E1218] shadow-cinematic">
        {/* mock SaaS UI */}
        <div className="absolute inset-y-0 left-0 w-[22%] border-r border-white/[0.05] bg-white/[0.015] p-3">
          <div className="h-3 w-2/3 rounded bg-white/10" />
          <div className="mt-3 space-y-1.5">
            <div className="h-2 rounded bg-white/[0.06]" />
            <div className="h-2 w-4/5 rounded bg-violet-500/40" />
            <div className="h-2 w-3/4 rounded bg-white/[0.06]" />
            <div className="h-2 w-2/3 rounded bg-white/[0.06]" />
            <div className="h-2 w-3/5 rounded bg-white/[0.06]" />
          </div>
        </div>
        <div className="absolute inset-y-0 left-[22%] right-0 p-5">
          <div className="h-3.5 w-2/5 rounded bg-white/10" />
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className={
                  i === 4
                    ? "aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/15 to-cyan-400/10 ring-1 ring-inset ring-violet-400/30"
                    : "aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]"
                }
              />
            ))}
          </div>
          <div className="mt-5 flex items-center gap-2">
            <div className="h-7 w-28 rounded-md bg-violet-500/85" />
            <div className="h-7 w-20 rounded-md border border-white/10 bg-white/[0.03]" />
          </div>
        </div>

        {/* focus rect with camera label */}
        <div className="absolute left-[50%] top-[40%] h-[24%] w-[24%] rounded-md ring-2 ring-violet-400/85 shadow-[0_0_0_4px_rgba(139,92,246,0.16)]">
          <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
          <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
          <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
          <span className="absolute -top-7 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
            <Sparkles size={9} />
            Primary CTA · zoom 2.4×
          </span>
        </div>

        {/* bottom mini-timeline */}
        <div className="absolute inset-x-5 bottom-5 rounded-xl border border-white/10 bg-black/55 p-3 backdrop-blur">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <span className="h-full w-[10%] bg-slate-400/70" />
            <span className="h-full w-[8%] bg-transparent" />
            <span className="h-full w-[16%] bg-violet-400/85" />
            <span className="h-full w-[6%] bg-transparent" />
            <span className="h-full w-[22%] bg-violet-400/85" />
            <span className="h-full w-[8%] bg-transparent" />
            <span className="h-full w-[14%] bg-emerald-400/85" />
          </div>
          <div className="mt-2 flex justify-between text-[9.5px] text-fog">
            <span>0:00</span>
            <span>0:30</span>
            <span>1:09</span>
          </div>
        </div>
      </div>
    </div>
  );
}
