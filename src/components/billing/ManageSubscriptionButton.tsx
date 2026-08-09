"use client";

import * as React from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useBillingPortal } from "./useBillingPortal";
import type { BillingActionTarget } from "@/lib/billing/subscription-view";

interface Props {
  label?: string;
  variant?: "primary" | "ghost";
  className?: string;
  /**
   * Which hosted Lemon Squeezy page to open. Defaults to the full customer
   * portal; `"update"` goes straight to the card-on-file form and
   * `"change-plan"` to the plan switcher.
   */
  target?: BillingActionTarget;
  /** Hide the outbound arrow when the surrounding copy already says so. */
  hideExternalHint?: boolean;
}

/**
 * Opens a Lemon Squeezy hosted billing page in the system browser.
 *
 * The URL is resolved server-side at click time (`/api/billing/portal`)
 * because LS signs these links and expires them after ~24h — a URL cached
 * from the last webhook is usually dead by the time anyone clicks it.
 */
export function ManageSubscriptionButton({
  label = "Manage subscription",
  variant = "ghost",
  className,
  target = "portal",
  hideExternalHint = false,
}: Props) {
  const { open, pending, error } = useBillingPortal();
  const loading = pending === target;

  return (
    <div className={"flex flex-col gap-1.5 " + (className ?? "")}>
      <Button
        variant={variant}
        size="md"
        onClick={() => void open(target)}
        disabled={pending !== null}
        leftIcon={loading ? <Loader2 size={14} className="animate-spin" /> : undefined}
        rightIcon={
          !loading && !hideExternalHint ? (
            <ArrowUpRight size={14} className="opacity-70" />
          ) : undefined
        }
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
