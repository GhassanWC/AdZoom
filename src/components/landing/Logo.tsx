"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";
import { BRAND } from "@/lib/branding";

/**
 * Official Framevo mark — a bold "F" letter framed by camera-viewfinder
 * corner brackets with a red record dot. Rendered as inline SVG so it
 * scales across every surface (footer, navbar, sidebar, login card)
 * without an asset round-trip.
 *
 * Each instance defines its own gradient with a unique id so multiple
 * Logos on the same page don't clash on the SVG fragment graph
 * (`<defs>` ids are page-global).
 *
 * The id comes from React's `useId()` — NOT a module-level counter. A
 * counter increments in a different order on the server vs the client
 * (depends on how many Logos rendered before this one in each
 * environment), so the gradient id diverged at hydration ("…-1" on the
 * server, "…-2" on the client) and React threw a hydration mismatch.
 * `useId` produces the same value on both sides. Colons are stripped so
 * the id is a clean SVG fragment identifier.
 *
 * Wordmark text reads `BRAND.name` from src/lib/branding.ts — never
 * hard-code the product name here.
 */
export function Logo({
  className,
  withWordmark = true,
  size = 28,
}: {
  className?: string;
  withWordmark?: boolean;
  /** Pixel size of the mark. Wordmark scales with it. */
  size?: number;
}) {
  const gradId = `framevo-violet-${useId().replace(/:/g, "")}`;
  const wordmarkPx = Math.round(size * 0.6); // ~17px for size=28

  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      style={{ height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        aria-label={BRAND.name}
        role="img"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BRAND.colors.primaryFrom} />
            <stop offset="100%" stopColor={BRAND.colors.primaryTo} />
          </linearGradient>
        </defs>

        {/* Corner brackets — camera viewfinder frame */}
        <g
          stroke={`url(#${gradId})`}
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M 28 11 H 12 V 27" />
          <path d="M 72 11 H 88 V 27" />
          <path d="M 12 73 V 89 H 28" />
          <path d="M 88 73 V 89 H 72" />
        </g>

        {/* "F" letter — filled, bold uppercase */}
        <path
          d="M 26 18 H 79 V 30 H 42 V 44 H 66 V 56 H 42 V 84 H 26 Z"
          fill={`url(#${gradId})`}
        />

        {/* Recording dot */}
        <circle cx="76" cy="26" r="5" fill={BRAND.colors.recordingDot} />
      </svg>

      {withWordmark && (
        <span
          className="font-display font-semibold tracking-tight text-white"
          style={{ fontSize: wordmarkPx, lineHeight: 1 }}
        >
          {BRAND.name}
        </span>
      )}
    </span>
  );
}
