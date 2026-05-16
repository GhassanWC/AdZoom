"use client";

import * as React from "react";
import {
  Lightbulb,
  ZoomIn,
  MousePointer2,
  Clock,
  ZoomOut,
  Crop,
  Check,
  X,
  Sparkles,
} from "lucide-react";
import { useEditorReal } from "./context";
import { generateSuggestions } from "@/lib/timeline/suggestions";
import { cn } from "@/lib/cn";
import type { SuggestionKind } from "@/lib/firebase/schema";

const KIND_META: Record<
  SuggestionKind,
  { Icon: typeof ZoomIn; tone: string; accept: string }
> = {
  "add-emphasis": { Icon: ZoomIn, tone: "text-violet-300", accept: "Add zoom" },
  "add-focus": { Icon: MousePointer2, tone: "text-cyan-300", accept: "Add focus" },
  "pacing-gap": { Icon: Clock, tone: "text-amber-300", accept: "Add edit" },
  "too-aggressive": { Icon: ZoomOut, tone: "text-rose-300", accept: "Soften" },
  tighten: { Icon: Crop, tone: "text-amber-300", accept: "Tighten" },
};

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * AI suggestion layer — the assistant, not the dictator.
 *
 * Lists non-destructive recommendations the user can accept or dismiss. The AI
 * never auto-applies anything here; the human stays in control.
 */
export function SuggestionsPanel() {
  const {
    project,
    duration,
    seek,
    acceptSuggestion,
    dismissSuggestion,
    setSelectedMomentId,
  } = useEditorReal();

  const total = duration > 0 ? duration : project.duration ?? 0;
  const analyzed = project.analysis?.status === "complete";

  const suggestions = React.useMemo(
    () =>
      generateSuggestions(
        project.analysis,
        project.visualAnalysis,
        total,
        project.effectsSettings.pacing
      ),
    [project.analysis, project.visualAnalysis, total, project.effectsSettings.pacing]
  );

  if (!analyzed) return null;

  return (
    <div className="glass rounded-xl">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300">
          <Lightbulb size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-white">AI suggestions</h3>
          <p className="text-[11px] text-fog">
            Ideas to refine your edit — accept or dismiss, your call.
          </p>
        </div>
        {suggestions.length > 0 && (
          <span className="rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">
            {suggestions.length}
          </span>
        )}
      </div>

      <div className="px-3 py-3">
        {suggestions.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-fog">
            <Sparkles size={13} className="text-emerald-300" />
            Nothing to flag — your timeline looks well balanced.
          </div>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s) => {
              const meta = KIND_META[s.kind];
              return (
                <li
                  key={s.id}
                  className="group rounded-lg border border-white/10 bg-white/[0.02] p-3 transition-colors duration-150 hover:border-white/20"
                >
                  <button
                    type="button"
                    onClick={() => {
                      seek(s.atTime);
                      if (s.momentId) setSelectedMomentId(s.momentId);
                    }}
                    className="flex w-full items-start gap-2.5 text-left"
                  >
                    <span className={cn("mt-0.5 shrink-0", meta.tone)}>
                      <meta.Icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium text-white">
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-fog">
                        {s.detail}
                      </span>
                    </span>
                    <span className="shrink-0 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-fog">
                      {fmt(s.atTime)}
                    </span>
                  </button>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => acceptSuggestion(s)}
                      className="inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-100 transition-colors duration-150 hover:bg-violet-500/25"
                    >
                      <Check size={10} />
                      {meta.accept}
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissSuggestion(s.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1 text-[10px] font-medium text-fog transition-colors duration-150 hover:border-white/25 hover:text-white"
                    >
                      <X size={10} />
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
