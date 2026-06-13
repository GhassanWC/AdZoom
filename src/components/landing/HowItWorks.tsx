import {
  Upload,
  SlidersHorizontal,
  Wand2,
  Download,
  type LucideIcon,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

interface Step {
  n: string;
  Icon: LucideIcon;
  title: string;
  body: string;
}

const steps: Step[] = [
  {
    n: "01",
    Icon: Upload,
    title: "Upload or record a video",
    body: "Drop in an existing video or screen recording (MP4, MOV, WebM), or capture a new one right in the browser. No extension, no plugin.",
  },
  {
    n: "02",
    Icon: SlidersHorizontal,
    title: "Choose what to generate",
    body: "Pick which edits Framevo should make — camera edits, cuts, speed-ups — and how detailed the analysis should be.",
  },
  {
    n: "03",
    Icon: Wand2,
    title: "AI creates the edits",
    body: "Cuts on the dead sections, speed-ups on the slow parts, and camera edits — zooms, click highlights, focus — on the moments that matter.",
  },
  {
    n: "04",
    Icon: Download,
    title: "Review & export",
    body: "Adjust anything on the timeline, pick your format with Canvas Fit, and export — rendered in your browser, preview matching the file.",
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title={
        <>
          From raw video to{" "}
          <span className="text-gradient-violet">finished edit.</span>
        </>
      }
      subtitle="Four steps. You pick what to generate and review the result — Framevo does the editing in between, and you stay in control."
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute left-[5%] right-[5%] top-[44px] hidden h-px lg:block"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.45) 50%, transparent 100%)",
          }}
        />

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <RevealOnView key={s.n} delay={i * 0.06}>
              <div className="glass relative h-full rounded-2xl p-6">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-11 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <s.Icon size={19} />
                  </span>
                  <span className="font-display text-[11px] font-semibold uppercase tracking-[0.2em] text-fog">
                    Step {s.n}
                  </span>
                </div>
                <h3 className="mt-5 font-display text-[19px] font-semibold tracking-tight text-white">
                  {s.title}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-fog">
                  {s.body}
                </p>
              </div>
            </RevealOnView>
          ))}
        </div>
      </div>
    </Section>
  );
}
