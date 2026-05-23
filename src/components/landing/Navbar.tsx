"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X, LayoutDashboard } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { navLinks } from "@/lib/mockData";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/firebase/AuthProvider";

export function Navbar() {
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const { user, loading } = useAuth();

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const signedIn = !loading && !!user;
  const firstName = user?.displayName?.split(" ")[0] ?? "Dashboard";
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
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-white/[0.06] bg-ink/70 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-8">
        <Link href="/" aria-label="AdZoom home" className="relative z-10">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-fog transition-colors duration-200 hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {signedIn ? (
            <Link
              href="/dashboard"
              className="group inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] py-1 pl-1 pr-4 text-sm font-medium text-white/90 transition-colors duration-200 hover:border-white/25 hover:bg-white/[0.04] hover:text-white"
            >
              {user?.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.photoURL}
                  alt=""
                  className="size-7 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span
                  aria-hidden
                  className="inline-flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 text-[11px] font-semibold text-white"
                >
                  {initials}
                </span>
              )}
              <LayoutDashboard size={13} className="opacity-80 group-hover:opacity-100" />
              <span className="hidden lg:inline">{firstName}</span>
            </Link>
          ) : (
            <Button href="/dashboard" variant="ghost" size="sm">
              Sign in
            </Button>
          )}
        </div>

        <button
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="relative z-10 inline-flex size-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-white md:hidden"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="border-t border-white/[0.06] bg-ink/95 backdrop-blur-xl md:hidden"
          >
            <div className="space-y-1 px-6 py-4">
              {navLinks.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm text-fog hover:bg-white/[0.04] hover:text-white"
                >
                  {l.label}
                </Link>
              ))}
              <div className="flex gap-3 pt-3">
                {signedIn ? (
                  <Button
                    href="/dashboard"
                    variant="primary"
                    size="sm"
                    className="flex-1"
                    leftIcon={<LayoutDashboard size={14} />}
                  >
                    {firstName === "Dashboard" ? "Dashboard" : `Continue as ${firstName}`}
                  </Button>
                ) : (
                  <Button href="/dashboard" variant="ghost" size="sm" className="flex-1">
                    Sign in
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
