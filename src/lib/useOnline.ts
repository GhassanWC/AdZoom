"use client";

import * as React from "react";

/**
 * Connectivity, read as external state.
 *
 * `navigator.onLine` is only a hint (it reports link state, not reachability),
 * which is exactly the right strength of signal for what it drives here: an
 * explanatory banner and clearer copy on buttons that need the network. Nothing
 * is BLOCKED on it — a request that fails still surfaces its own error, and a
 * false "online" simply means the user learns from the failure instead of the
 * banner.
 *
 * The server snapshot is `true` so prerendered HTML never contains an offline
 * banner that would flash away on hydration.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function useOnline(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true
  );
}
