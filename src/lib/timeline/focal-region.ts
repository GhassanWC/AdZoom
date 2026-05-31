/**
 * Directional focal-region derivation.
 *
 * The historical problem: every AI-generated zoom moment ended up with
 * `focusRegion = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }` (a
 * centered box), because the Gemini sanitizer used that as its fallback
 * whenever the model returned a missing/invalid region. The renderer
 * supports arbitrary x/y framing, so the failure was upstream — at the
 * point where the moment was created, no signal was consulted.
 *
 * This helper consolidates the "where should the camera point?" decision
 * across every code path that produces a moment, using the strongest
 * available signal:
 *
 *   1. Real click coordinates inside the moment window (highest trust).
 *   2. Cursor dwell — the cursor sat still inside the window long enough
 *      to count as a point of attention.
 *   3. CV motion centroid — the on-device motion analyser identified a
 *      stable hotspot in the window.
 *   4. Form / typing context — keep the region small so it doesn't engulf
 *      the entire form panel.
 *   5. The caller's fallback — never a hard-coded center.
 *
 * Pure function. No DOM, no Firestore. Safe to unit-test.
 */

import type {
  DetectedMoment,
  FocusRegion,
  TargetRegionSource,
  VisualAnalysis,
} from "../firebase/schema";
import type { Interaction } from "../recording/types";
import { sampleCvForMoment, nearestClickEvent } from "../cv/fusion";

export interface DerivedFocalRegion {
  region: FocusRegion;
  /** Which TargetRegionSource branch produced this region. */
  source: TargetRegionSource;
  /** Short tags describing the signals that contributed (audit-friendly). */
  signals: string[];
}

/**
 * Sentinel signal tag added to `sourceSignals` by callers (e.g. the Gemini
 * sanitizer) when they couldn't produce a real focusRegion and the balancer
 * should derive one from interactions / CV. The balancer scans for this tag
 * to decide which moments to refine.
 */
export const NEEDS_DERIVATION_SIGNAL = "needs-derivation";

/** Min focus box size — keeps small click targets visible after framing. */
const DEFAULT_HALF = 0.175; // 35% box
const FORM_HALF_W = 0.175;
const FORM_HALF_H = 0.125;
/** A click coord inside this margin of an edge snaps fully to that edge. */
const EDGE_SAFE_MARGIN = 0.05;
/**
 * If the derived centre is within this distance of the existing one, don't
 * bother replacing — avoids jitter and noisy "improvements".
 */
const MIN_DELTA = 0.05;

/**
 * Cursor-dwell detection: a stationary cluster of mousemove samples whose
 * normalised viewport position barely changes over a window of this length.
 */
const DWELL_MIN_MS = 400;
/** Diagonal velocity (units/s in viewport-normalised space) under which
 *  we consider the cursor "parked". The mousemove event in
 *  src/lib/recording/types.ts stores `velocity` in px/s, but the units
 *  there are pixel-space. We treat <120 px/s as parked — empirically a
 *  hover with no intent. */
const DWELL_MAX_VELOCITY = 120;

interface Window {
  startTime: number;
  endTime: number;
}

export function deriveFocalRegion(
  moment: DetectedMoment,
  interactions: Interaction[] | undefined,
  cv: VisualAnalysis | null | undefined,
  fallback: FocusRegion
): DerivedFocalRegion {
  const win: Window = { startTime: moment.startTime, endTime: moment.endTime };

  // 1. Click in [startTime - 0.3, endTime] → click coords win. ±0.3s lets a
  //    pre-click anticipation moment land on the same target as the click.
  const click = findClick(interactions, win.startTime - 0.3, win.endTime);
  if (click) {
    return regionFromCenter(click.x, click.y, DEFAULT_HALF, DEFAULT_HALF, {
      source: "click-event",
      signals: [`click@${click.t.toFixed(2)},(${click.x.toFixed(2)},${click.y.toFixed(2)})`],
    });
  }

  // 2. Cursor dwell — longest stationary cluster inside the window.
  const dwell = findCursorDwell(interactions, win);
  if (dwell) {
    return regionFromCenter(dwell.x, dwell.y, DEFAULT_HALF, DEFAULT_HALF, {
      source: "motion-centroid",
      signals: [
        `cursor-dwell@${dwell.startT.toFixed(2)}-${dwell.endT.toFixed(2)},(${dwell.x.toFixed(2)},${dwell.y.toFixed(2)})`,
      ],
    });
  }

  // 3. CV motion centroid — only trust when the window's centroid was stable.
  if (cv && cv.sampleCount > 0) {
    const sample = sampleCvForMoment(cv, win.startTime, win.endTime);
    if (sample.centroid && sample.centroid.variance < 0.05) {
      return regionFromCenter(
        sample.centroid.x,
        sample.centroid.y,
        DEFAULT_HALF,
        DEFAULT_HALF,
        {
          source: "motion-centroid",
          signals: [
            `cv-centroid@(${sample.centroid.x.toFixed(2)},${sample.centroid.y.toFixed(2)})var${sample.centroid.variance.toFixed(3)}`,
          ],
        }
      );
    }
  }

  // 4. Typing / form context — keep the AI box but shrink it so the camera
  //    frames the input field rather than the whole form panel.
  if (moment.uiContext === "form") {
    const cx = fallback.x + fallback.width / 2;
    const cy = fallback.y + fallback.height / 2;
    return regionFromCenter(cx, cy, FORM_HALF_W, FORM_HALF_H, {
      source: "ui-region",
      signals: ["ui-context=form"],
    });
  }

  // 5. Fallback — return the caller's region untouched, tagged "default" so
  //    the rest of the pipeline knows it's low-confidence.
  return {
    region: clampRegion(fallback),
    source: "default",
    signals: ["no-signal-fallback"],
  };
}

/**
 * Apply `deriveFocalRegion` to a moment, but only if the result is materially
 * different from the current region (no jittery half-pixel moves) AND the
 * moment isn't user-positioned (we never overwrite user intent).
 *
 * Returns the patched moment, or the original if no change is warranted.
 */
export function refineMomentFocalRegion(
  moment: DetectedMoment,
  interactions: Interaction[] | undefined,
  cv: VisualAnalysis | null | undefined
): DetectedMoment {
  // Hard guard: user-positioned focus regions are sacred. Both the explicit
  // user provenance and the user-stamped targetRegionSource opt out.
  if (moment.source === "user" || moment.targetRegionSource === "user") {
    return moment;
  }

  const derived = deriveFocalRegion(
    moment,
    interactions,
    cv ?? null,
    moment.focusRegion
  );

  // Defensive shrink — if the incoming region is huge (Gemini omitted
  // focusRegion entirely OR the model returned something close to
  // "full frame" like a 70% box) AND no real signal pulled it tighter,
  // shrink to a 35% box centred where we were pointed. Stops the
  // "AI applies a zoom that covers the whole video" complaint even
  // in the worst-case no-signal path. Uses the SAME 35% default as
  // the Gemini sanitiser so the two stay in sync.
  const incomingW = moment.focusRegion.width;
  const incomingH = moment.focusRegion.height;
  if (derived.source === "default" && (incomingW > 0.55 || incomingH > 0.55)) {
    const cx = moment.focusRegion.x + incomingW / 2;
    const cy = moment.focusRegion.y + incomingH / 2;
    const half = 0.175; // 35% box
    return {
      ...moment,
      focusRegion: {
        x: clamp(cx - half, 0, 1 - half * 2),
        y: clamp(cy - half, 0, 1 - half * 2),
        width: half * 2,
        height: half * 2,
      },
      targetRegionSource: moment.targetRegionSource ?? "default",
      sourceSignals: dedupeSignals([
        ...(moment.sourceSignals ?? []),
        `defensive-shrink:${incomingW.toFixed(2)}x${incomingH.toFixed(2)}→0.35x0.35`,
      ]),
    };
  }

  // The "default" branch returned an unchanged region — no signal contributed.
  if (derived.source === "default") return moment;

  // Don't replace if the new centre is essentially where we already pointed.
  const oldCx = moment.focusRegion.x + moment.focusRegion.width / 2;
  const oldCy = moment.focusRegion.y + moment.focusRegion.height / 2;
  const newCx = derived.region.x + derived.region.width / 2;
  const newCy = derived.region.y + derived.region.height / 2;
  if (Math.hypot(newCx - oldCx, newCy - oldCy) < MIN_DELTA) {
    return moment;
  }

  return {
    ...moment,
    focusRegion: derived.region,
    targetRegionSource: derived.source,
    sourceSignals: dedupeSignals([
      ...(moment.sourceSignals ?? []).filter(
        (s) => s !== NEEDS_DERIVATION_SIGNAL
      ),
      ...derived.signals,
    ]),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function regionFromCenter(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  meta: { source: TargetRegionSource; signals: string[] }
): DerivedFocalRegion {
  let x = cx - halfW;
  let y = cy - halfH;
  const w = halfW * 2;
  const h = halfH * 2;
  // Snap to edges when the user's target is very close to one — avoids the
  // camera landing one safe-margin away from a corner click.
  if (cx < EDGE_SAFE_MARGIN + halfW) x = 0;
  else if (cx > 1 - EDGE_SAFE_MARGIN - halfW) x = 1 - w;
  if (cy < EDGE_SAFE_MARGIN + halfH) y = 0;
  else if (cy > 1 - EDGE_SAFE_MARGIN - halfH) y = 1 - h;
  return {
    region: clampRegion({ x, y, width: w, height: h }),
    source: meta.source,
    signals: meta.signals,
  };
}

function clampRegion(r: FocusRegion): FocusRegion {
  const w = clamp(r.width, 0.05, 1);
  const h = clamp(r.height, 0.05, 1);
  return {
    x: clamp(r.x, 0, Math.max(0, 1 - w)),
    y: clamp(r.y, 0, Math.max(0, 1 - h)),
    width: w,
    height: h,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

interface ClickHit {
  t: number;
  x: number;
  y: number;
}

function findClick(
  interactions: Interaction[] | undefined,
  startTime: number,
  endTime: number
): ClickHit | null {
  if (!interactions || interactions.length === 0) return null;
  // Prefer left-clicks; double-clicks count too. Pick the one closest to the
  // moment's start — that's the click the AI/CV most likely triggered on.
  let best: ClickHit | null = null;
  let bestDist = Infinity;
  for (const ev of interactions) {
    if (ev.type !== "click" && ev.type !== "dblclick") continue;
    if (ev.t < startTime || ev.t > endTime) continue;
    const dist = Math.abs(ev.t - Math.max(startTime, (startTime + endTime) / 2));
    if (dist < bestDist) {
      bestDist = dist;
      best = { t: ev.t, x: ev.x, y: ev.y };
    }
  }
  return best;
}

interface DwellHit {
  x: number;
  y: number;
  startT: number;
  endT: number;
}

/**
 * Find the longest stationary mousemove cluster inside the moment window.
 * "Stationary" = the recorded `velocity` (px/s) stays below
 * `DWELL_MAX_VELOCITY` for ≥ `DWELL_MIN_MS`. Returns the centroid of the
 * cluster, or null if no qualifying cluster exists.
 */
function findCursorDwell(
  interactions: Interaction[] | undefined,
  win: Window
): DwellHit | null {
  if (!interactions || interactions.length === 0) return null;
  const moves = interactions.filter(
    (e): e is Extract<Interaction, { type: "mousemove" }> =>
      e.type === "mousemove" && e.t >= win.startTime && e.t <= win.endTime
  );
  if (moves.length < 4) return null;
  moves.sort((a, b) => a.t - b.t);

  let bestDwell: DwellHit | null = null;
  let bestSpan = 0;
  let runStart = -1;
  let runSumX = 0;
  let runSumY = 0;
  let runCount = 0;

  const closeRun = (endT: number) => {
    if (runStart < 0 || runCount === 0) return;
    const spanMs = (endT - runStart) * 1000;
    if (spanMs >= DWELL_MIN_MS && spanMs > bestSpan) {
      bestDwell = {
        x: runSumX / runCount,
        y: runSumY / runCount,
        startT: runStart,
        endT,
      };
      bestSpan = spanMs;
    }
    runStart = -1;
    runSumX = 0;
    runSumY = 0;
    runCount = 0;
  };

  for (const m of moves) {
    const parked = m.velocity <= DWELL_MAX_VELOCITY;
    if (parked) {
      if (runStart < 0) runStart = m.t;
      runSumX += m.x;
      runSumY += m.y;
      runCount += 1;
    } else {
      closeRun(m.t);
    }
  }
  closeRun(moves[moves.length - 1].t);

  return bestDwell;
}

function dedupeSignals(signals: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of signals) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
