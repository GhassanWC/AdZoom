import { cn } from "@/lib/cn";

export function Logo({ className, withWordmark = true }: { className?: string; withWordmark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="relative inline-flex size-7 items-center justify-center rounded-[9px] bg-gradient-to-br from-violet-500 to-cyan-400 shadow-[0_4px_18px_-4px_rgba(139,92,246,0.6)]"
      >
        <span className="absolute inset-[3px] rounded-[6px] bg-ink/80" />
        <svg
          viewBox="0 0 24 24"
          className="relative size-3.5 text-white"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="6" />
          <path d="M16 16l4 4" />
        </svg>
      </span>
      {withWordmark && (
        <span className="font-display text-[17px] font-semibold tracking-tight text-white">
          AdZoom
        </span>
      )}
    </span>
  );
}
