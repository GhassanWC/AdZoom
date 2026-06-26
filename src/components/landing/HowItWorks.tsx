import {
  UploadCloud,
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
    Icon: UploadCloud,
    title: "Upload any video",
    body: "Drop in any video (MP4, MOV, WebM) — or record your screen right in the browser. No extension, no plugin, nothing to install.",
  },
  {
    n: "02",
    Icon: Wand2,
    title: "AI builds the first-draft edit",
    body: "Framevo cuts the dead air, speeds up slow stretches, and adds cinematic zooms, click highlights, and focus on the moments that matter.",
  },
  {
    n: "03",
    Icon: Download,
    title: "Adjust and export a polished video",
    body: "Refine anything on the timeline, reframe for any platform with Canvas Fit, and export a clean MP4 — the preview matches the file exactly.",
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
      subtitle="Three steps. You upload and review — Framevo does the editing in between, and you stay in control of the result."
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute left-[8%] right-[8%] top-[44px] hidden h-px lg:block"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.45) 50%, transparent 100%)",
          }}
        />

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <RevealOnView key={s.n} delay={i * 0.06}>
              <div className="glass relative h-full rounded-2xl p-6 lg:p-7">
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
