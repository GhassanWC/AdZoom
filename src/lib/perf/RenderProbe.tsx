"use client";

import * as React from "react";
import { PERF_ON, recordCommit } from "./render-probe";

/**
 * Wraps a subtree in a React `<Profiler>` when instrumentation is on, and in
 * NOTHING at all when it is off — no extra element, no extra hook, no cost.
 *
 * `<Profiler>` gives real per-commit durations, but only in a build where React
 * kept its profiling code (development, or a bundle built with the profiling
 * react-dom). In the packaged production app the callback simply never fires;
 * the per-component counters from `useRenderCount` are what carry the
 * measurement there. Both are read back through `window.__framevoPerf`.
 */
export function RenderProbe({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  if (!PERF_ON) return <>{children}</>;
  return (
    <React.Profiler
      id={id}
      onRender={(profilerId, phase, actualDuration) =>
        recordCommit(profilerId, phase, actualDuration)
      }
    >
      {children}
    </React.Profiler>
  );
}
