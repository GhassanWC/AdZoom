"use client";

import * as React from "react";
import {
  Sparkles,
  Smartphone,
  User,
  Mic,
  AppWindow,
  GraduationCap,
  Video,
  Megaphone,
  MonitorPlay,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { SELECTED_VIDEO_TYPES, VIDEO_TYPE_META } from "@/lib/analysis/video-type";
import type { SelectedVideoType } from "@/lib/firebase/schema";

const TYPE_ICON: Record<SelectedVideoType, LucideIcon> = {
  auto: Sparkles,
  "reels-shorts": Smartphone,
  "talking-head": User,
  "podcast-clip": Mic,
  "product-demo": AppWindow,
  tutorial: GraduationCap,
  vlog: Video,
  "ad-promo": Megaphone,
  "screen-recording": MonitorPlay,
};

/**
 * Video-type picker — a card grid the user chooses from BEFORE analysis. Auto
 * Detect is the default. The selected card is highlighted; each card carries a
 * one-line description of the type. Controlled: parent owns `value`.
 */
export function VideoTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: SelectedVideoType;
  onChange: (t: SelectedVideoType) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Video type"
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
    >
      {SELECTED_VIDEO_TYPES.map((t) => {
        const meta = VIDEO_TYPE_META[t];
        const Icon = TYPE_ICON[t];
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(t)}
            className={cn(
              "flex flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
              active
                ? "border-violet-400/50 bg-violet-500/[0.12] ring-1 ring-violet-400/30"
                : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]",
              disabled && "pointer-events-none opacity-60"
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
                  active ? "bg-violet-500/25 text-violet-100" : "bg-white/[0.05] text-fog"
                )}
              >
                <Icon size={14} />
              </span>
              <span
                className={cn(
                  "text-[13px] font-semibold leading-tight",
                  active ? "text-white" : "text-white/85"
                )}
              >
                {meta.label}
              </span>
              {t === "auto" && (
                <span className="ml-auto rounded bg-violet-400/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-200">
                  Default
                </span>
              )}
            </span>
            <span className="text-[11.5px] leading-snug text-fog">{meta.description}</span>
          </button>
        );
      })}
    </div>
  );
}
