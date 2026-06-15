"use client";

/**
 * Fires a GA4 `page_view` on every App Router navigation.
 *
 * Uses ONLY `usePathname()` (not `useSearchParams()`) so it doesn't force the
 * whole tree into a Suspense/dynamic deopt. `page_location` still captures the
 * full URL (including query string) by reading `window.location` at fire time.
 *
 * GA4-only (`logFramevoEvent`) — page views are not written to the admin
 * Firestore collection (anon visitors can't write there, and we don't want
 * page views bloating it).
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    logFramevoEvent(EVENTS.PAGE_VIEW, {
      page_path: pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [pathname]);

  return <>{children}</>;
}
