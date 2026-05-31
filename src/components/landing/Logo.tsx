import { cn } from "@/lib/cn";

/**
 * Official AdZoom mark — a bold "A" letter framed by camera-viewfinder
 * corner brackets with a red record dot. Rendered as inline SVG so it
 * scales across every surface (footer, navbar, sidebar, login card)
 * without an asset round-trip.
 *
 * Each instance defines its own gradient with a unique id so multiple
 * Logos on the same page don't clash on the SVG fragment fragment
 * graph (`<defs>` ids are page-global).
 */
let logoIdCounter = 0;

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
  const uid = (logoIdCounter += 1);
  const gradId = `adzoom-violet-${uid}`;
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
        aria-label="AdZoom"
        role="img"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#A78BFA" />
            <stop offset="100%" stopColor="#7C3AED" />
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

        {/* "A" letter — filled, with inner triangle hole */}
        <path
          d="M 22 84 L 50 18 L 78 84 L 66 84 L 60 68 L 40 68 L 34 84 Z
             M 50 36 L 57 60 L 43 60 Z"
          fill={`url(#${gradId})`}
          fillRule="evenodd"
        />

        {/* Recording dot */}
        <circle cx="76" cy="26" r="5" fill="#EF4444" />
      </svg>

      {withWordmark && (
        <span
          className="font-display font-semibold tracking-tight text-white"
          style={{ fontSize: wordmarkPx, lineHeight: 1 }}
        >
          AdZoom
        </span>
      )}
    </span>
  );
}
