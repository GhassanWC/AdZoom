"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
  side?: "top" | "bottom";
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
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-surface/95 px-2.5 py-1.5 text-xs text-white/90 shadow-cinematic backdrop-blur-xl",
            side === "top" && "bottom-full mb-2",
            side === "bottom" && "top-full mt-2"
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
