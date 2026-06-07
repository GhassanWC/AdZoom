/**
 * Crop / Reframe engine — deterministic, FREE, per-chunk.
 *
 * Answers "what region should the viewer see clearly during this stretch?" —
 * NOT a zoom punch. It looks at where on-screen activity (cursor / motion
 * hotspot) concentrates over the chunk window; when that's a stable, localized
 * region for ≥5s it emits a Crop/Reframe section framing it.
 *
 * Context-driven aspect:
 *   - If a vertical export target is selected (verticalExport or "TikTok 9:16")
 *     → reframe the active region to 9:16.
 *   - Otherwise keep the original aspect and only emit a "tighten-in" crop when
 *     the active region is clearly small / off-centre (else full frame is best).
 *
 * Output is a `DetectedMoment[]` with `effectType: "crop"` so it rides the same
 * append / track-routing / camera-export path as a manual crop. Conservative by
 * design (precision over recall): at most ~1 region per chunk, no jitter.
 */
import type {
  CropAspect,
  CropPosition,
  CropSettings,
  DetectedMoment,
  ProjectDoc,
  VisualAnalysis,
} from "../firebase/schema";
import { dequantize } from "../cv/resample";

export interface EngineDiagnostics {
  generated: number;
  rejected: number;
  reasons: Record<string, number>;
  avgDurationS: number;
  avgConfidence: number;
}

export interface ChunkWindow {
  index: number;
  startTime: number;
  endTime: number;
}

const MIN_CROP_S = 5;
const MAX_CROP_S = 20;
const MIN_CONF = 0.55;
/** Per-second motion above this means "something is happening". */
const ACTIVE_MOTION = 0.02;
/** Normalised stddev below this = a localized activity cluster (croppable). */
const TIGHT_SPREAD = 0.16;
/** Original-aspect tighten-in only when the cluster box is smaller than this… */
const TIGHTEN_MAX_AREA = 0.55;
/** …or clearly off-centre by at least this (normalised distance from centre). */
const OFFCENTER_MIN = 0.1;

const ASPECT_WH: Record<string, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function emptyDiag(reasons: Record<string, number>): EngineDiagnostics {
  const rejected = Object.values(reasons).reduce((a, b) => a + b, 0);
  return { generated: 0, rejected, reasons, avgDurationS: 0, avgConfidence: 0 };
}

function diagFrom(
  sections: DetectedMoment[],
  reasons: Record<string, number>
): EngineDiagnostics {
  const n = sections.length;
  const dur = sections.reduce((a, s) => a + (s.endTime - s.startTime), 0);
  const conf = sections.reduce((a, s) => a + (s.confidenceScore ?? 0), 0);
  const rejected = Object.values(reasons).reduce((a, b) => a + b, 0);
  return {
    generated: n,
    rejected,
    reasons,
    avgDurationS: n ? dur / n : 0,
    avgConfidence: n ? conf / n : 0,
  };
}

/** A vertical reframe target selected on the project, or null. */
function verticalTarget(project: ProjectDoc): CropAspect | null {
  const e = project.effectsSettings;
  if (!e) return null;
  if (e.verticalExport === true) return "9:16";
  if (e.defaultExportFormat === "TikTok 9:16") return "9:16";
  return null;
}

function positionFor(cx: number, cy: number): CropPosition {
  if (cx < 0.34) return "left";
  if (cx > 0.66) return "right";
  if (cy < 0.34) return "top";
  if (cy > 0.66) return "bottom";
  return "center";
}

/** Box of `aspect`, centred on (mx,my), clamped inside the frame. */
function aspectBoxAt(
  mx: number,
  my: number,
  aspect: CropAspect,
  sourceAspect: number
): { x: number; y: number; width: number; height: number } {
  let bw = 1;
  let bh = 1;
  if (aspect !== "original" && aspect !== "custom") {
    const ratioWH = ASPECT_WH[aspect] / sourceAspect;
    if (ratioWH >= 1) {
      bw = 1;
      bh = 1 / ratioWH;
    } else {
      bh = 1;
      bw = ratioWH;
    }
  }
  const x = Math.max(0, Math.min(1 - bw, mx - bw / 2));
  const y = Math.max(0, Math.min(1 - bh, my - bh / 2));
  return { x, y, width: bw, height: bh };
}

/**
 * Generate crop sections for one chunk from its window-local `VisualAnalysis`.
 * `primaryEnd` is the chunk's primary-span end (absolute) — sections are
 * clamped to it so chunk boundaries don't double-emit.
 */
export function cropSectionsForChunk(
  va: VisualAnalysis,
  window: ChunkWindow,
  project: ProjectDoc,
  primaryEnd: number
): { sections: DetectedMoment[]; diag: EngineDiagnostics } {
  const reasons: Record<string, number> = {};
  const reject = (r: string) => {
    reasons[r] = (reasons[r] ?? 0) + 1;
  };
  const sections: DetectedMoment[] = [];

  const n = va.motion?.length ?? 0;
  const rate = va.sampleRate || 1;
  const bucket = 1 / rate;
  if (n === 0) return { sections, diag: emptyDiag(reasons) };

  const sourceAspect =
    project.width && project.height ? project.width / project.height : 16 / 9;
  const target = verticalTarget(project);

  // Active points: where motion happens (or the cursor estimate is confident).
  const pts: { x: number; y: number }[] = [];
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < n; i++) {
    const motion = dequantize(va.motion[i] ?? 0);
    const conf = va.cursorConf ? dequantize(va.cursorConf[i] ?? 0) : 0;
    if (motion < ACTIVE_MOTION && conf < 0.4) continue;
    const useCursor = !!va.cursorX && conf >= 0.4;
    const xs = useCursor ? va.cursorX! : va.centroidX;
    const ys = useCursor ? va.cursorY! : va.centroidY;
    pts.push({ x: dequantize(xs[i] ?? 128), y: dequantize(ys[i] ?? 128) });
    if (firstIdx < 0) firstIdx = i;
    lastIdx = i;
  }

  if (pts.length < Math.ceil(MIN_CROP_S * rate)) {
    reject("too-little-activity");
    return { sections, diag: diagFrom(sections, reasons) };
  }

  // Cluster centre + spread of the active points.
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const sx = Math.sqrt(pts.reduce((a, p) => a + (p.x - mx) ** 2, 0) / pts.length);
  const sy = Math.sqrt(pts.reduce((a, p) => a + (p.y - my) ** 2, 0) / pts.length);
  if (sx > TIGHT_SPREAD || sy > TIGHT_SPREAD) {
    reject("activity-not-localized");
    return { sections, diag: diagFrom(sections, reasons) };
  }

  // Build the framing box.
  let aspect: CropAspect;
  let box: { x: number; y: number; width: number; height: number };
  if (target) {
    aspect = target;
    box = aspectBoxAt(mx, my, target, sourceAspect);
  } else {
    aspect = "original";
    const pad = 0.12;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const bx0 = clamp01(Math.min(...xs) - pad);
    const by0 = clamp01(Math.min(...ys) - pad);
    const bx1 = clamp01(Math.max(...xs) + pad);
    const by1 = clamp01(Math.max(...ys) + pad);
    const bw = Math.max(0.2, bx1 - bx0);
    const bh = Math.max(0.2, by1 - by0);
    const area = bw * bh;
    const offCentre = Math.hypot(bx0 + bw / 2 - 0.5, by0 + bh / 2 - 0.5);
    if (area > TIGHTEN_MAX_AREA && offCentre < OFFCENTER_MIN) {
      reject("fills-frame");
      return { sections, diag: diagFrom(sections, reasons) };
    }
    box = { x: bx0, y: by0, width: bw, height: bh };
  }

  // Confidence from cluster tightness.
  const tightness = 1 - Math.min(1, (sx + sy) / (2 * TIGHT_SPREAD));
  const confidence = clamp01(0.5 + 0.45 * tightness);
  if (confidence < MIN_CONF) {
    reject("low-confidence");
    return { sections, diag: diagFrom(sections, reasons) };
  }

  // Absolute time span, clamped to the chunk's primary span.
  const absStart = window.startTime + firstIdx * bucket;
  const absEnd = Math.min(window.startTime + (lastIdx + 1) * bucket, primaryEnd);
  if (absEnd - absStart < MIN_CROP_S) {
    reject("too-short");
    return { sections, diag: diagFrom(sections, reasons) };
  }

  const position = positionFor(mx, my);
  let s = absStart;
  let k = 0;
  while (s < absEnd - 0.5) {
    const e = Math.min(s + MAX_CROP_S, absEnd);
    if (e - s < MIN_CROP_S && k > 0) break; // no tiny trailing slice
    const crop: CropSettings = {
      aspectRatio: aspect,
      scale: 1,
      position,
      easing: "ease-in-out",
    };
    sections.push({
      id: `j${window.index}crop${k}`,
      startTime: s,
      endTime: e,
      label: aspect === "original" ? "Reframe" : `Reframe ${aspect}`,
      reason:
        aspect === "original"
          ? `Focused framing on the active ${position} region.`
          : `Reframed the active ${position} region to ${aspect}.`,
      focusRegion: box,
      effectType: "crop",
      crop,
      provenance: "cv",
      source: "ai",
      confidenceScore: confidence,
      attentionScore: confidence,
      targetRegionSource: "motion-centroid",
    } satisfies DetectedMoment);
    s = e;
    k++;
  }

  return { sections, diag: diagFrom(sections, reasons) };
}
