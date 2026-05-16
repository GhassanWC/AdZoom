"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  spotlight?: boolean;
  padded?: boolean;
  as?: keyof React.JSX.IntrinsicElements;
}

export function GlassCard({
  className,
  children,
  spotlight = false,
  padded = true,
  onMouseMove,
  ...rest
}: GlassCardProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (spotlight && ref.current) {
      const r = ref.current.getBoundingClientRect();
      ref.current.style.setProperty("--mx", `${e.clientX - r.left}px`);
      ref.current.style.setProperty("--my", `${e.clientY - r.top}px`);
    }
    onMouseMove?.(e);
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      className={cn(
        "glass rounded-2xl transition-colors duration-200 hover:border-white/[0.12]",
        spotlight && "spotlight",
        padded && "p-6",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
