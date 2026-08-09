"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { useLiveValue } from "@/components/dashboard/real-editor/useLiveValue";
import { COMMIT_PROFILES } from "@/components/dashboard/real-editor/live-commit";

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}

/**
 * Switch with OPTIMISTIC state: the knob moves on click, then the value is
 * persisted. Previously the knob only moved once the write had round-tripped
 * through the store, so a toggle read as unresponsive and invited the
 * second click that flipped it straight back.
 */
export function Toggle({ label, description, checked, onChange, className }: ToggleProps) {
  const live = useLiveValue(checked, onChange, COMMIT_PROFILES.discrete);
  const on = live.value;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-white/90">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs leading-relaxed text-fog">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => live.set(!on)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
          on
            ? "border-violet-500/50 bg-violet-500/40"
            : "border-white/10 bg-white/[0.04]"
        )}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 600, damping: 38 }}
          className={cn(
            "ml-0.5 inline-block size-5 rounded-full bg-white shadow-sm",
            on && "ml-auto mr-0.5"
          )}
        />
      </button>
    </div>
  );
}
