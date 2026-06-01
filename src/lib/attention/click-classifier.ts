/**
 * Click-tier classifier — turns a single click event + the
 * surrounding cursor / CV signals into a categorical tier that
 * downstream code (`momentsFromEvents`) maps to an effectType + focus
 * box size + intensity.
 *
 * Two paths:
 *   1. **Deterministic** — when the recording carries
 *      `click.targetRect` (in-tab capture only), classify primarily
 *      by element size + position. Most reliable.
 *   2. **Heuristic** — when targetRect is missing (external capture
 *      OR older recording), fall back to cursor hesitation + CV UI
 *      region overlap. Less reliable but reasonable.
 *
 * Pure function. No React, no Firestore, no DOM. Safe to unit-test.
 *
 * The `signals` array on the result captures every clue that
 * contributed to the tier decision so the inspector can show the
 * audit trail (we surface it via the moment's `sourceSignals` field).
 */

import type { CursorIntentSeries } from "./cursor-intent";
import { bucketAt } from "./cursor-intent";
import type { UIRegion, VisualAnalysis } from "../firebase/schema";

export type ClickTier =
  | "primary-cta"
  | "icon"
  | "nav"
  | "form"
  | "background";

export interface ClickClassification {
  tier: ClickTier;
  /** 0..1 confidence in the tier label. */
  confidence: number;
  /** Audit tags. Surface via `sourceSignals` on the resulting moment. */
  signals: string[];
}

interface ClickInput {
  x: number;
  y: number;
  t: number;
  targetRect?: { x: number; y: number; width: number; height: number };
}

interface Inputs {
  click: ClickInput;
  cursorIntent?: CursorIntentSeries;
  visualAnalysis?: VisualAnalysis;
  /**
   * "tab" = in-tab capture, targetRect is meaningful. "external" =
   * window/monitor capture, targetRect (if any) is Framevo's own DOM
   * and MUST be ignored. Callers pass this so the classifier can
   * pick the right path.
   */
  scope?: "tab" | "external";
}

// ── Tunables ─────────────────────────────────────────────────────────

/** Element area fractions of the viewport. */
const AREA_BIG = 0.04; // 4% of viewport = small button (40×30 at 1000×750)
const AREA_TINY = 0.005; // 0.5% of viewport = likely accidental
const AREA_FORM_MAX = 0.2; // bigger than this is probably a card not a form

/** Edge regions for nav classification. */
const NAV_TOP_Y = 0.12;
const NAV_LEFT_X = 0.18;
const NAV_RIGHT_X = 0.82;

/** Hesitation threshold for "deliberate approach". */
const HESITATION_DELIBERATE = 0.5;
const HESITATION_PRIMARY = 0.4;

/** Velocity (diagonal-normalised) above which a click is "slide-by". */
const FAST_SLIDE_VELOCITY = 0.6;

/** CV region overlap threshold — ≥ this fraction of the click is inside. */
const REGION_OVERLAP_MIN = 0.5;

// ── Public entry point ───────────────────────────────────────────────

export function classifyClick(inputs: Inputs): ClickClassification {
  const signals: string[] = [];
  signals.push(`click@${inputs.click.t.toFixed(2)}`);

  // Resolve cursor + CV context once.
  const hesitation = sampleHesitation(inputs.cursorIntent, inputs.click.t);
  const velocity = sampleVelocity(inputs.cursorIntent, inputs.click.t);
  if (hesitation !== undefined) {
    signals.push(`cursor-hesitation=${hesitation.toFixed(2)}`);
  }
  if (velocity !== undefined) {
    signals.push(`cursor-velocity=${velocity.toFixed(2)}`);
  }

  // Strip targetRect when scope is external — see ClickInput doc comment.
  const rect =
    inputs.scope === "external" ? undefined : inputs.click.targetRect;

  if (rect) {
    return classifyByRect(rect, inputs.click, hesitation, signals);
  }
  return classifyByHeuristic(
    inputs.click,
    inputs.visualAnalysis,
    hesitation,
    velocity,
    signals
  );
}

// ── Deterministic path: targetRect available ─────────────────────────

function classifyByRect(
  rect: NonNullable<ClickInput["targetRect"]>,
  click: ClickInput,
  hesitation: number | undefined,
  signals: string[]
): ClickClassification {
  const area = rect.width * rect.height;
  signals.push(`rect-area=${area.toFixed(3)}`);
  signals.push(`rect-pos=(${rect.x.toFixed(2)},${rect.y.toFixed(2)})`);

  // Position-based nav check first — a wide top toolbar can have
  // area > AREA_BIG but logically belongs in the nav tier.
  const isAtTop = rect.y < NAV_TOP_Y;
  const isAtLeftEdge = rect.x + rect.width / 2 < NAV_LEFT_X;
  const isAtRightEdge = rect.x + rect.width / 2 > NAV_RIGHT_X;

  if (area >= AREA_BIG && isAtTop) {
    signals.push("tier=nav");
    return tieredResult("nav", 0.9, hesitation, signals);
  }
  if (area >= AREA_BIG && (isAtLeftEdge || isAtRightEdge)) {
    signals.push("tier=nav");
    return tieredResult("nav", 0.9, hesitation, signals);
  }

  // Form-shape heuristic: long+thin element (inputs are wider than tall).
  const aspectRatio = rect.width / Math.max(0.001, rect.height);
  if (
    area >= AREA_TINY &&
    area <= AREA_FORM_MAX &&
    aspectRatio >= 3.5 &&
    rect.height < 0.06
  ) {
    signals.push("tier=form", `aspect=${aspectRatio.toFixed(1)}`);
    return tieredResult("form", 0.85, hesitation, signals);
  }

  if (area >= AREA_BIG) {
    const deliberate = (hesitation ?? 0) > HESITATION_PRIMARY;
    if (deliberate) {
      signals.push("tier=primary-cta", "deliberate");
      return tieredResult("primary-cta", 0.95, hesitation, signals);
    }
    signals.push("tier=primary-cta");
    return tieredResult("primary-cta", 0.85, hesitation, signals);
  }

  if (area >= AREA_TINY) {
    signals.push("tier=icon");
    return tieredResult("icon", 0.9, hesitation, signals);
  }

  signals.push("tier=background", "rect-tiny");
  return tieredResult("background", 0.7, hesitation, signals);
}

// ── Heuristic path: no targetRect, use cursor + CV ───────────────────

function classifyByHeuristic(
  click: ClickInput,
  visualAnalysis: VisualAnalysis | undefined,
  hesitation: number | undefined,
  velocity: number | undefined,
  signals: string[]
): ClickClassification {
  const region = findContainingRegion(visualAnalysis, click);
  if (region) {
    signals.push(
      `cv-region=${region.labelGuess}(${region.confidence.toFixed(2)})`
    );
    const deliberate = (hesitation ?? 0) > HESITATION_DELIBERATE;

    if (region.labelGuess === "input") {
      signals.push("tier=form");
      return tieredResult("form", 0.8, hesitation, signals);
    }
    if (region.labelGuess === "sidebar" || region.labelGuess === "toolbar") {
      signals.push("tier=nav");
      return tieredResult("nav", 0.8, hesitation, signals);
    }
    if (region.labelGuess === "button") {
      if (deliberate) {
        signals.push("tier=primary-cta", "deliberate");
        return tieredResult("primary-cta", 0.85, hesitation, signals);
      }
      signals.push("tier=icon");
      return tieredResult("icon", 0.75, hesitation, signals);
    }
    if (
      (region.labelGuess === "card" || region.labelGuess === "modal") &&
      deliberate
    ) {
      signals.push("tier=primary-cta");
      return tieredResult("primary-cta", 0.85, hesitation, signals);
    }
  }

  // No region match. Last-chance signals:
  if ((velocity ?? 0) > FAST_SLIDE_VELOCITY) {
    signals.push("tier=background", "fast-slide");
    return tieredResult("background", 0.65, hesitation, signals);
  }

  // Conservative default: assume it's an icon-sized button. Better
  // than `background` (which suppresses zoom entirely) for a click
  // we have no info on — the user did deliberately click *something*.
  signals.push("tier=icon", "no-signal-default");
  return tieredResult("icon", 0.6, hesitation, signals);
}

// ── Helpers ──────────────────────────────────────────────────────────

function tieredResult(
  tier: ClickTier,
  base: number,
  hesitation: number | undefined,
  signals: string[]
): ClickClassification {
  // Small confidence bump when cursor showed a clear deliberate
  // approach pattern. Caps at 1.0.
  const bumped =
    hesitation !== undefined && hesitation > HESITATION_DELIBERATE
      ? Math.min(1, base + 0.05)
      : base;
  return { tier, confidence: bumped, signals };
}

function sampleHesitation(
  series: CursorIntentSeries | undefined,
  t: number
): number | undefined {
  if (!series || series.sampleCount === 0) return undefined;
  const b = bucketAt(series, t);
  return series.samples[b]?.hesitationScore;
}

function sampleVelocity(
  series: CursorIntentSeries | undefined,
  t: number
): number | undefined {
  if (!series || series.sampleCount === 0) return undefined;
  const b = bucketAt(series, t);
  return series.samples[b]?.velocity;
}

/**
 * Find the smallest UI region whose temporal + spatial bounds contain
 * the click. "Smallest" rather than "first" so a tiny button inside a
 * larger card surfaces as the more specific label.
 */
function findContainingRegion(
  va: VisualAnalysis | undefined,
  click: ClickInput
): UIRegion | undefined {
  const regions = va?.uiRegions;
  if (!regions || regions.length === 0) return undefined;
  let best: UIRegion | undefined;
  let bestArea = Infinity;
  for (const r of regions) {
    if (click.t < r.t0 || click.t > r.t1) continue;
    const inside =
      click.x >= r.x &&
      click.x <= r.x + r.w &&
      click.y >= r.y &&
      click.y <= r.y + r.h;
    if (!inside) continue;
    const area = r.w * r.h;
    if (area < bestArea) {
      best = r;
      bestArea = area;
    }
  }
  // Reject the region if the click only marginally touches it.
  if (best && bestArea > 0) {
    const overlap = pointToRegionOverlap(click, best);
    if (overlap < REGION_OVERLAP_MIN) return undefined;
  }
  return best;
}

/**
 * Trivial 0..1 score for "is the click well inside this region?".
 * Distance from click to region centre, normalised to half-diagonal.
 * 1.0 = at the centre, 0.0 = at the corner.
 */
function pointToRegionOverlap(click: ClickInput, region: UIRegion): number {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const halfDiag = Math.hypot(region.w / 2, region.h / 2);
  if (halfDiag <= 0) return 0;
  const dist = Math.hypot(click.x - cx, click.y - cy);
  return Math.max(0, Math.min(1, 1 - dist / halfDiag));
}
