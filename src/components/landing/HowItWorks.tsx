import { Upload, Cpu, Download } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

const steps = [
  {
    n: "01",
    Icon: Upload,
    title: "Upload your recording",
    body: "Drop in any MP4, MOV, or WebM. Up to 2GB. Your file stays in your workspace.",
  },
  {
    n: "02",
    Icon: Cpu,
    title: "AI enhances it",
    body: "Cursor detection, click events, focus regions, and motion paths — all analyzed in seconds.",
  },
  {
    n: "03",
    Icon: Download,
    title: "Export cinematic",
    body: "4K, 60fps, vertical, TikTok — pick a format and ship. Watermark-free on Pro.",
  },
];

export function HowItWorks() {
  return (
    <Section
      eyebrow="How it works"
      title={
        <>
          Three steps to a{" "}
          <span className="text-gradient-violet">cinematic cut.</span>
        </>
      }
      subtitle="No timelines. No keyframes. No editor expertise. The AI handles every decision while you stay focused on the message."
    >
      <div className="relative">
        {/* connecting line on desktop */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-12 right-12 top-12 hidden h-px lg:block"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.45) 50%, transparent 100%)",
          }}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {steps.map((s, i) => (
            <RevealOnView key={s.n} delay={i * 0.08}>
              <div className="glass relative rounded-2xl p-6">
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-12 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <s.Icon size={20} />
                  </span>
                  <span className="font-display text-xs font-semibold uppercase tracking-[0.18em] text-fog">
                    Step {s.n}
                  </span>
                </div>
                <h3 className="mt-5 font-display text-xl font-semibold tracking-tight text-white">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-fog">
                  {s.body}
                </p>

                {/* preview slot */}
                <div className="mt-6 aspect-[16/10] overflow-hidden rounded-lg border border-white/[0.06] bg-black/30">
                  <StepIllustration index={i} />
                </div>
              </div>
            </RevealOnView>
          ))}
        </div>
      </div>
    </Section>
  );
}

function StepIllustration({ index }: { index: number }) {
  if (index === 0) {
    // upload dropzone illustration
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="grid h-full w-full place-items-center rounded-md border border-dashed border-white/15 bg-white/[0.02]">
          <div className="text-center">
            <Upload size={20} className="mx-auto text-violet-300" />
            <div className="mt-2 text-[11px] text-fog">drop video here</div>
          </div>
        </div>
      </div>
    );
  }
  if (index === 1) {
    // tiny editor mock with zoom region
    return (
      <div className="relative h-full bg-gradient-to-br from-[#0B0D11] to-[#0E1218]">
        <div className="absolute inset-2 grid grid-cols-3 gap-1">
          <div className="rounded bg-white/[0.04]" />
          <div className="rounded border border-violet-400/40 bg-violet-500/10" />
          <div className="rounded bg-white/[0.04]" />
        </div>
        <div className="absolute inset-x-3 bottom-3 h-1 rounded-full bg-white/[0.06]">
          <div className="h-full w-2/3 rounded-full bg-violet-500" />
        </div>
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-400/70 px-2 py-0.5 text-[10px] font-semibold text-violet-200">
          analyzing…
        </span>
      </div>
    );
  }
  // export format chips
  return (
    <div className="flex h-full flex-wrap items-center justify-center gap-1.5 p-4">
      {["1080p", "4K", "60FPS", "TikTok", "YouTube"].map((tag, i) => (
        <span
          key={tag}
          className={
            i === 1
              ? "inline-flex items-center rounded-md border border-violet-400/40 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-100"
              : "inline-flex items-center rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-fog"
          }
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
