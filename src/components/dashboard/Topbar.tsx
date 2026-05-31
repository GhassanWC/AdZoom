"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, LogOut, Video, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useTheme } from "@/lib/theme";
import { NavbarSearch } from "./NavbarSearch";
import { NavbarNotifications } from "./NavbarNotifications";

interface TopbarProps {
  onOpenSidebar: () => void;
  className?: string;
}

export function Topbar({ onOpenSidebar, className }: TopbarProps) {
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const initials = user?.displayName
    ? user.displayName
        .split(" ")
        .map((s) => s[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.06] bg-ink/70 px-4 backdrop-blur-xl lg:px-8",
        className
      )}
    >
      <button
        aria-label="Open menu"
        onClick={onOpenSidebar}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-white lg:hidden"
      >
        <Menu size={16} />
      </button>

      <NavbarSearch />

      <Link
        href="/dashboard/record"
        title="Start a new recording (⌘⇧R)"
        className="group inline-flex h-9 items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-4 text-sm font-semibold text-white shadow-[0_10px_24px_-12px_rgba(139,92,246,0.7)] transition-all duration-200 hover:from-violet-500 hover:to-violet-500 hover:shadow-[0_14px_30px_-12px_rgba(139,92,246,0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inset-0 -m-0.5 rounded-full bg-rose-400/60 opacity-80 transition-opacity duration-200 group-hover:opacity-100 animate-pulse" />
          <span className="relative size-2 rounded-full bg-white" />
        </span>
        <span className="hidden sm:inline">Record</span>
        <Video size={14} className="sm:hidden" />
      </Link>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:text-white"
      >
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      <NavbarNotifications />

      <div ref={ref} className="relative">
        <button
          aria-label="Account"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] p-1 pr-3 transition-colors duration-200 hover:border-white/20"
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="size-7 rounded-full"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span
              className="inline-flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 text-[11px] font-semibold text-white"
              aria-hidden
            >
              {initials}
            </span>
          )}
          <span className="hidden text-xs font-medium text-white sm:inline">
            {user?.displayName?.split(" ")[0] ?? "Account"}
          </span>
        </button>

        {open && (
          <div className="absolute right-0 top-12 z-40 w-64 overflow-hidden rounded-xl border border-white/10 bg-surface/95 shadow-cinematic backdrop-blur-xl">
            <div className="border-b border-white/[0.06] px-4 py-3">
              <div className="truncate text-sm font-medium text-white">
                {user?.displayName || "Anonymous"}
              </div>
              <div className="truncate text-[11px] text-fog">{user?.email}</div>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                signOut();
              }}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-white/85 transition-colors duration-150 hover:bg-white/[0.04] hover:text-white"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
