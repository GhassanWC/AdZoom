"use client";

/**
 * Admin chrome: sidebar + top bar.
 *
 * Changes from the previous shell:
 *  • The mobile drawer is a real dialog — Escape closes it, focus is trapped
 *    inside while open, focus returns to the trigger on close, and body scroll
 *    is locked. Before, keyboard focus escaped behind the overlay into the page.
 *  • The desktop sidebar COLLAPSES to an icon rail, so wide tables get their
 *    width back on smaller laptops. The choice persists across navigations.
 *  • Semantic tokens throughout, so the admin renders correctly in light mode —
 *    the old shell used raw `text-white` / `bg-white/[0.0x]` and was dark-only.
 *  • Content is width-capped and centred, so metric cards don't stretch to
 *    absurd widths on an ultrawide display.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Folder,
  Cpu,
  Download,
  CreditCard,
  AlertTriangle,
  Activity,
  ArrowLeft,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { ADMIN_NAV } from "./adminNav";

const icons: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  Folder,
  Cpu,
  Download,
  CreditCard,
  AlertTriangle,
  Activity,
};

const COLLAPSE_KEY = "framevo:admin:sidebar-collapsed";
/** Same-tab notification — the `storage` event only fires in OTHER tabs. */
const COLLAPSE_EVENT = "framevo:admin:sidebar-changed";

/**
 * The sidebar collapse preference, read straight from localStorage.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: localStorage IS an
 * external store, and this is exactly the case the hook exists for. It also
 * handles the SSR seam correctly — `getServerSnapshot` returns the expanded
 * default so the server HTML and the hydration pass agree, then React re-reads
 * the real value. Doing it with a `setState` inside `useEffect` would render
 * one frame with the wrong sidebar width and visibly shift the layout.
 */
function useSidebarCollapsed(): [boolean, () => void] {
  const subscribe = React.useCallback((onChange: () => void) => {
    window.addEventListener("storage", onChange);
    window.addEventListener(COLLAPSE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(COLLAPSE_EVENT, onChange);
    };
  }, []);

  const getSnapshot = React.useCallback(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false; // storage unavailable (private mode) — use the default
    }
  }, []);

  const collapsed = React.useSyncExternalStore(subscribe, getSnapshot, () => false);

  const toggle = React.useCallback(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "0" : "1");
    } catch {
      /* non-fatal — the toggle just won't persist */
    }
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }, [collapsed]);

  return [collapsed, toggle];
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  const drawerRef = React.useRef<HTMLElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Drawer: Escape to close, focus trap, scroll lock, focus restore.
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const root = drawerRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    // Move focus into the drawer so the first Tab lands inside it.
    drawerRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const navList = (showLabels: boolean) => (
    <ul className="flex-1 space-y-0.5 px-2 py-2">
      {ADMIN_NAV.map((item) => {
        const Icon = icons[item.icon];
        const active =
          pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={active ? "page" : undefined}
              title={showLabels ? undefined : item.label}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
                showLabels ? "px-3" : "justify-center px-2",
                active
                  ? "bg-button-bg-soft text-text-primary"
                  : "text-text-muted hover:bg-button-bg-soft/60 hover:text-text-primary"
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-violet-400"
                />
              )}
              <Icon size={16} className={cn("shrink-0", active && "text-violet-300")} aria-hidden />
              {showLabels && <span className="truncate">{item.label}</span>}
              {!showLabels && <span className="sr-only">{item.label}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  const brand = (showLabels: boolean) => (
    <div className={cn("flex h-14 items-center gap-2", showLabels ? "px-4" : "justify-center px-2")}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 text-white">
        <ShieldCheck size={15} aria-hidden />
      </span>
      {showLabels && (
        <span className="truncate font-display text-sm font-semibold tracking-tight text-text-primary">
          Framevo <span className="text-text-muted">Admin</span>
        </span>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-ink">
      {/* Skip link — the first stop for keyboard users. */}
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-xs focus:text-text-primary"
      >
        Skip to content
      </a>

      {/* Desktop sidebar — collapsible to an icon rail. */}
      <aside
        aria-label="Admin navigation"
        className={cn(
          "hidden border-r border-border-soft bg-surface/50 backdrop-blur-xl lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:flex-col",
          collapsed ? "lg:w-16" : "lg:w-60"
        )}
      >
        {brand(!collapsed)}
        {navList(!collapsed)}
        <div className="border-t border-border-soft p-2">
          <Link
            href="/dashboard"
            title={collapsed ? "Back to app" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-lg py-2 text-xs text-text-muted transition-colors hover:bg-button-bg-soft/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60",
              collapsed ? "justify-center px-2" : "px-3"
            )}
          >
            <ArrowLeft size={13} aria-hidden />
            {!collapsed && <span>Back to app</span>}
            {collapsed && <span className="sr-only">Back to app</span>}
          </Link>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden">
          <div
            className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-md"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside
            ref={drawerRef}
            id="admin-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Admin navigation"
            className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border-soft bg-surface"
            style={{ animation: "var(--dur-panel) var(--ease-drawer) both" }}
          >
            <div className="flex items-center justify-between pr-2">
              {brand(true)}
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-lg border border-border-soft bg-button-bg-soft text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            {navList(true)}
            <div className="border-t border-border-soft p-2">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              >
                <ArrowLeft size={13} aria-hidden />
                Back to app
              </Link>
            </div>
          </aside>
        </div>
      )}

      <div className={cn(collapsed ? "lg:pl-16" : "lg:pl-60")}>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border-soft bg-ink/80 px-3 backdrop-blur-xl lg:px-6">
          <button
            ref={triggerRef}
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="admin-nav-drawer"
            onClick={() => setOpen(true)}
            className="grid size-9 place-items-center rounded-lg border border-border-soft bg-button-bg-soft text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 lg:hidden"
          >
            <Menu size={16} aria-hidden />
          </button>

          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className="hidden size-9 place-items-center rounded-lg border border-border-soft bg-button-bg-soft text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 lg:grid"
          >
            {collapsed ? (
              <PanelLeftOpen size={16} aria-hidden />
            ) : (
              <PanelLeftClose size={16} aria-hidden />
            )}
          </button>

          <span className="hidden items-center gap-1.5 text-xs text-text-muted sm:inline-flex">
            <ShieldCheck size={13} className="text-violet-300" aria-hidden />
            Internal — admin only
          </span>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-[200px] truncate text-xs text-text-muted sm:inline">
              {user?.email}
            </span>
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-soft bg-button-bg-soft px-3 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
            >
              <LogOut size={13} aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        {/* Width-capped so cards and tables stay readable on ultrawide displays. */}
        <main id="admin-main" className="mx-auto w-full max-w-[1500px] px-3 py-5 sm:px-4 lg:px-6 lg:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
