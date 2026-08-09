"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform } from "@/lib/platform";
import { apiFetch } from "@/lib/platform/api";
import type { BillingActionTarget } from "@/lib/billing/subscription-view";

/**
 * Turn a portal-lookup failure into something a customer can act on.
 *
 * Raw server strings on a billing screen are the worst kind of error: the
 * user can't tell whether their money is at risk. Each status gets copy that
 * says what happened and what to do next.
 */
function friendlyError(status: number, serverMessage?: string): string {
  if (status === 401) return "Your session expired — sign in again to manage billing.";
  if (status === 404) {
    return "We couldn't find a billing record for this account. If you just upgraded, give it a minute.";
  }
  if (status === 409) return "Your billing portal is still being set up — try again in a moment.";
  if (status >= 500) return "Lemon Squeezy didn't respond. Try again in a moment.";
  return serverMessage || "Couldn't open billing. Try again in a moment.";
}

export interface BillingPortalState {
  /** Open a hosted Lemon Squeezy page. Resolves once the tab has been opened. */
  open: (target: BillingActionTarget) => Promise<void>;
  /** Which target is currently loading (null when idle) — drives per-row spinners. */
  pending: BillingActionTarget | null;
  error: string | null;
  clearError: () => void;
}

/**
 * Opens Lemon Squeezy's hosted billing pages.
 *
 * One hook for every billing control on the page so that:
 *   • only one request can be in flight at a time (a double-click can't open
 *     two tabs, and rows can't fight over the loading state);
 *   • the error surfaces once, in one place, in plain language.
 *
 * The URL always opens OUTSIDE the app window — on the web that's a new tab,
 * in Electron the system browser. A payment page the user can't verify the
 * origin of is a phishing lesson we refuse to teach.
 */
export function useBillingPortal(): BillingPortalState {
  const { getIdToken } = useAuth();
  const platform = usePlatform();
  const [pending, setPending] = React.useState<BillingActionTarget | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Guards against a second click landing while the first request is in
  // flight — `pending` is state, so it lags inside the same tick.
  const inFlight = React.useRef(false);

  const open = React.useCallback(
    async (target: BillingActionTarget) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setError(null);
      setPending(target);
      try {
        const token = await getIdToken();
        if (!token) throw new Error("Not signed in");
        const res = await apiFetch("/api/billing/portal", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ target }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          url?: string;
          error?: string;
        };
        if (!res.ok || !json.url) {
          setError(friendlyError(res.status, json.error));
          return;
        }
        platform.openExternal(json.url);
      } catch (err) {
        console.error("[billing/portal]", err);
        setError("Couldn't reach billing. Check your connection and try again.");
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [getIdToken, platform]
  );

  const clearError = React.useCallback(() => setError(null), []);

  return { open, pending, error, clearError };
}
