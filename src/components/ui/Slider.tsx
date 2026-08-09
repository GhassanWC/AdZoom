"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { useLiveValue } from "@/components/dashboard/real-editor/useLiveValue";
import { COMMIT_PROFILES } from "@/components/dashboard/real-editor/live-commit";

interface SliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  className?: string;
  format?: (v: number) => string;
  /**
   * Persist on every change instead of on the drag cadence. Only for sliders
   * whose `onChange` is already cheap local state — anything that writes to the
   * project document should use the default.
   */
  immediate?: boolean;
}

/**
 * Range slider with LOCAL drag state.
 *
 * The handle used to be driven straight from persisted state: each pixel of a
 * drag called `onChange`, which serialized and wrote the project document, and
 * the handle only moved once that write echoed back through the subscription.
 * The result was a slider that lagged the pointer and dropped input.
 *
 * Now the handle follows the pointer immediately (local state) and the value is
 * persisted on the drag cadence — fast enough that the preview tracks the
 * handle, slow enough that a drag is a handful of writes instead of hundreds.
 * The final value is always committed on release (and on unmount).
 */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  onChange,
  className,
  format,
  immediate = false,
}: SliderProps) {
  const live = useLiveValue(
    value,
    onChange,
    immediate ? { delayMs: 0, maxWaitMs: 0 } : COMMIT_PROFILES.drag
  );
  const shown = live.value;
  const pct = ((shown - min) / (max - min)) * 100;
  const display = format ? format(shown) : `${shown}${unit}`;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-fog">{label}</label>
        <span className="font-mono text-xs tabular-nums text-white/85">{display}</span>
      </div>
      <div className="relative h-5">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/[0.06]" />
        <div
          className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-violet-500"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          onChange={(e) => live.set(Number(e.target.value))}
          // A gesture freezes reconciliation, so the write echoing back
          // mid-drag can never yank the handle out from under the pointer.
          onPointerDown={live.begin}
          onPointerUp={live.end}
          onPointerCancel={live.end}
          // Keyboard adjustment is a gesture too: hold ↑ and the repeat rate
          // would otherwise out-run the write and rubber-band the handle.
          onKeyDown={live.begin}
          onKeyUp={live.end}
          onBlur={live.end}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={shown}
          className="range-thumb absolute inset-0 z-10 w-full cursor-grab opacity-100"
        />
      </div>
    </div>
  );
}
