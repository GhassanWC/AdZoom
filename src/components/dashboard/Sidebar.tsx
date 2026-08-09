"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Folder,
  Upload,
  Download,
  CreditCard,
  Settings,
  Sparkles,
  Video,
  Activity,
  Cpu,
  HardDrive,
  X,
  type LucideIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/landing/Logo";
import { Tooltip } from "@/components/ui/Tooltip";
import { sidebarItems } from "@/lib/mockData";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { fmtBytes, storageBand } from "@/lib/usage/plan";

const icons: Record<string, LucideIcon> = {
  LayoutDashboard,
  Folder,
  Upload,
  Download,
  CreditCard,
  Settings,
  Video,
  Activity,
  Cpu,
  HardDrive,
};

export interface SidebarItem {
  label: string;
  href: string;
  icon: string;
}

/**
 * How the fixed sidebar presents itself.
 *
 *   default — the website: 256px, icon + text label, storage/plan footer.
 *   rail    — the desktop app: 72px, icons only, each name in a hover tooltip,
 *             no footer card. An installed app is a place people live in, so
 *             it trades a nav it has already learned for editor width.
 *
 * The variant changes PRESENTATION only. Route list, active-state rule and
 * navigation behaviour are shared by both, so a link can never work in one
 * shell and not the other.
 */
export type SidebarVariant = "default" | "rail";

/**
 * Fixed-sidebar width per variant, and the matching content padding.
 *
 * Two values that MUST agree: the sidebar is `fixed`, so it is out of flow and
 * the content beside it is only clear of it because of this padding. They live
 * together so a width change cannot land without the padding following. The
 * padding is `lg:`-only — below that breakpoint the sidebar is a drawer and the
 * content is full width. Class strings are written out in full because Tailwind
 * scans source text and cannot see a name that was assembled at runtime.
 */
export const SIDEBAR_WIDTH: Record<SidebarVariant, string> = {
  default: "16rem", // 256px
  rail: "4.5rem", //  72px
};

export const SIDEBAR_CONTENT_PAD: Record<SidebarVariant, string> = {
  default: "lg:pl-64",
  rail: "lg:pl-[4.5rem]",
};

// Diagnostics is an internal/dev tool — hide it from the production nav.
const DEV_ONLY_HREFS = new Set(["/dashboard/diagnostics"]);
const navItems =
  process.env.NODE_ENV === "production"
    ? sidebarItems.filter((i) => !DEV_ONLY_HREFS.has(i.href))
    : sidebarItems;

/**
 * The Framevo navigation content (logo, nav items, storage/plan footer) —
 * shared by the persistent dashboard sidebar and its mobile drawer, on every
 * workspace route INCLUDING the fullscreen editor. `onNavigate` fires when a
 * link is chosen so the drawer can close itself.
 *
 * The editor used to render its own copy of this drawer with the defaults
 * below, which is how it ended up showing the website's route list and a
 * storage card inside a desktop app that had dropped both. There is one nav
 * now, mounted by the shell, and no way for a second to drift from it.
 *
 * `items` and `homeHref` exist for the desktop shell, whose route set differs
 * from the website's by exactly two entries (it adds Storage, it has no
 * marketing home to link the logo at). `compact` and `showFooter` exist for the
 * same shell's 72px rail. EVERY prop defaults to today's website behaviour, so
 * the site renders identically without passing anything.
 *
 * The nav LIST is deliberately not duplicated per variant: the same `items`,
 * the same active-state expression and the same hrefs drive both, so a route
 * cannot work in one shell and quietly break in the other. Only the markup
 * around them changes.
 */
export function SidebarNav({
  onNavigate,
  items = navItems,
  homeHref = "/",
  compact = false,
  showFooter = true,
}: {
  onNavigate?: () => void;
  items?: SidebarItem[];
  homeHref?: string;
  /** Icons only, each name in a hover tooltip. The 72px rail. */
  compact?: boolean;
  /**
   * Render the storage / plan card. `false` also means the storage HOOK never
   * mounts — it subscribes to every cloud project, so the card is the reason a
   * shell that shows it pays for a full project listing on every screen.
   */
  showFooter?: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-16 items-center",
          compact ? "justify-center px-0" : "px-5"
        )}
      >
        <Link href={homeHref} aria-label="Framevo home">
          {/* The rail has no room for the wordmark, and an installed app does
              not need to tell you which app it is. */}
          <Logo withWordmark={!compact} size={compact ? 26 : 28} />
        </Link>
      </div>

      <ul className={cn("flex-1 py-2", compact ? "space-y-1 px-0" : "space-y-0.5 px-3")}>
        {items.map((item) => {
          const Icon = icons[item.icon];
          // Unchanged in both variants — presentation differs, routing does not.
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));

          if (compact) {
            return (
              <li key={item.href} className="relative flex justify-center">
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.6)]"
                  />
                )}
                <Tooltip content={item.label} side="right">
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    // The icon carries no text, so the accessible name has to
                    // come from here — a screen reader must still hear "Exports".
                    aria-label={item.label}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-xl transition-colors duration-200",
                      active
                        ? "bg-white/[0.06] text-white"
                        : "text-fog hover:bg-white/[0.03] hover:text-white"
                    )}
                  >
                    <Icon size={18} className={active ? "text-violet-300" : ""} />
                  </Link>
                </Tooltip>
              </li>
            );
          }

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                  active
                    ? "bg-white/[0.04] text-white"
                    : "text-fog hover:bg-white/[0.02] hover:text-white"
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.6)]" />
                )}
                <Icon size={16} className={active ? "text-violet-300" : ""} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      {showFooter && <StoragePlanCard />}
    </nav>
  );
}

/**
 * The storage meter + plan row.
 *
 * Its own component so that a shell which doesn't show it never CALLS
 * `useStoragePlan()` — a hook cannot be skipped conditionally, and that hook
 * opens a Firestore subscription to every project the account owns.
 */
function StoragePlanCard() {
  const storage = useStoragePlan();
  const band = storageBand(storage.usedBytes, storage.limitBytes);
  const barClass =
    band === "danger"
      ? "bg-gradient-to-r from-rose-500 to-rose-400"
      : band === "warn"
        ? "bg-gradient-to-r from-amber-400 to-amber-300"
        : "bg-gradient-to-r from-violet-500 to-cyan-400";
  const usagePct = Math.max(1, Math.round(storage.fraction * 100));

  return (
    <div className="m-3 space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white">Storage</span>
        <span
          className={cn(
            "font-mono text-[10px] tabular-nums",
            band === "danger"
              ? "text-rose-300"
              : band === "warn"
                ? "text-amber-200"
                : "text-fog"
          )}
          title={`${storage.projectCount} project${storage.projectCount === 1 ? "" : "s"}`}
        >
          {fmtBytes(storage.usedBytes)} / {fmtBytes(storage.limitBytes)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", barClass)}
          style={{ width: `${usagePct}%` }}
        />
      </div>

      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-violet-500/15 text-violet-300">
            <Sparkles size={11} />
          </span>
          <span className="text-xs font-medium text-white">{storage.plan.name}</span>
        </div>
        <Link
          href="/dashboard/billing"
          className="text-[11px] text-fog underline-offset-4 hover:text-white hover:underline"
        >
          {storage.plan.ctaLabel}
        </Link>
      </div>
    </div>
  );
}

export function Sidebar({
  open,
  onClose,
  items,
  homeHref,
  variant = "default",
}: {
  open: boolean;
  onClose: () => void;
  items?: SidebarItem[];
  homeHref?: string;
  variant?: SidebarVariant;
}) {
  const rail = variant === "rail";
  return (
    <>
      {/* Fixed sidebar (lg and up) — the rail on desktop, labelled on the web. */}
      <aside
        style={{ width: SIDEBAR_WIDTH[variant] }}
        className="hidden border-r border-white/[0.06] bg-surface/40 backdrop-blur-xl lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:flex-col"
      >
        <SidebarNav items={items} homeHref={homeHref} compact={rail} showFooter={!rail} />
      </aside>

      {/* Mobile drawer — the ONE nav drawer in the app, so it has to clear the
          densest chrome that can be under it. That is the editor's sticky
          header at z-[60], not the dashboard Topbar at z-30; the 130/131 pair
          is the editor's own drawer layer, which puts this above the workspace
          and still below modals (140+) and toasts (150). */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onClose}
              className="fixed inset-0 z-[130] bg-ink/70 backdrop-blur-md lg:hidden"
            />
            <motion.aside
              key="drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-[131] flex w-72 flex-col border-r border-white/[0.06] bg-surface lg:hidden"
            >
              <button
                aria-label="Close menu"
                onClick={onClose}
                className="absolute right-3 top-4 inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white"
              >
                <X size={16} />
              </button>
              {/* The drawer keeps its LABELS at every variant — it is 288px
                  wide and only appears below `lg`, so there is nothing to save
                  by hiding them. It drops the footer card with the rail, so the
                  desktop has no storage/plan card on any breakpoint. */}
              <SidebarNav
                onNavigate={onClose}
                items={items}
                homeHref={homeHref}
                showFooter={!rail}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
