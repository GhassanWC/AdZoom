/**
 * Event-derived moment proposer — turns real `Interaction` events into
 * timeline moment candidates with `provenance: "event"`.
 *
 * Strictly deterministic: same `Interaction[]` in → same `EventMoment[]` out.
 * No AI, no model — just rules.
 *
 * Priority invariant: event candidates always rank above CV and AI in the
 * selector. Confidence is set high (0.85+ for clean clicks) so even if a CV
 * peak coincides, the event wins on the (rank, confidence) tuple.
 *
 * V3 additions (May 2026): every emitted moment now carries
 * `whyEffectType`, `targetRegionSource`, and `sourceSignals` so the
 * inspector can show *why* this beat exists and which signals it was built
 * from.
 */

import type { Interaction } from "../recording/types";
import type {
  ConfidenceSource,
  DetectedMoment,
  EffectType,
  TargetRegionSource,
  UIContext,
} from "../firebase/schema";
import { bucketAt, type CursorIntentSeries } from "./cursor-intent";
import { classifyClick, type ClickTier } from "./click-classifier";
import type { VisualAnalysis } from "../firebase/schema";

export interface EventMomentOptions {
  /** Video duration in seconds. Candidates outside [0, duration] are dropped. */
  duration: number;
  /** Cursor intent series for confidence boosting (optional). */
  cursorIntent?: CursorIntentSeries;
  /**
   * Visual analysis (used for CV UI region overlap in the classifier
   * when click events lack `targetRect`). Optional — classifier
   * degrades gracefully.
   */
  visualAnalysis?: VisualAnalysis;
  /**
   * The recording's interaction scope. "external" tells the classifier
   * to IGNORE any `targetRect` on click events because it would refer
   * to AdZoom's own DOM, not the captured surface. Defaults to "tab"
   * for backwards compatibility with older callers.
   */
  scope?: "tab" | "external";
}

// ── Timing constants ────────────────────────────────────────────────────────
// Click effects start slightly BEFORE the click instant (so the camera is
// already settling when the action lands) and run for a beat after — exactly
// long enough to read the consequence. 0.2s pre + 1.0s post = 1.2s total,
// matching the product spec.
const CLICK_PRE_S = 0.2;
const CLICK_POST_S = 1.0;
const DBLCLICK_DURATION = 3.2;
const TYPING_PAD = 0.4;
const SCROLLPAUSE_DURATION = 2.0;
// Scroll pauses should start AFTER the page settles — not at the start of
// the scroll burst — so the camera doesn't try to track moving content.
const SCROLLPAUSE_POST_DELAY = 0.15;

/**
 * Legacy default focus box size — used by branches that don't run
 * through the click classifier (typing, scroll-pause). Click /
 * dblclick / rightclick now get per-tier sizing via `TIER_CONFIG`.
 */
const FOCUS_REGION_HALF = 0.12; // 24% of frame as default focus box

/**
 * Per-tier moment shape. Replaces the single hardcoded 24% box +
 * `click-highlight` effect that every click used to produce.
 *
 *   - primary-cta → real zoom, 30% box (~1.9x scale)
 *   - icon        → real zoom, 18% box (~2.4x scale)
 *   - nav         → real zoom, 35% box (~1.65x scale)
 *   - form        → cursor-focus, 28×20% box (subtle)
 *   - background  → click-highlight ring only, 24% box, low intensity
 */
const TIER_CONFIG: Record<
  ClickTier,
  {
    effectType: EffectType;
    halfW: number;
    halfH: number;
    intensity: number;
    uiContext: UIContext;
    preS: number;
    postS: number;
    label: string;
  }
> = {
  "primary-cta": {
    effectType: "zoom",
    halfW: 0.15,
    halfH: 0.15,
    intensity: 0.95,
    uiContext: "button",
    preS: 0.3,
    postS: 1.4,
    label: "Primary action",
  },
  icon: {
    effectType: "zoom",
    halfW: 0.09,
    halfH: 0.09,
    intensity: 0.9,
    uiContext: "button",
    preS: 0.2,
    postS: 1.0,
    label: "Icon click",
  },
  nav: {
    effectType: "zoom",
    halfW: 0.175,
    halfH: 0.175,
    intensity: 0.85,
    uiContext: "navigation",
    preS: 0.25,
    postS: 1.0,
    label: "Navigation",
  },
  form: {
    effectType: "cursor-focus",
    halfW: 0.14,
    halfH: 0.1,
    intensity: 0.75,
    uiContext: "form",
    preS: 0.2,
    postS: 1.2,
    label: "Form focus",
  },
  background: {
    effectType: "click-highlight",
    halfW: 0.12,
    halfH: 0.12,
    intensity: 0.5,
    uiContext: "other",
    preS: 0.2,
    postS: 0.8,
    label: "Click",
  },
};

interface MomentBuild {
  id: string;
  startTime: number;
  endTime: number;
  /** Box centre in source-normalised coords. */
  x: number;
  y: number;
  /** Box half-width and half-height. Default to FOCUS_REGION_HALF. */
  halfW?: number;
  halfH?: number;
  /** Override the default `confidenceScore + 0.05` recommendedIntensity. */
  intensity?: number;
  effectType: EffectType;
  uiContext: UIContext;
  label: string;
  confidenceScore: number;
  confidenceSource: ConfidenceSource;
  confidenceReason: string;
  eventIds: string[];
  whyEffectType: string;
  targetRegionSource: TargetRegionSource;
  sourceSignals: string[];
}

function moment(b: MomentBuild): DetectedMoment {
  const halfW = b.halfW ?? FOCUS_REGION_HALF;
  const halfH = b.halfH ?? FOCUS_REGION_HALF;
  return {
    id: b.id,
    startTime: b.startTime,
    endTime: b.endTime,
    label: b.label,
    reason: b.confidenceReason,
    focusRegion: {
      x: Math.max(0, Math.min(1, b.x - halfW)),
      y: Math.max(0, Math.min(1, b.y - halfH)),
      width: halfW * 2,
      height: halfH * 2,
    },
    effectType: b.effectType,
    uiContext: b.uiContext,
    source: "ai",
    provenance: "event",
    eventIds: b.eventIds,
    confidenceScore: b.confidenceScore,
    confidenceSource: b.confidenceSource,
    confidenceReason: b.confidenceReason,
    attentionScore: b.confidenceScore,
    recommendedIntensity: b.intensity ?? Math.min(1, b.confidenceScore + 0.05),
    whyEffectType: b.whyEffectType,
    targetRegionSource: b.targetRegionSource,
    sourceSignals: b.sourceSignals,
  };
}

/**
 * Resolve the box centre from a click event. Prefers the targetRect
 * centre (more accurate when the user clicked near the edge of a big
 * element) and falls through to the click coords otherwise.
 */
function rectCentre(
  click: { x: number; y: number; targetRect?: { x: number; y: number; width: number; height: number } },
  scope: "tab" | "external"
): { x: number; y: number } {
  const rect = scope === "external" ? undefined : click.targetRect;
  if (rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  return { x: click.x, y: click.y };
}

function clampWindow(start: number, end: number, duration: number): [number, number] {
  let s = Math.max(0, Math.min(duration, start));
  let e = Math.max(0, Math.min(duration, end));
  if (e <= s) e = Math.min(duration, s + 0.5);
  return [s, e];
}

/**
 * Generate moment candidates from real interaction events.
 *
 * Rules (order matters because some rules merge with later ones):
 * 1. dblclick → click-highlight moment, 3.2s window.
 * 2. click → click-highlight, 1.2s window (0.2s pre, 1.0s post). If a hover
 *    ≥600ms just preceded the click within 1.5s, the hover merges in (longer
 *    settle = higher confidence).
 * 3. rightclick → menu zoom moment.
 * 4. typing burst → cursor-focus moment covering the burst.
 * 5. scrollpause → cursor-focus moment, starts after pause settles.
 * 6. idle windows ≥4s suppress competing candidates that land inside.
 */
export function momentsFromEvents(
  interactions: Interaction[],
  opts: EventMomentOptions
): DetectedMoment[] {
  const { duration, cursorIntent, visualAnalysis, scope = "tab" } = opts;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (!interactions || interactions.length === 0) return [];

  const clicks = interactions.filter(
    (e): e is Extract<Interaction, { type: "click" }> => e.type === "click"
  );
  const dblclicks = interactions.filter(
    (e): e is Extract<Interaction, { type: "dblclick" }> => e.type === "dblclick"
  );
  const rightclicks = interactions.filter(
    (e): e is Extract<Interaction, { type: "rightclick" }> => e.type === "rightclick"
  );
  const hovers = interactions.filter(
    (e): e is Extract<Interaction, { type: "hover" }> => e.type === "hover"
  );
  const typings = interactions.filter(
    (e): e is Extract<Interaction, { type: "typing" }> => e.type === "typing"
  );
  const scrollPauses = interactions.filter(
    (e): e is Extract<Interaction, { type: "scrollpause" }> => e.type === "scrollpause"
  );
  const idles = interactions.filter(
    (e): e is Extract<Interaction, { type: "idle" }> => e.type === "idle"
  );

  const usedClickIds = new Set<string>();
  const candidates: DetectedMoment[] = [];

  // 1. Double-clicks — handled first so the underlying clicks they consume
  // aren't double-counted by the click loop. Double-clicks are
  // always primary-cta (the user explicitly committed to that target).
  for (const dc of dblclicks) {
    const cfg = TIER_CONFIG["primary-cta"];
    const centre = rectCentre(dc, scope);
    const [s, e] = clampWindow(dc.t - cfg.preS, dc.t + DBLCLICK_DURATION - cfg.preS, duration);
    const tierSignals = [
      `dblclick@${dc.t.toFixed(2)}`,
      "tier=primary-cta",
      "from-dblclick",
    ];
    candidates.push(
      moment({
        id: `mom_evt_${dc.id}`,
        startTime: s,
        endTime: e,
        x: centre.x,
        y: centre.y,
        halfW: cfg.halfW,
        halfH: cfg.halfH,
        intensity: cfg.intensity,
        effectType: cfg.effectType,
        uiContext: cfg.uiContext,
        label: "Double-click",
        confidenceScore: 0.97,
        confidenceSource: "real-double-click",
        confidenceReason: `0.97 — real double-click at ${dc.t.toFixed(2)}s · ${cfg.label}`,
        eventIds: [dc.id],
        whyEffectType: `double-click → ${cfg.effectType} (primary-cta, 3.2s window)`,
        targetRegionSource: dc.targetRect && scope === "tab" ? "click-event" : "click-event",
        sourceSignals: tierSignals,
      })
    );
    for (const c of clicks) {
      if (Math.abs(c.t - dc.t) <= 0.35) usedClickIds.add(c.id);
    }
  }

  // 2. Clicks — classifier-driven tier selection drives effectType,
  // focus box size, intensity, and timing window.
  for (const c of clicks) {
    if (usedClickIds.has(c.id)) continue;

    // Hover settle + cursor hesitation give confidence bumps; they
    // don't change the tier (which comes from the classifier).
    let mergedHover: Extract<Interaction, { type: "hover" }> | null = null;
    for (const h of hovers) {
      const gap = c.t - h.t;
      if (gap >= 0 && gap <= 1.5 && h.durationSeconds >= 0.6) {
        if (!mergedHover || h.durationSeconds > mergedHover.durationSeconds) {
          mergedHover = h;
        }
      }
    }

    // Classify the click. The classifier handles targetRect ↔ heuristic
    // path selection internally based on `scope`.
    const classification = classifyClick({
      click: { x: c.x, y: c.y, t: c.t, targetRect: c.targetRect },
      cursorIntent,
      visualAnalysis,
      scope,
    });
    const tier = classification.tier;
    const cfg = TIER_CONFIG[tier];
    const centre = rectCentre(c, scope);

    // Build confidence: tier classifier baseline, then hover / hesitation bumps.
    let conf = classification.confidence;
    let cs: ConfidenceSource = "real-click";
    let reason = `${conf.toFixed(2)} — real click at ${c.t.toFixed(2)}s · ${cfg.label}`;
    const evIds: string[] = [c.id];
    const signals: string[] = [...classification.signals];
    if (mergedHover) {
      conf = Math.min(0.99, conf + 0.03);
      cs = "real-hover-settle";
      reason = `${conf.toFixed(2)} — real click at ${c.t.toFixed(2)}s after ${mergedHover.durationSeconds.toFixed(2)}s hover · ${cfg.label}`;
      evIds.unshift(mergedHover.id);
      signals.unshift(
        `hover-settle@${mergedHover.t.toFixed(2)}+${mergedHover.durationSeconds.toFixed(2)}s`
      );
    } else if (cursorIntent && cursorIntent.sampleCount > 0) {
      const b = bucketAt(cursorIntent, c.t);
      const hes = cursorIntent.samples[b]?.hesitationScore ?? 0;
      if (hes > 0.5) {
        conf = Math.min(0.99, conf + 0.03);
        cs = "cursor-intent-hesitation";
        reason = `${conf.toFixed(2)} — real click preceded by cursor hesitation (${hes.toFixed(2)}) · ${cfg.label}`;
      }
    }

    const [s, e] = clampWindow(c.t - cfg.preS, c.t + cfg.postS, duration);
    const targetRegionSource: TargetRegionSource =
      c.targetRect && scope === "tab" ? "click-event" : "click-event";

    candidates.push(
      moment({
        id: `mom_evt_${c.id}`,
        startTime: s,
        endTime: e,
        x: centre.x,
        y: centre.y,
        halfW: cfg.halfW,
        halfH: cfg.halfH,
        intensity: cfg.intensity,
        effectType: cfg.effectType,
        uiContext: cfg.uiContext,
        label: cfg.label,
        confidenceScore: conf,
        confidenceSource: cs,
        confidenceReason: reason,
        eventIds: evIds,
        whyEffectType: `click classified as ${tier} → ${cfg.effectType}`,
        targetRegionSource,
        sourceSignals: signals,
      })
    );
  }

  // 3. Right-clicks — context menus deserve a real zoom (the menu
  // pops where the click landed). Always primary-cta tier — the user
  // wants to inspect the menu options that just appeared.
  for (const rc of rightclicks) {
    const cfg = TIER_CONFIG["primary-cta"];
    const centre = rectCentre(rc, scope);
    const [s, e] = clampWindow(rc.t - cfg.preS, rc.t + cfg.postS + 0.4, duration);
    const tierSignals = [
      `rightclick@${rc.t.toFixed(2)}`,
      "tier=primary-cta",
      "from-rightclick",
    ];
    candidates.push(
      moment({
        id: `mom_evt_${rc.id}`,
        startTime: s,
        endTime: e,
        x: centre.x,
        y: centre.y,
        halfW: cfg.halfW,
        halfH: cfg.halfH,
        intensity: cfg.intensity,
        effectType: "zoom",
        uiContext: "menu",
        label: "Context menu",
        confidenceScore: 0.9,
        confidenceSource: "real-right-click",
        confidenceReason: `0.90 — real right-click at ${rc.t.toFixed(2)}s · context menu`,
        eventIds: [rc.id],
        whyEffectType: "right-click → zoom (context menu reveal)",
        targetRegionSource: "click-event",
        sourceSignals: tierSignals,
      })
    );
  }

  // 4. Typing bursts → cursor-focus on form area.
  for (const ty of typings) {
    const [s, e] = clampWindow(ty.t - TYPING_PAD, ty.tEnd + TYPING_PAD, duration);
    candidates.push(
      moment({
        id: `mom_evt_${ty.id}`,
        startTime: s,
        endTime: e,
        x: 0.5,
        y: 0.5,
        effectType: "cursor-focus",
        uiContext: "form",
        label: "Typing",
        confidenceScore: 0.88,
        confidenceSource: "real-typing-burst",
        confidenceReason: `0.88 — typing burst (${ty.keyCount} keys, ${(ty.tEnd - ty.t).toFixed(2)}s)`,
        eventIds: [ty.id],
        whyEffectType: "typing burst → cursor-focus (track form field activity)",
        // Typing doesn't carry coords — focus region falls back to default.
        // The balancer's CV fusion may upgrade this to motion-centroid.
        targetRegionSource: "default",
        sourceSignals: [`typing@${ty.t.toFixed(2)}-${ty.tEnd.toFixed(2)}`, `keys=${ty.keyCount}`],
      })
    );
  }

  // 5. Scroll pauses → cursor-focus AFTER the page settles.
  for (const sp of scrollPauses) {
    const [s, e] = clampWindow(
      sp.t + SCROLLPAUSE_POST_DELAY,
      sp.t + SCROLLPAUSE_POST_DELAY + SCROLLPAUSE_DURATION,
      duration
    );
    candidates.push(
      moment({
        id: `mom_evt_${sp.id}`,
        startTime: s,
        endTime: e,
        x: 0.5,
        y: 0.5,
        effectType: "cursor-focus",
        uiContext: "scroll",
        label: "Scroll pause",
        confidenceScore: 0.78,
        confidenceSource: "real-scroll-pause",
        confidenceReason: `0.78 — paused after scrolling at ${sp.t.toFixed(2)}s`,
        eventIds: [sp.id],
        whyEffectType: "scroll-pause → cursor-focus (starts after page settles)",
        targetRegionSource: "default",
        sourceSignals: [`scrollpause@${sp.t.toFixed(2)}+${sp.pauseSeconds.toFixed(2)}s`],
      })
    );
  }

  // 6. Suppress candidates that land inside a long idle window. Idle stretches
  // are app-switching / read-the-docs lulls — no edit deserves to live there.
  const filtered: DetectedMoment[] = [];
  for (const c of candidates) {
    const inIdle = idles.some(
      (id) => id.tEnd - id.t >= 4 && c.startTime >= id.t && c.endTime <= id.tEnd
    );
    if (!inIdle) filtered.push(c);
  }

  return filtered;
}
