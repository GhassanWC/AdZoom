"use client";

import { Lock } from "lucide-react";

/**
 * Dimmed, non-interactive lane for prepared-but-not-implemented track types
 * (speed ramps, crop regions). Communicates "this lane exists and is coming"
 * without exposing any controls. Purely a structural placeholder — it never
 * reads or writes moment data.
 */
export function PlaceholderLane({ label }: { label: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center gap-2 overflow-hidden px-3"
      aria-hidden
    >
      {/* Faint diagonal hatch so the lane reads as inactive. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, rgba(255,255,255,0.025) 0 6px, transparent 6px 12px)",
        }}
      />
      <span className="relative inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-0.5 text-[10px] font-medium text-fog/60">
        <Lock size={9} />
        Coming soon
      </span>
      <span className="relative truncate text-[11px] text-fog/45">{label}</span>
    </div>
  );
}
