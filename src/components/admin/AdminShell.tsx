"use client";

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

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [open, setOpen] = React.useState(false);

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 text-white">
          <ShieldCheck size={15} />
        </span>
        <span className="font-display text-sm font-semibold tracking-tight text-white">
          Framevo
          <span className="ml-1 text-fog">Admin</span>
        </span>
      </div>

      <ul className="flex-1 space-y-0.5 px-3 py-2">
        {ADMIN_NAV.map((item) => {
          const Icon = icons[item.icon];
          const active =
            pathname === item.href ||
            (item.href !== "/admin" && pathname.startsWith(item.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
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

      <div className="m-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-xs text-fog transition-colors hover:text-white"
        >
          <ArrowLeft size={13} />
          Back to app
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-ink">
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-white/[0.06] bg-surface/40 backdrop-blur-xl lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-64 lg:flex-col">
        {nav}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-md lg:hidden"
            onClick={() => setOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/[0.06] bg-surface lg:hidden">
            <button
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-4 inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white"
            >
              <X size={16} />
            </button>
            {nav}
          </aside>
        </>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.06] bg-ink/70 px-4 backdrop-blur-xl lg:px-8">
          <button
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-white lg:hidden"
          >
            <Menu size={16} />
          </button>
          <div className="flex items-center gap-2 text-xs text-fog">
            <ShieldCheck size={14} className="text-violet-300" />
            <span className="hidden sm:inline">Admin dashboard — internal</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden max-w-[180px] truncate text-xs text-fog sm:inline">
              {user?.email}
            </span>
            <button
              onClick={() => signOut()}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-white/85 transition-colors hover:border-white/20 hover:text-white"
            >
              <LogOut size={13} />
              Sign out
            </button>
          </div>
        </header>
        <main className="px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
