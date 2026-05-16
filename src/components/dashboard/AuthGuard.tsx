"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/firebase/AuthProvider";

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { user, loading, configured } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (loading) return;
    if (!configured) return; // surface a banner instead of redirect-looping
    if (!user) {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/login?next=${next}`);
    }
  }, [user, loading, configured, router, pathname]);

  if (!configured) {
    return <ConfigBanner />;
  }

  if (loading || !user) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="flex items-center gap-2 text-sm text-fog">
          <span className="size-1.5 animate-pulse rounded-full bg-violet-400" />
          Loading workspace…
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function ConfigBanner() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="glass space-y-3 rounded-2xl border-amber-400/30 bg-amber-500/[0.04] p-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-400" />
          Firebase not configured
        </div>
        <p className="text-sm text-fog">
          Add your Firebase project credentials to{" "}
          <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-white/90">
            .env.local
          </code>{" "}
          to enable login, uploads, and the AI editor. See{" "}
          <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-white/90">
            .env.local.example
          </code>{" "}
          for the required keys.
        </p>
        <p className="text-xs text-fog">
          The landing page works without Firebase. The dashboard needs it.
        </p>
      </div>
    </div>
  );
}
