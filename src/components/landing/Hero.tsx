"use client";

import { ArrowRight, Monitor, Square, AppWindow, Sparkles } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { HeroMockup } from "./HeroMockup";

type RecordingMode = "tab" | "window" | "monitor";

const MODES: { id: RecordingMode; label: string; sub: string; Icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "tab", label: "Tab", sub: "Click + element-aware", Icon: Square },
  { id: "window", label: "Window", sub: "App-scoped capture", Icon: AppWindow },
  { id: "monitor", label: "Monitor", sub: "Full-screen capture", Icon: Monitor },
];

export function Hero() {
  const [mode, setMode] = React.useState<RecordingMode>("tab");

  const onPick = (m: RecordingMode) => {
    setMode(m);
    // Scroll to the showcase below — the picker doesn't filter the
    // showcase yet, just signals "see what each mode produces".
    if (typeof window !== "undefined") {
      const el = document.getElementById("showcase");
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <section
      id="main"
      className="relative overflow-hidden pt-32 pb-24 lg:pt-44 lg:pb-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[760px] w-[1280px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.24),transparent_62%)] blur-3xl"
      />
      <div
        aria-hidden
        className="bg-grid mask-radial pointer-events-none absolute inset-0 -z-10 opacity-40"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-ink"
      />

      <Container>
        <div className="mx-auto max-w-[960px] text-center">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-fog backdrop-blur-md">
            <Sparkles size={12} className="text-violet-300" />
            Attention-aware video editor
          </div>

          <h1 className="font-display text-[clamp(3rem,8.25vw,6.25rem)] font-semibold leading-[0.93] tracking-[-0.05em] text-white">
            AdZoom understands what you did
            <br className="hidden sm:block" />{" "}
            <span className="text-gradient-violet">
              and directs the viewer&apos;s attention.
            </span>
          </h1>

          <p className="mx-auto mt-7 max-w-[660px] text-[17.5px] leading-relaxed text-fog">
            Record in your browser. AdZoom reads every click and navigation,
            understands the workflow, and composes a first-draft edit with
            cinematic camera moves. You stay in control of the timeline.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button
              href="/dashboard"
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight size={15} />}
            >
              Start Free
            </Button>
            <Button href="#showcase" variant="glass" size="lg">
              See the output
            </Button>
          </div>

          {/* Recording-mode segmented picker — Shipper-style tab row.
              Maps to the three browser-capture modes AdZoom actually
              supports (Tab / Window / Monitor). */}
          <div className="mt-10 flex justify-center">
            <div
              role="tablist"
              aria-label="Recording mode"
              className="inline-flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5 backdrop-blur-md"
            >
              {MODES.map(({ id, label, sub, Icon }) => {
                const active = mode === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => onPick(id)}
                    className={
                      "group flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-left transition-colors duration-200 " +
                      (active
                        ? "bg-violet-500/85 text-white shadow-[0_8px_24px_-12px_rgba(139,92,246,0.7)]"
                        : "text-fog hover:bg-white/[0.04] hover:text-white")
                    }
                  >
                    <Icon size={14} />
                    <span className="flex flex-col items-start leading-tight">
                      <span className="text-[12.5px] font-semibold">
                        {label}
                      </span>
                      <span
                        className={
                          "hidden text-[10.5px] sm:inline " +
                          (active ? "text-white/85" : "text-fog/80")
                        }
                      >
                        {sub}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-xs text-fog">
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              No credit card
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-violet-400" />
              Works in your browser
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-cyan-400" />
              4K export
            </span>
          </div>
        </div>

        <div className="relative mx-auto mt-20 max-w-[1180px] lg:mt-24">
          <HeroMockup />
        </div>
      </Container>
    </section>
  );
}
