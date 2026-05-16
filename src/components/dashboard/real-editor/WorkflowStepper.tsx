"use client";

import { Upload, Sparkles, Sliders, Download, Check } from "lucide-react";
import { cn } from "@/lib/cn";

export type WorkflowStep = "upload" | "analyze" | "refine" | "export";
export type StepState = "complete" | "active" | "pending";

interface WorkflowStepperProps {
  /** Which step is currently the user's focus. */
  current: WorkflowStep;
  /** Per-step overrides — e.g. analyze "complete" while user is on "refine". */
  states?: Partial<Record<WorkflowStep, StepState>>;
  className?: string;
}

const STEPS: { id: WorkflowStep; label: string; hint: string; Icon: typeof Upload }[] = [
  { id: "upload", label: "Upload", hint: "Your recording", Icon: Upload },
  { id: "analyze", label: "Analyze", hint: "AI first draft", Icon: Sparkles },
  { id: "refine", label: "Refine", hint: "Your edits", Icon: Sliders },
  { id: "export", label: "Export", hint: "Render & share", Icon: Download },
];

/**
 * Top-of-editor workflow stepper. Communicates that the workflow is
 * Upload → Analyze → Refine → Export and shows where the user is in it.
 */
export function WorkflowStepper({ current, states, className }: WorkflowStepperProps) {
  const currentIndex = STEPS.findIndex((s) => s.id === current);

  const resolveState = (id: WorkflowStep, idx: number): StepState => {
    const override = states?.[id];
    if (override) return override;
    if (idx < currentIndex) return "complete";
    if (idx === currentIndex) return "active";
    return "pending";
  };

  return (
    <ol
      aria-label="Editor workflow"
      className={cn(
        "glass relative flex w-full items-stretch overflow-hidden rounded-2xl p-1.5",
        className
      )}
    >
      {STEPS.map((s, i) => {
        const state = resolveState(s.id, i);
        const isLast = i === STEPS.length - 1;
        return (
          <li key={s.id} className="flex flex-1 items-center">
            <div
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-all duration-300",
                state === "active" &&
                  "bg-gradient-to-br from-violet-500/15 via-violet-500/[0.06] to-transparent ring-1 ring-violet-400/30",
                state === "complete" && "bg-white/[0.02]",
                state === "pending" && "opacity-50"
              )}
            >
              <span
                className={cn(
                  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-300",
                  state === "complete" &&
                    "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30",
                  state === "active" &&
                    "bg-violet-500 text-white shadow-[0_0_24px_-4px_rgba(139,92,246,0.65)] ring-1 ring-violet-300/40",
                  state === "pending" &&
                    "bg-white/[0.03] text-fog ring-1 ring-white/[0.06]"
                )}
              >
                {state === "complete" ? <Check size={16} /> : <s.Icon size={16} />}
              </span>
              <div className="min-w-0">
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                    state === "active" ? "text-violet-200" : "text-fog"
                  )}
                >
                  Step {i + 1}
                </div>
                <div
                  className={cn(
                    "truncate font-display text-sm font-semibold leading-tight",
                    state === "pending" ? "text-fog" : "text-white"
                  )}
                >
                  {s.label}
                </div>
                <div className="truncate text-[11px] leading-tight text-fog">
                  {s.hint}
                </div>
              </div>
            </div>
            {!isLast && (
              <span
                aria-hidden
                className={cn(
                  "mx-1 hidden h-px w-6 shrink-0 sm:block",
                  state === "complete" ? "bg-emerald-400/40" : "bg-white/10"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
