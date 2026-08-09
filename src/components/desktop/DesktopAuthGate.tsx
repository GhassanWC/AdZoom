"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform } from "@/lib/platform";
import { Logo } from "@/components/landing/Logo";

/**
 * The desktop app's front door.
 *
 * Nothing behind it renders — not a shell, not a sidebar, not a flash of an
 * empty dashboard — until Firebase has finished restoring whatever session is
 * on disk. That ordering is the whole point: `useAuth().loading` starts TRUE, so
 * the first paint of a cold launch is the splash below, and the first paint
 * after that is either the workspace or the sign-in screen. There is no third
 * frame in which protected content exists.
 *
 * The redirect covers the other three cases the app has to survive:
 *   • a fresh install (no session)          → /login
 *   • a session that expired or was revoked → AuthProvider signs out, we land here
 *   • an explicit sign-out                  → same path, immediately
 *
 * `next` is preserved so a deep link into, say, a project survives the detour
 * through sign-in.
 */
export function DesktopAuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, configured } = useAuth();
  const platform = usePlatform();
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Tell the main process who is signed in.
   *
   * This is the authentication isolation boundary for the whole sync queue: the
   * durable outbox lives in SQLite and every operation is stamped with — and
   * later claimed by — this uid. Reported from HERE because this component is
   * already the one place that knows auth has settled; doing it anywhere else
   * risks stamping a write before `loading` resolves, which would attribute it
   * to nobody (or, worse, to the previous account on a fast re-sign-in).
   *
   * Sign-out sends null: draining stops, but nothing queued is discarded.
   */
  React.useEffect(() => {
    if (loading) return;
    const sync = platform.sync;
    if (!sync) return;
    void sync.setOwner(user?.uid ?? null).catch(() => {
      // Main will simply queue nothing until the next auth change re-reports.
      // Failing loudly here would block the app on a bookkeeping call.
    });
  }, [platform, user, loading]);

  React.useEffect(() => {
    if (loading || user) return;
    if (!configured) return; // the banner explains it; a redirect would loop
    const next = pathname && pathname !== "/login" ? pathname : "/dashboard";
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [user, loading, configured, router, pathname]);

  if (!configured) return <DesktopConfigNotice />;
  // Not signed in yet → hold the splash rather than paint a protected screen
  // for the frame it takes the replace() above to land.
  if (loading || !user) return <DesktopSplash label={loading ? "Restoring your session…" : "Taking you to sign-in…"} />;

  return <>{children}</>;
}

/** The full-window loading state. Deliberately the same ink as the shell. */
export function DesktopSplash({ label = "Loading Framevo…" }: { label?: string }) {
  return (
    <div className="grid h-dvh place-items-center bg-ink" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-5">
        <Logo />
        <div className="h-0.5 w-40 overflow-hidden rounded-full bg-white/[0.07]">
          <div className="fv-splash-bar h-full w-1/3 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" />
        </div>
        <p className="text-xs text-fog">{label}</p>
      </div>
      <style>{`
        @keyframes fv-splash { 0% { transform: translateX(-120%) } 100% { transform: translateX(320%) } }
        .fv-splash-bar { animation: fv-splash 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
        @media (prefers-reduced-motion: reduce) { .fv-splash-bar { animation: none; width: 100% } }
      `}</style>
    </div>
  );
}

function DesktopConfigNotice() {
  return (
    <div className="grid h-dvh place-items-center bg-ink px-6">
      <div className="glass max-w-lg space-y-3 rounded-2xl border-amber-400/30 bg-amber-500/[0.04] p-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-400" />
          Framevo can&apos;t reach your account
        </div>
        <p className="text-sm text-fog">
          This build was packaged without Firebase credentials, so it cannot sign you in. Rebuild
          the desktop app with the <code className="font-mono text-xs text-white/90">NEXT_PUBLIC_FIREBASE_*</code>{" "}
          variables set.
        </p>
      </div>
    </div>
  );
}
