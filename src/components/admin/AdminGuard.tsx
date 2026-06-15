"use client";

/**
 * Client-side gate for the /admin section. Mirrors the dashboard `AuthGuard`
 * but additionally requires the signed-in user to be an admin.
 *
 * This is the FIRST of three security layers and the weakest (it only controls
 * what renders in the browser). The real enforcement is `requireAdmin()` on
 * every `/api/admin/*` route — a non-admin who bypasses this guard still gets
 * 403 from every data endpoint, so they'd see an empty shell and nothing else.
 */

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { isAdminUser } from "@/lib/admin/isAdminUser";

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading, configured } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const admin = isAdminUser(user);

  React.useEffect(() => {
    if (loading || !configured) return;
    if (!user) {
      const next = encodeURIComponent(pathname || "/admin");
      router.replace(`/login?next=${next}`);
      return;
    }
    if (!admin) {
      // Don't reveal that /admin exists — bounce non-admins to the dashboard.
      router.replace("/dashboard");
    }
  }, [user, admin, loading, configured, router, pathname]);

  if (!configured) {
    return (
      <Centered>
        <p className="text-sm text-fog">
          Firebase is not configured. Set the <code className="text-white/80">NEXT_PUBLIC_FIREBASE_*</code>{" "}
          env vars to use the admin dashboard.
        </p>
      </Centered>
    );
  }

  if (loading || !user) {
    return (
      <Centered>
        <div className="flex items-center gap-2 text-sm text-fog">
          <span className="size-1.5 animate-pulse rounded-full bg-violet-400" />
          Verifying access…
        </div>
      </Centered>
    );
  }

  if (!admin) {
    return (
      <Centered>
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span className="inline-flex size-11 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/10 text-rose-300">
            <ShieldAlert size={18} />
          </span>
          <div className="text-base font-semibold text-white">Access denied</div>
          <p className="text-sm text-fog">
            This area is restricted to administrators. Redirecting you to your dashboard…
          </p>
        </div>
      </Centered>
    );
  }

  return <>{children}</>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[70vh] place-items-center px-6">{children}</div>;
}
