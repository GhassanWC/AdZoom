/**
 * AI suggestion layer — the assistant, not the dictator.
 *
 * Derives non-destructive recommendations from the existing analysis + CV
 * signals. Nothing here mutates the timeline; it only proposes. The user
 * accepts or dismisses each one in the suggestions panel.
 *
 * Suggestion ids are deterministic so a dismissal persists across reloads
 * (only the dismissed-id list is stored, not the suggestions themselves).
 */

import type {
  AiSuggestion,
  Analysis,
  DetectedMoment,
  EffectType,
  Pacing,
  VisualAnalysis,
} from "@/lib/firebase/schema";
import { PACING_PROFILES } from "@/lib/timeline-balancer";
import { dequantize, dequantizeArray } from "@/lib/cv/resample";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** A candidate moment for an insert-kind suggestion (id assigned on accept). */
function makeMoment(
  effectType: EffectType,
  start: number,
  end: number,
  cx: number,
  cy: number,
  label: string
): DetectedMoment {
  const w = 0.4;
  const h = 0.4;
  return {
    id: "suggestion",
    startTime: Math.max(0, start),
    endTime: Math.max(start + 0.4, end),
    label,
    reason: "Suggested by AI from motion + attention signals.",
    focusRegion: {
      x: Math.max(0, Math.min(1 - w, cx - w / 2)),
      y: Math.max(0, Math.min(1 - h, cy - h / 2)),
      width: w,
      height: h,
    },
    effectType,
    intensity: 0.7,
    attentionScore: 0.6,
    source: "ai",
  };
}

/**
 * Generate the current suggestion set. Pure — safe to call on every render.
 * Dismissed ids are filtered out here so the panel only sees live items.
 */
export function generateSuggestions(
  analysis: Analysis | undefined,
  va: VisualAnalysis | undefined,
  duration: number,
  pacing: Pacing
): AiSuggestion[] {
  if (!analysis || analysis.status !== "complete" || duration <= 0) return [];

  const moments = [...(analysis.detectedMoments ?? [])].sort(
    (a, b) => a.startTime - b.startTime
  );
  const minSpacing = PACING_PROFILES[pacing]?.minSpacing ?? 7;
  const out: AiSuggestion[] = [];

  const hasMomentNear = (t: number, pad: number) =>
    moments.some((m) => t >= m.startTime - pad && t <= m.endTime + pad);

  const centroidAt = (t: number): { x: number; y: number } => {
    if (!va || va.sampleCount === 0) return { x: 0.5, y: 0.5 };
    const b = Math.max(0, Math.min(va.sampleCount - 1, Math.floor(t * va.sampleRate)));
    return {
      x: dequantize(va.centroidX[b] ?? 128),
      y: dequantize(va.centroidY[b] ?? 128),
    };
  };

  // 1. add-emphasis — sustained high attention with no moment covering it.
  if (va && va.sampleCount > 0) {
    const curve = dequantizeArray(va.attentionCurve);
    const win = Math.max(3, Math.round(6 * va.sampleRate));
    for (let s = 0; s + win <= curve.length; s += win) {
      let sum = 0;
      for (let i = s; i < s + win; i++) sum += curve[i];
      const avg = sum / win;
      const tMid = (s + win / 2) / va.sampleRate;
      if (avg > 0.5 && tMid < duration && !hasMomentNear(tMid, minSpacing / 2)) {
        const c = centroidAt(tMid);
        out.push({
          id: `emphasis-${Math.round(tMid)}`,
          kind: "add-emphasis",
          title: "This section may need emphasis",
          detail: `Strong on-screen activity around ${fmt(
            tMid
          )} has no zoom moment.`,
          atTime: tMid,
          insert: makeMoment(
            "zoom",
            tMid,
            Math.min(duration, tMid + 2.4),
            c.x,
            c.y,
            "Emphasis"
          ),
        });
      }
    }
  }

  // 2. add-focus — an inferred click the camera doesn't follow.
  if (va) {
    for (const ev of va.clickEvents) {
      if (ev.t > duration || hasMomentNear(ev.t, 2)) continue;
      const c = centroidAt(ev.t);
      out.push({
        id: `focus-${ev.t.toFixed(1)}`,
        kind: "add-focus",
        title: "Add focus to this interaction?",
        detail: `A click-like interaction at ${fmt(
          ev.t
        )} isn't followed by the camera.`,
        atTime: ev.t,
        insert: makeMoment(
          "cursor-focus",
          Math.max(0, ev.t - 0.2),
          Math.min(duration, ev.t + 1.6),
          c.x,
          c.y,
          "Interaction"
        ),
      });
    }
  }

  // 3. too-aggressive — heavy zoom intensity or a streak of hard zooms.
  let zoomStreak = 0;
  for (const m of moments) {
    const inten =
      m.intensity ?? m.recommendedIntensity ?? m.attentionScore ?? 0.6;
    if (m.effectType === "zoom") zoomStreak++;
    else zoomStreak = 0;

    if ((m.effectType === "zoom" && inten > 1.05) || zoomStreak >= 3) {
      out.push({
        id: `aggressive-${m.id}`,
        kind: "too-aggressive",
        title: "This edit may feel too aggressive",
        detail:
          zoomStreak >= 3
            ? "Several hard zooms in a row — consider softening one."
            : "This zoom is quite punchy; a gentler intensity may read better.",
        atTime: m.startTime,
        momentId: m.id,
        patch: { intensity: Math.min(inten, 0.7) },
      });
      if (zoomStreak >= 3) zoomStreak = 0;
    }
  }

  // 4. pacing-gap — a long dead stretch (with real activity) between moments.
  for (let i = 0; i < moments.length - 1; i++) {
    const gap = moments[i + 1].startTime - moments[i].endTime;
    if (gap <= minSpacing * 2.4) continue;
    const tMid = moments[i].endTime + gap / 2;
    if (va && va.sampleCount > 0) {
      const b = Math.min(va.sampleCount - 1, Math.floor(tMid * va.sampleRate));
      if (dequantize(va.motion[b] ?? 0) <= 0.08) continue; // truly idle — leave it
    }
    const c = centroidAt(tMid);
    out.push({
      id: `gap-${moments[i].id}`,
      kind: "pacing-gap",
      title: "Pacing slows here",
      detail: `${Math.round(gap)}s with no edits between "${
        moments[i].label
      }" and "${moments[i + 1].label}".`,
      atTime: tMid,
      insert: makeMoment(
        "cursor-focus",
        tMid,
        Math.min(duration, tMid + 2),
        c.x,
        c.y,
        "Keep momentum"
      ),
    });
  }

  // Dedupe, drop dismissed, sort by time, cap.
  const seen = new Set<string>();
  const dismissed = new Set(analysis.dismissedSuggestionIds ?? []);
  return out
    .filter((s) => {
      if (seen.has(s.id) || dismissed.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .sort((a, b) => a.atTime - b.atTime)
    .slice(0, 8);
}
