"use client";

import { Sparkles, MousePointer2 } from "lucide-react";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { useEditorReal } from "./context";
import { cn } from "@/lib/cn";

const styles = ["ring", "pulse", "burst"] as const;

export function RealEffectsPanel() {
  const { project, updateEffects } = useEditorReal();
  const e = project.effectsSettings;

  return (
    <div className="glass rounded-xl">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
          <Sparkles size={13} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-white">Effects</h3>
          <p className="text-[11px] text-fog">Global defaults for this project</p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <Section title="Zoom">
          <Slider
            label="Auto Zoom Intensity"
            value={e.autoZoom}
            onChange={(v) => updateEffects("autoZoom", v)}
          />
          <Slider
            label="Zoom Speed"
            value={e.zoomSpeed}
            onChange={(v) => updateEffects("zoomSpeed", v)}
          />
          <Slider
            label="Motion Sensitivity"
            value={e.motionSensitivity}
            onChange={(v) => updateEffects("motionSensitivity", v)}
          />
        </Section>

        <Section title="Cursor" icon={<MousePointer2 size={11} />}>
          <Slider
            label="Cursor Size"
            value={e.cursorSize}
            onChange={(v) => updateEffects("cursorSize", v)}
          />
          <Slider
            label="Cursor Smoothing"
            value={e.cursorSmoothing}
            onChange={(v) => updateEffects("cursorSmoothing", v)}
          />
        </Section>

        <Section title="Click highlights">
          <Slider
            label="Highlight Size"
            value={e.clickHighlightSize}
            onChange={(v) => updateEffects("clickHighlightSize", v)}
          />
          <div>
            <div className="mb-2 text-xs font-medium text-fog">Style</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
              {styles.map((s) => (
                <button
                  key={s}
                  onClick={() => updateEffects("clickHighlightStyle", s)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors duration-150",
                    e.clickHighlightStyle === s
                      ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                      : "text-fog hover:bg-white/[0.04] hover:text-white"
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Toggles">
          <Toggle
            label="Vertical Export"
            description="Reframe to 9:16 for shorts."
            checked={e.verticalExport}
            onChange={(v) => updateEffects("verticalExport", v)}
          />
          <Toggle
            label="Click Highlights"
            description="Animated ring on each click event."
            checked={e.clickHighlights}
            onChange={(v) => updateEffects("clickHighlights", v)}
          />
          <Toggle
            label="Motion Tracking"
            description="Lock zoom to cursor across windows."
            checked={e.motionTracking}
            onChange={(v) => updateEffects("motionTracking", v)}
          />
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-fog">
        {icon}
        {title}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
