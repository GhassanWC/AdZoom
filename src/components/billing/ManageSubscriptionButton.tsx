"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/firebase/AuthProvider";

interface Props {
  label?: string;
  variant?: "primary" | "ghost";
  className?: string;
}

/**
 * Opens the Lemon Squeezy customer portal in a new tab. Calls
 * `/api/billing/portal`, which looks up the stored `customerPortalUrl` for
 * the authenticated user. If they don't have one yet (e.g. webhook hasn't
 * arrived), surfaces a clear "try again shortly" message.
 */
export function ManageSubscriptionButton({
  label = "Manage subscription",
  variant = "ghost",
  className,
}: Props) {
  const { getIdToken } = useAuth();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    setLoading(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        throw new Error(json.error || `Portal lookup failed (${res.status})`);
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Portal lookup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={"flex flex-col gap-1.5 " + (className ?? "")}>
      <Button
        variant={variant}
        size="md"
        onClick={onClick}
        disabled={loading}
        leftIcon={loading ? <Loader2 size={14} className="animate-spin" /> : undefined}
      >
        {loading ? "Opening…" : label}
      </Button>
      {error && (
        <p className="text-[11px] text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
