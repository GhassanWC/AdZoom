import { ToggleRight, Gauge, Undo2, SlidersHorizontal } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { RevealOnView } from "@/components/ui/RevealOnView";

const CONTROLS = [
  {
    Icon: ToggleRight,
    title: "Choose which engines run",
    body: "Turn camera edits, cuts, or speed-ups on and off before each analysis.",
  },
  {
    Icon: Gauge,
    title: "Choose the analysis detail",
    body: "Pick faster, balanced, or more detailed chunking depending on the video.",
  },
  {
    Icon: Undo2,
    title: "Edit, delete, or restore moments",
    body: "Every AI suggestion is reviewable — keep it, tweak it, remove it, or bring it back.",
  },
  {
    Icon: SlidersHorizontal,
    title: "Full manual timeline",
    body: "Drag, resize, split, and fine-tune any edit. The AI drafts; you ship the final cut.",
  },
];

export function Control() {
  return (
    <Section
      id="control"
      eyebrow="You stay in control"
      title={
        <>
          AI drafts the edit.{" "}
          <span className="text-gradient-violet">You control the timeline.</span>
        </>
      }
      subtitle="Framevo never exports something you haven't seen. Every cut, zoom, and speed-up lands on an editable timeline you own."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CONTROLS.map((c, i) => (
          <RevealOnView key={c.title} delay={i * 0.05}>
            <div className="glass flex h-full items-start gap-4 rounded-2xl p-6">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                <c.Icon size={18} />
              </span>
              <div>
                <h3 className="font-display text-[15.5px] font-semibold tracking-tight text-white">
                  {c.title}
                </h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-fog">{c.body}</p>
              </div>
            </div>
          </RevealOnView>
        ))}
      </div>
    </Section>
  );
}
