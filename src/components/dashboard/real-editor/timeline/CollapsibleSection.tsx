"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { readPersistedBool, writePersistedBool } from "./utils";

/**
 * Lightweight disclosure wrapper used by the secondary timeline bands
 * (Narrative + Distribution). Defaults to collapsed; user preference
 * persists per `storageKey` via localStorage. Uses CSS-driven open state on a
 * native <details> to avoid layout-thrash mid-toggle.
 */
export function CollapsibleSection({
  title,
  meta,
  storageKey,
  defaultOpen = false,
  forceCollapsed = false,
  children,
}: {
  title: string;
  /** Short summary chip on the right of the header (e.g. "8 segments"). */
  meta?: React.ReactNode;
  /** localStorage key for persistence. */
  storageKey: string;
  defaultOpen?: boolean;
  /**
   * Override that forces the section closed regardless of persisted state
   * (used for small-screen auto-collapse).
   */
  forceCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  // Hydrate from localStorage on mount — SSR-safe.
  React.useEffect(() => {
    setOpen(readPersistedBool(storageKey, defaultOpen));
  }, [storageKey, defaultOpen]);

  const effectiveOpen = forceCollapsed ? false : open;

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.015]">
      <button
        type="button"
        onClick={() => {
          const next = !effectiveOpen;
          setOpen(next);
          writePersistedBool(storageKey, next);
        }}
        aria-expanded={effectiveOpen}
        disabled={forceCollapsed}
        className="group flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-white/[0.02] disabled:cursor-default disabled:opacity-70"
      >
        <ChevronRight
          size={13}
          className={cn(
            "shrink-0 text-fog transition-transform duration-200",
            effectiveOpen && "rotate-90 text-violet-300"
          )}
        />
        <span className="text-[12px] font-semibold uppercase tracking-[0.14em] text-fog">
          {title}
        </span>
        {meta && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-fog/85">
            {meta}
          </span>
        )}
      </button>
      {effectiveOpen && (
        <div className="border-t border-white/[0.04] px-4 py-3">{children}</div>
      )}
    </section>
  );
}
