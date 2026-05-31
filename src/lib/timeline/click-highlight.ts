/**
 * Click-highlight rendering helpers.
 *
 * The editor preview renders the highlight as CSS `<span>` elements
 * inside the camera-transformed wrapper (so CSS scale on the wrapper
 * magnifies the ring with the zoom). The exporter renders it via a
 * canvas arc / lines call inside the same camera transform on the 2D
 * context.
 *
 * Both paths must produce the same shape — same base size, same growth
 * curve, same opacity falloff. `clickHighlightGeometry` is the single
 * source of truth for those numbers; the preview maps them to CSS px
 * and the exporter maps them to canvas px.
 *
 * Sizing reference: the preview's CSS `base` is in CSS pixels of the
 * wrapper, which on a typical desktop editor surface is ≈ 1280 px wide.
 * The exporter scales `base` by `canvasW / EDITOR_REFERENCE_W` so a 60
 * px ring in the editor stays the same RELATIVE size in a 1920- or
 * 3840-wide export.
 */

const EDITOR_REFERENCE_W = 1280;

export type ClickHighlightStyle = "ring" | "pulse" | "burst";

export interface ClickHighlightGeometry {
  /** Outer ring/pulse — common to all three styles. */
  outer: {
    /** Radius in "reference px" — caller scales for its surface. */
    radius: number;
    /** 0..1 alpha. */
    opacity: number;
  };
  /**
   * Pulse-only secondary ring (the small fixed inner dot). Undefined for
   * `ring` and `burst` styles.
   */
  innerRing?: { radius: number; opacity: number };
  /**
   * Burst-only spoke geometry. Undefined for `ring` and `pulse`. The
   * spokes are evenly distributed around the centre; each spans
   * (innerRatio, outerRatio) of `outer.radius`.
   */
  spokes?: {
    count: number;
    innerRatio: number;
    outerRatio: number;
    opacity: number;
  };
}

/**
 * Compute the geometry for one click-highlight frame.
 *
 * `progress` is 0..1 over the moment window; `sizePct` is the
 * effects-settings 0..100 size slider. The math is intentionally
 * inlined from the previous CSS-only implementation so visual output
 * is byte-for-byte identical to what the preview used to render.
 */
export function clickHighlightGeometry(
  progress: number,
  sizePct: number,
  style: ClickHighlightStyle
): ClickHighlightGeometry {
  const p = clamp01(progress);
  const size = clamp01(sizePct / 100);
  const base = 24 + size * 72; // 24..96 reference px

  if (style === "pulse") {
    return {
      outer: { radius: (base + p * 80) / 2, opacity: 0.8 - p * 0.6 },
      innerRing: { radius: (base * 0.55) / 2, opacity: 0.9 },
    };
  }

  if (style === "burst") {
    return {
      outer: { radius: (base + p * 120) / 2, opacity: 1 - p * 0.85 },
      spokes: { count: 10, innerRatio: 0.3, outerRatio: 0.48, opacity: 1 - p * 0.85 },
    };
  }

  // "ring" — default
  return {
    outer: { radius: (base + p * 64) / 2, opacity: 1 - p * 0.7 },
  };
}

export interface ClickHighlightDraw {
  /** Source-normalised centre, 0..1. */
  cx: number;
  cy: number;
  /** 0..1 progress over the moment window. */
  progress: number;
  style: ClickHighlightStyle;
  /** 0..100 — same field the preview reads from EffectsSettings. */
  sizePct: number;
}

/**
 * Draw a click highlight onto a canvas, INSIDE the camera transform
 * (so it scales with zoom — matches preview behaviour where the CSS
 * scale on the wrapper magnifies child elements uniformly).
 *
 * The caller must have already applied the camera transform chain:
 *
 *   ctx.save();
 *   ctx.translate(canvasW/2, canvasH/2);
 *   ctx.scale(camera.scale, camera.scale);
 *   ctx.translate(tx, ty);
 *   ctx.drawImage(video, -drawW/2, -drawH/2, drawW, drawH);
 *   drawClickHighlight(ctx, draw, drawW, drawH, canvasW); // ← here
 *   ctx.restore();
 *
 * Positions are computed in "transformed frame" coords
 * (-drawW/2..drawW/2, -drawH/2..drawH/2), the same coord space
 * `drawImage` uses above. Radii are in source pixels at canvas scale
 * 1 — the surrounding `ctx.scale` already applied magnifies them with
 * the zoom.
 */
export function drawClickHighlight(
  ctx: CanvasRenderingContext2D,
  draw: ClickHighlightDraw,
  drawW: number,
  drawH: number,
  canvasW: number
): void {
  const geom = clickHighlightGeometry(draw.progress, draw.sizePct, draw.style);

  // Position in transformed-frame coords (matches drawImage's offset).
  const px = drawW * (draw.cx - 0.5);
  const py = drawH * (draw.cy - 0.5);

  // Map "reference px" → "source px on canvas" so the highlight's
  // RELATIVE size matches the editor preview regardless of export
  // resolution. The surrounding camera-transform scale will magnify
  // this with the zoom, exactly like the CSS scale on the wrapper
  // magnifies the preview's <span> children.
  const refScale = canvasW / EDITOR_REFERENCE_W;

  if (draw.style === "pulse") {
    // Soft filled outer + crisp inner ring.
    ctx.save();
    ctx.fillStyle = `rgba(167, 139, 250, ${geom.outer.opacity.toFixed(3)})`; // violet-400
    ctx.beginPath();
    ctx.arc(px, py, geom.outer.radius * refScale, 0, Math.PI * 2);
    ctx.fill();
    if (geom.innerRing) {
      ctx.strokeStyle = `rgba(221, 214, 254, ${geom.innerRing.opacity.toFixed(3)})`; // violet-200
      ctx.lineWidth = 1.5 * refScale;
      ctx.beginPath();
      ctx.arc(px, py, geom.innerRing.radius * refScale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (draw.style === "burst") {
    if (!geom.spokes) return;
    ctx.save();
    ctx.strokeStyle = `rgba(196, 181, 253, ${geom.spokes.opacity.toFixed(3)})`; // violet-300
    ctx.lineWidth = 3 * refScale;
    ctx.lineCap = "round";
    const r1 = geom.outer.radius * 2 * geom.spokes.innerRatio * refScale;
    const r2 = geom.outer.radius * 2 * geom.spokes.outerRatio * refScale;
    for (let i = 0; i < geom.spokes.count; i++) {
      const a = (i / geom.spokes.count) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(px + cos * r1, py + sin * r1);
      ctx.lineTo(px + cos * r2, py + sin * r2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // "ring" — a single stroked circle.
  ctx.save();
  ctx.strokeStyle = `rgba(167, 139, 250, ${geom.outer.opacity.toFixed(3)})`; // violet-400/80
  ctx.lineWidth = 1.5 * refScale;
  ctx.beginPath();
  ctx.arc(px, py, geom.outer.radius * refScale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
