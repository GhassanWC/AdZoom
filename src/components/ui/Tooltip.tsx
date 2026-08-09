"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
  /** `right` is what a vertical icon rail wants — the label sits beside the icon. */
  side?: "top" | "bottom" | "right";
}

export function Tooltip({ content, children, className, side = "top" }: TooltipProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-white/10 bg-surface/95 px-2.5 py-1.5 text-xs text-white/90 shadow-cinematic backdrop-blur-xl",
            // Vertical sides centre on X; `right` centres on Y instead.
            side === "top" && "bottom-full left-1/2 mb-2 -translate-x-1/2",
            side === "bottom" && "left-1/2 top-full mt-2 -translate-x-1/2",
            side === "right" && "left-full top-1/2 ml-2 -translate-y-1/2"
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
