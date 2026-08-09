/**
 * Render + frame instrumentation for the editor.
 *
 * WHY THIS EXISTS, AND WHY IT ISN'T DEV-ONLY
 * ------------------------------------------
 * The question this answers is "does a scroll / wheel / pointermove / resize /
 * slider / playback tick re-render the timeline, the inspector or the preview,
 * and how many times per frame?" — and that question has to be answerable in
 * the PACKAGED PRODUCTION build, not just in `next dev`. A development build is
 * ~5-10x slower at the same amount of React work, so "it's fine in production"
 * proves nothing about whether the work is happening; it only proves the
 * machine can currently absorb it. Both builds have to be measured with the
 * same instrument.
 *
 * React's own `<Profiler>` cannot be that instrument on its own: its `onRender`
 * callback is compiled out of the production react-dom build (it only fires in
 * a development or an explicitly-built profiling bundle). So the primary
 * instrument here is a plain counter incremented by `useRenderCount()` inside
 * the components we care about — that is just our code, so it reports the same
 * numbers in every build. `<RenderProbe>` additionally wires up a real
 * `<Profiler>` for the builds where React will talk, giving actual render
 * durations on top of the counts.
 *
 * COST WHEN OFF
 * -------------
 * `PERF_ON` is resolved once, at module load, from an explicit opt-in
 * (`?perf=1`, or `localStorage["framevo.perf"] = "1"`). When it is false every
 * entry point below returns on a single boolean test and `<RenderProbe>` renders
 * its children with no wrapper at all, so nothing here is on a normal user's
 * hot path.
 */

/** Resolved ONCE so the component tree shape can never change mid-session. */
function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("perf")) return true;
    return window.localStorage?.getItem("framevo.perf") === "1";
  } catch {
    // Private-mode / blocked storage — treat as off rather than throwing during
    // module init, which would take the whole editor down.
    return false;
  }
}

export const PERF_ON: boolean = readFlag();

export interface FrameStats {
  /** Sampled frames (rAF callbacks) during the window. */
  frames: number;
  /** Wall-clock length of the sampling window. */
  durationMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Frames that missed a 60Hz budget by >50% (>25ms). */
  jankFrames: number;
  /** Frames that took longer than 50ms — a visible stall. */
  longFrames: number;
}

export interface PerfReport {
  label: string;
  durationMs: number;
  /** Renders per component id, from `useRenderCount`. */
  renders: Record<string, number>;
  /** Total renders across every instrumented component. */
  totalRenders: number;
  /** React `<Profiler>` commits — empty in a production react-dom build. */
  commits: Record<string, { commits: number; totalMs: number; maxMs: number }>;
  frames: FrameStats;
  /** `PerformanceObserver('longtask')` entries seen during the window. */
  longTasks: { count: number; totalMs: number; maxMs: number };
  /** Events the driver counted while it was interacting (see `countEvent`). */
  events: Record<string, number>;
}

const renders = new Map<string, number>();
const commits = new Map<string, { commits: number; totalMs: number; maxMs: number }>();
const events = new Map<string, number>();

let frameDeltas: number[] = [];
let sampling = false;
let rafId = 0;
let lastFrameAt = 0;
let windowStartedAt = 0;
let label = "";
let longTaskObserver: PerformanceObserver | null = null;
let longTaskCount = 0;
let longTaskTotal = 0;
let longTaskMax = 0;

/**
 * Count one render of `id`.
 *
 * Called DURING render on purpose — that is the only place that sees a render
 * which produces no commit (a bailout still runs the component function, and a
 * component re-rendering for nothing is exactly what we are hunting). React
 * DevTools' own render counter works the same way. There is no StrictMode in
 * this app, so a render is counted once per render.
 */
export function useRenderCount(id: string): void {
  if (!PERF_ON) return;
  renders.set(id, (renders.get(id) ?? 0) + 1);
}

/** Non-hook form, for code paths that aren't components. */
export function countEvent(name: string, n = 1): void {
  if (!PERF_ON) return;
  events.set(name, (events.get(name) ?? 0) + n);
}

/** `onRender` for `<Profiler>` — only ever called by a build where React talks. */
export function recordCommit(id: string, _phase: string, actualDuration: number): void {
  if (!PERF_ON) return;
  const prev = commits.get(id) ?? { commits: 0, totalMs: 0, maxMs: 0 };
  prev.commits += 1;
  prev.totalMs += actualDuration;
  prev.maxMs = Math.max(prev.maxMs, actualDuration);
  commits.set(id, prev);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

function summarizeFrames(durationMs: number): FrameStats {
  const sorted = [...frameDeltas].sort((a, b) => a - b);
  const sum = frameDeltas.reduce((a, b) => a + b, 0);
  return {
    frames: frameDeltas.length,
    durationMs: Math.round(durationMs),
    meanMs: frameDeltas.length ? +(sum / frameDeltas.length).toFixed(2) : 0,
    p50Ms: +percentile(sorted, 50).toFixed(2),
    p95Ms: +percentile(sorted, 95).toFixed(2),
    maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    jankFrames: frameDeltas.filter((d) => d > 25).length,
    longFrames: frameDeltas.filter((d) => d > 50).length,
  };
}

function reset(): void {
  renders.clear();
  commits.clear();
  events.clear();
  frameDeltas = [];
  longTaskCount = 0;
  longTaskTotal = 0;
  longTaskMax = 0;
}

function start(nextLabel = "unlabelled"): void {
  reset();
  label = nextLabel;
  windowStartedAt = performance.now();
  lastFrameAt = windowStartedAt;
  sampling = true;
  const tick = (now: number) => {
    if (!sampling) return;
    // The FIRST delta is measured from `start()`, which may sit anywhere inside
    // the current frame — so it is discarded rather than reported as a stall.
    if (frameDeltas.length > 0 || now - lastFrameAt < 100) {
      frameDeltas.push(now - lastFrameAt);
    }
    lastFrameAt = now;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  try {
    longTaskObserver?.disconnect();
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotal += entry.duration;
        longTaskMax = Math.max(longTaskMax, entry.duration);
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // Not every embedder exposes longtask; the frame sampler still stands alone.
    longTaskObserver = null;
  }
}

function stop(): PerfReport {
  sampling = false;
  cancelAnimationFrame(rafId);
  const durationMs = performance.now() - windowStartedAt;
  try {
    longTaskObserver?.disconnect();
  } catch {
    /* already gone */
  }
  longTaskObserver = null;

  const renderObj: Record<string, number> = {};
  let totalRenders = 0;
  for (const [k, v] of [...renders.entries()].sort((a, b) => b[1] - a[1])) {
    renderObj[k] = v;
    totalRenders += v;
  }
  const commitObj: Record<string, { commits: number; totalMs: number; maxMs: number }> = {};
  for (const [k, v] of commits) {
    commitObj[k] = {
      commits: v.commits,
      totalMs: +v.totalMs.toFixed(2),
      maxMs: +v.maxMs.toFixed(2),
    };
  }
  return {
    label,
    durationMs: Math.round(durationMs),
    renders: renderObj,
    totalRenders,
    commits: commitObj,
    frames: summarizeFrames(durationMs),
    longTasks: {
      count: longTaskCount,
      totalMs: +longTaskTotal.toFixed(2),
      maxMs: +longTaskMax.toFixed(2),
    },
    events: Object.fromEntries(events),
  };
}

export interface PerfApi {
  enabled: boolean;
  start(label?: string): void;
  stop(): PerfReport;
  reset(): void;
  counts(): Record<string, number>;
}

declare global {
  interface Window {
    __framevoPerf?: PerfApi;
  }
}

if (PERF_ON && typeof window !== "undefined") {
  window.__framevoPerf = {
    enabled: true,
    start,
    stop,
    reset,
    counts: () => Object.fromEntries(renders),
  };
}
