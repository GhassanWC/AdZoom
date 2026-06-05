"use client";

import * as React from "react";

/**
 * Dev gate shared by the internal debug surfaces. True when the URL carries
 * `?debug=1` or the user presses Ctrl/Cmd+Shift+D (same toggle as DebugOverlay).
 * Internal-only — never used to gate customer-facing UI.
 */
export function useDebugParam(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const url =
      typeof window !== "undefined" ? new URL(window.location.href) : null;
    if (url?.searchParams.get("debug") === "1") setOn(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOn((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return on;
}
