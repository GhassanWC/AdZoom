"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { useTheme, type Theme } from "@/lib/theme";

/**
 * The workspace's light/dark control, docked to the bottom-right.
 *
 * WHY A SEGMENTED PAIR, not the single icon-button it replaces in the topbar:
 * one icon has to mean two things — the current theme or the one you'd switch
 * to — and every product picks a different answer, so the user has to press it
 * to find out. Two segments with a lit one state the current theme outright and
 * make the alternative a single click, which is also why `aria-pressed` can be
 * honest here. It is a preference, not a workflow action: it belongs at the edge
 * of the app, near the chat bubble, rather than in the row you reach for a dozen
 * times an hour.
 *
 * POSITION. Flush to the bottom edge — no floating gap — so it reads as part of
 * the window rather than as something dropped on top of the page. Being pinned
 * there makes it the FLOOR of the bottom-right corner: everything else that
 * lands in that corner (the export pill, the website's chat bubble) is offset to
 * `bottom-16` to sit above it, because a control that is always on screen must
 * never be what a notification covers. Change `DOCK_HEIGHT` here and those two
 * offsets have to move with it.
 */
/** ~46px: two 36px segments plus the container's padding. */
export const THEME_DOCK_CLEARANCE = "bottom-16";
export function ThemeDock({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn(
        // Rounded on top, square and borderless at the bottom: the shape is what
        // makes "attached to the edge" read as deliberate instead of clipped.
        "fixed bottom-0 right-5 z-[118] flex items-center gap-0.5 rounded-t-2xl border border-b-0 border-white/10 bg-surface/90 p-1 pb-1.5 shadow-cinematic backdrop-blur-xl",
        className
      )}
    >
      <Segment
        value="light"
        current={theme}
        onSelect={setTheme}
        label="Light mode"
        icon={<Sun size={15} />}
      />
      <Segment
        value="dark"
        current={theme}
        onSelect={setTheme}
        label="Dark mode"
        icon={<Moon size={15} />}
      />
    </div>
  );
}

function Segment({
  value,
  current,
  onSelect,
  label,
  icon,
}: {
  value: Theme;
  current: Theme;
  onSelect: (theme: Theme) => void;
  label: string;
  icon: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        // 36px keeps the pair inside a comfortable tap target without turning
        // a preference control into the loudest thing on the screen.
        "fv-press-sm inline-flex size-9 items-center justify-center rounded-full transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
        active
          ? "bg-violet-500/15 text-violet-200"
          : "text-fog hover:bg-white/[0.05] hover:text-white"
      )}
    >
      {icon}
    </button>
  );
}
