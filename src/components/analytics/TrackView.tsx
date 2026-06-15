"use client";

/**
 * Fire-once GA4 beacon for "this view was seen" events (e.g. `pricing_viewed`).
 * Drop into a server page as a child: `<TrackView event={EVENTS.PRICING_VIEWED} />`.
 */

import * as React from "react";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import type { EventName } from "@/lib/analytics/events";

export function TrackView({
  event,
  params,
}: {
  event: EventName;
  params?: Record<string, unknown>;
}) {
  React.useEffect(() => {
    logFramevoEvent(event, params);
    // Fire once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
