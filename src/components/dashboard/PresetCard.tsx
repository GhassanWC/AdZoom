"use client";

import { Check, MoreHorizontal, Sparkles, User } from "lucide-react";
import type { Preset } from "@/lib/firebase/schema";
import { PresetThumb } from "@/components/landing/PresetThumb";
import { cn } from "@/lib/cn";

interface PresetCardProps {
  preset: Preset;
  active?: boolean;
  recommended?: boolean;
  onOpen: () => void;
  onMenu?: () => void;
}

export function PresetCard({
  preset,
  active,
  recommended,
  onOpen,
  onMenu,
}: PresetCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group glass relative w-full overflow-hidden rounded-xl text-left transition-all duration-200",
        active
          ? "border-violet-400/50 ring-2 ring-violet-400/30 shadow-[0_0_24px_-8px_rgba(139,92,246,0.55)]"
          : "hover:border-white/[0.12]"
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b border-white/[0.06]">
        <PresetThumb vibe={preset.vibe} />

        {recommended && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-violet-400/50 bg-violet-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-100 backdrop-blur-md">
            <Sparkles size={10} />
            For this video
          </span>
        )}

        {preset.isCustom && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-md">
            <User size={10} />
            Custom
          </span>
        )}

        {active && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-violet-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white shadow-violet-glow">
            <Check size={10} />
            Applied
          </span>
        )}
      </div>

      <div className="px-4 py-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-display text-sm font-semibold text-white">
                {preset.name}
              </h3>
              <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-fog">
                {preset.category}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fog">
              {preset.description}
            </p>
          </div>
          {onMenu && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Preset menu"
              onClick={(e) => {
                e.stopPropagation();
                onMenu();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onMenu();
                }
              }}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:border-white/20 hover:text-white"
            >
              <MoreHorizontal size={12} />
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
