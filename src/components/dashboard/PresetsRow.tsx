"use client";

import { Sparkles } from "lucide-react";
import { presets } from "@/lib/mockData";
import { PresetThumb } from "@/components/landing/PresetThumb";
import { useEditor } from "./editor-state";
import { cn } from "@/lib/cn";

const editorPresets = presets.filter((p) => p.isInDashboard).slice(0, 5);

export function PresetsRow() {
  const { preset, applyPreset } = useEditor();

  return (
    <div className="glass rounded-xl">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3">
        <Sparkles size={13} className="text-violet-300" />
        <h3 className="text-sm font-semibold text-white">Presets</h3>
        <span className="ml-2 text-[11px] text-fog">One-click style</span>
      </div>
      <div className="flex gap-3 overflow-x-auto px-5 py-4">
        {editorPresets.map((p) => {
          const active = preset === p.name;
          return (
            <button
              key={p.id}
              onClick={() => applyPreset(p.name)}
              className={cn(
                "group relative w-36 shrink-0 overflow-hidden rounded-lg border bg-white/[0.02] text-left transition-all duration-200",
                active
                  ? "border-violet-400/50 ring-2 ring-violet-400/30 shadow-[0_0_24px_-8px_rgba(139,92,246,0.5)]"
                  : "border-white/10 hover:border-white/20"
              )}
            >
              <div className="aspect-[16/10] overflow-hidden">
                <PresetThumb vibe={p.vibe} />
              </div>
              <div className="px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-white">{p.name}</span>
                  {active && (
                    <span className="inline-flex h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.7)]" />
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
