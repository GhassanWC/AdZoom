"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { cn } from "@/lib/cn";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";

interface Props {
  plan: "creator" | "pro";
  label: string;
  variant?: "primary" | "ghost";
  className?: string;
  /** Where to send the user if they're not signed in yet. Defaults to /login. */
  signInRedirect?: string;
}

/**
 * Client-only button that:
 *   1. If the user isn't signed in, sends them to `signInRedirect` with
 *      `?next=<current path>&plan=<plan>` so the post-sign-in flow can
 *      finish the checkout.
 *   2. Otherwise POSTs to `/api/billing/checkout` with a Firebase ID
 *      token, then redirects the browser to the returned Lemon Squeezy
 *      hosted checkout URL.
 *
 * Errors surface inline. Loading state is locked-in so a double-click can't
 * fire two checkouts.
 */
export function CheckoutButton({
  plan,
  label,
  variant = "primary",
  className,
  signInRedirect = "/login",
}: Props) {
  const { user, getIdToken } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    logFramevoEvent(EVENTS.UPGRADE_CLICKED, { plan, signedIn: Boolean(user) });
    if (!user) {
      const next = typeof window !== "undefined" ? window.location.pathname : "/pricing";
      router.push(
        `${signInRedirect}?next=${encodeURIComponent(next)}&plan=${plan}`
      );
      return;
    }
    setLoading(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });
      const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !json.url) {
        throw new Error(json.error || `Checkout failed (${res.status})`);
      }
      window.location.href = json.url;
    } catch (err) {
      console.error("[checkout]", err);
      setError(err instanceof Error ? err.message : "Checkout failed");
      setLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Button
        variant={variant}
        size="md"
        onClick={onClick}
        disabled={loading}
        leftIcon={loading ? <Loader2 size={14} className="animate-spin" /> : undefined}
      >
        {loading ? "Redirecting…" : label}
      </Button>
      {error && (
        <p className="text-[11px] text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
