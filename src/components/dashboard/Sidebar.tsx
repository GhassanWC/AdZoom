"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Folder,
  Upload,
  Wand2,
  Download,
  CreditCard,
  Settings,
  Sparkles,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/landing/Logo";
import { sidebarItems } from "@/lib/mockData";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { fmtBytes, storageBand } from "@/lib/usage/plan";

const icons: Record<string, LucideIcon> = {
  LayoutDashboard,
  Folder,
  Upload,
  Wand2,
  Download,
  CreditCard,
  Settings,
  Video,
};

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const storage = useStoragePlan();
  const band = storageBand(storage.usedBytes, storage.limitBytes);
  const barClass =
    band === "danger"
      ? "bg-gradient-to-r from-rose-500 to-rose-400"
      : band === "warn"
        ? "bg-gradient-to-r from-amber-400 to-amber-300"
        : "bg-gradient-to-r from-violet-500 to-cyan-400";
  const usagePct = Math.max(1, Math.round(storage.fraction * 100));

  const nav = (
    <nav className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Link href="/" aria-label="Framevo home">
          <Logo />
        </Link>
      </div>

      <ul className="flex-1 space-y-0.5 px-3 py-2">
        {sidebarItems.map((item) => {
          const Icon = icons[item.icon];
          const active =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onClose}
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
    </nav>
  );

  return (
    <>
      {/* Desktop */}
      <aside className="hidden border-r border-white/[0.06] bg-surface/40 backdrop-blur-xl lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-64 lg:flex-col">
        {nav}
      </aside>

      {/* Mobile drawer */}
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
              className="fixed inset-0 z-40 bg-ink/70 backdrop-blur-md lg:hidden"
            />
            <motion.aside
              key="drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/[0.06] bg-surface lg:hidden"
            >
              <button
                aria-label="Close menu"
                onClick={onClose}
                className="absolute right-3 top-4 inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white"
              >
                <X size={16} />
              </button>
              {nav}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
