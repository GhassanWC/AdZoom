/**
 * overlay-draw — the single, DOM-agnostic renderer for the Phase-3 "Core AI Edit
 * Pack" overlays (captions, hook text, text overlays, callouts, blur/redaction,
 * branding CTAs, transitions). Like `compose-frame`, it takes a 2D context and
 * draws the layers the export bakes in, so preview + export agree by
 * construction.
 *
 * TWO passes, matching the two coordinate spaces the compositor exposes:
 *
 *   • OUTPUT-anchored (`drawOutputOverlays`) — captions / hook text / text
 *     overlays / branding CTA / transition. Drawn in OUTPUT canvas pixels
 *     (origin = top-left), OUTSIDE the camera transform, so they stay pinned to
 *     the frame (they never zoom/pan with the video).
 *
 *   • IN-CAMERA (`drawInCameraOverlays`) — callout / blur-redaction. Drawn in the
 *     base placement space (origin = placement CENTRE, the same convention as
 *     `drawClickHighlight`), INSIDE the camera transform, so they track the video
 *     content as it zooms/pans.
 *
 * Every function is pure + framework-neutral (no `document`, no async, no
 * `Date.now`) so the browser exporter, the @napi-rs worker, and the Remotion
 * `<canvas>` layers can all call it and match. `ctx` is typed against the DOM
 * `CanvasRenderingContext2D`; the worker/Remotion pass API-compatible contexts.
 */
import type {
  BrandingCtaSettings,
  CaptionSettings,
  CalloutSettings,
  DetectedMoment,
  FocusRegion,
  HookTextSettings,
  TextOverlaySettings,
  TransitionSettings,
} from "@/lib/firebase/schema";

const FONT_STACK = `-apple-system, "Segoe UI", system-ui, sans-serif`;

/** Output-frame geometry the output-anchored pass needs. */
export interface OverlayLayout {
  canvasW: number;
  canvasH: number;
}

// ── small pure helpers ──────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Appearance envelope — fade in over the first `ramp`s, out over the last. */
function envelopeAlpha(t: number, start: number, end: number, ramp = 0.25): number {
  const dur = end - start;
  if (dur <= 0) return 0;
  const r = Math.min(ramp, dur / 2);
  if (t < start || t > end) return 0;
  if (t < start + r) return clamp01((t - start) / r);
  if (t > end - r) return clamp01((end - t) / r);
  return 1;
}

/** Animation-in progress (0..1) over the first `ramp`s of the window. */
function inProgress(t: number, start: number, end: number, ramp = 0.35): number {
  const r = Math.min(ramp, Math.max(0.001, (end - start) / 2));
  return clamp01((t - start) / r);
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Greedy word-wrap to `maxWidth` px (ctx.font must already be set). */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = `${line} ${words[i]}`;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = words[i];
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

// ── selection ────────────────────────────────────────────────────────────────

/** Overlay moments active at source time `t`, split by coordinate space. */
export function activeOverlays(
  moments: DetectedMoment[],
  t: number
): { output: DetectedMoment[]; inCamera: DetectedMoment[] } {
  const output: DetectedMoment[] = [];
  const inCamera: DetectedMoment[] = [];
  for (const m of moments) {
    if (t < m.startTime || t >= m.endTime) continue;
    switch (m.effectType) {
      case "captions":
      case "hook-text":
      case "text-overlay":
      case "branding-cta":
      case "transition":
        output.push(m);
        break;
      case "callout":
      case "blur-redaction":
        inCamera.push(m);
        break;
      default:
        break;
    }
  }
  return { output, inCamera };
}

/** True if any overlay moment exists (cheap gate to skip the passes entirely). */
export function hasOverlayMoments(moments: DetectedMoment[]): boolean {
  return moments.some(
    (m) =>
      m.effectType === "captions" ||
      m.effectType === "hook-text" ||
      m.effectType === "text-overlay" ||
      m.effectType === "branding-cta" ||
      m.effectType === "transition" ||
      m.effectType === "callout" ||
      m.effectType === "blur-redaction"
  );
}

// ── OUTPUT-anchored pass ─────────────────────────────────────────────────────

/**
 * Draw all output-anchored overlays active at `t`. Origin = output top-left.
 * Caller is OUTSIDE the camera transform. Each draw save/restores its own state.
 */
export function drawOutputOverlays(
  ctx: CanvasRenderingContext2D,
  moments: DetectedMoment[],
  t: number,
  layout: OverlayLayout
): void {
  const { output } = activeOverlays(moments, t);
  if (!output.length) return;
  // Text first, transition LAST so a dip darkens everything uniformly.
  for (const m of output) {
    if (m.effectType === "captions" && m.captions) drawCaption(ctx, m.captions, m, t, layout);
    else if (m.effectType === "hook-text" && m.hookText) drawHookText(ctx, m.hookText, m, t, layout);
    else if (m.effectType === "text-overlay" && m.textOverlay)
      drawTextOverlay(ctx, m.textOverlay, m, t, layout);
    else if (m.effectType === "branding-cta" && m.brandingCta)
      drawBrandingCta(ctx, m.brandingCta, m, t, layout);
  }
  for (const m of output) {
    if (m.effectType === "transition" && m.transition) drawTransition(ctx, m.transition, m, t, layout);
  }
}

interface TextBoxStyle {
  fontWeight: number;
  fontScale: number; // fraction of canvasH
  color: string;
  bg?: string;
  shadow: boolean;
  uppercase?: boolean;
}

const CAPTION_PRESETS: Record<CaptionSettings["stylePreset"], TextBoxStyle> = {
  clean: { fontWeight: 600, fontScale: 0.05, color: "#fff", bg: "rgba(0,0,0,0.55)", shadow: true },
  bold_social: { fontWeight: 800, fontScale: 0.062, color: "#fff", bg: "rgba(0,0,0,0.35)", shadow: true, uppercase: true },
  minimal: { fontWeight: 600, fontScale: 0.045, color: "#fff", shadow: true },
  podcast: { fontWeight: 700, fontScale: 0.052, color: "#fff", bg: "rgba(12,10,24,0.72)", shadow: false },
  tutorial: { fontWeight: 600, fontScale: 0.046, color: "#fff", bg: "rgba(0,0,0,0.6)", shadow: false },
};

function anchorY(pos: "top" | "center" | "bottom" | "custom", canvasH: number): number {
  if (pos === "top") return canvasH * 0.14;
  if (pos === "center") return canvasH * 0.5;
  return canvasH * 0.82; // bottom / custom
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  s: CaptionSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = envelopeAlpha(t, m.startTime, m.endTime);
  if (alpha <= 0 || !s.text.trim()) return;
  const style = CAPTION_PRESETS[s.stylePreset] ?? CAPTION_PRESETS.clean;
  const fontSize = Math.max(14, Math.round(canvasH * style.fontScale));
  const text = style.uppercase ? s.text.toUpperCase() : s.text;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${style.fontWeight} ${fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const maxWidth = canvasW * 0.82;
  const lines = wrapText(ctx, text, maxWidth);
  const lineH = fontSize * 1.25;
  const blockH = lines.length * lineH;
  let cy = anchorY(s.position, canvasH) - blockH / 2 + lineH / 2;
  const cx = canvasW / 2;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (style.bg) {
      const padX = fontSize * 0.55;
      const padY = fontSize * 0.28;
      ctx.fillStyle = style.bg;
      roundRectPath(ctx, cx - w / 2 - padX, cy - lineH / 2 + padY * 0.4, w + padX * 2, lineH - padY * 0.2, fontSize * 0.28);
      ctx.fill();
    }
    if (style.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = fontSize * 0.28;
      ctx.shadowOffsetY = fontSize * 0.05;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, cx, cy);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    cy += lineH;
  }
  ctx.restore();
}

const HOOK_PRESETS: Record<HookTextSettings["stylePreset"], TextBoxStyle> = {
  bold: { fontWeight: 900, fontScale: 0.085, color: "#fff", shadow: true, uppercase: true },
  minimal: { fontWeight: 700, fontScale: 0.07, color: "#fff", shadow: true },
  neon: { fontWeight: 900, fontScale: 0.085, color: "#c4b5fd", shadow: true, uppercase: true },
  shadow: { fontWeight: 800, fontScale: 0.08, color: "#fff", bg: "rgba(0,0,0,0.4)", shadow: true },
};

function drawHookText(
  ctx: CanvasRenderingContext2D,
  s: HookTextSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = envelopeAlpha(t, m.startTime, m.endTime);
  if (alpha <= 0 || !s.text.trim()) return;
  const style = HOOK_PRESETS[s.stylePreset] ?? HOOK_PRESETS.bold;
  const fontSize = Math.max(18, Math.round(canvasH * style.fontScale));
  const text = style.uppercase ? s.text.toUpperCase() : s.text;
  const p = easeOut(inProgress(t, m.startTime, m.endTime));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${style.fontWeight} ${fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const maxWidth = canvasW * 0.86;
  const lines = wrapText(ctx, text, maxWidth);
  const lineH = fontSize * 1.16;
  const blockH = lines.length * lineH;
  const baseY = anchorY(s.position, canvasH);
  // Animation offset.
  let dx = 0;
  let dy = 0;
  let scale = 1;
  if (s.animation === "slide") dx = (1 - p) * canvasW * 0.08;
  else if (s.animation === "pop") scale = 0.85 + 0.15 * p;
  ctx.translate(canvasW / 2 + dx, baseY + dy);
  // The text block is centred on THIS origin: `cy` runs symmetrically from
  // -blockH/2+lineH/2 to +blockH/2-lineH/2 (centre = 0). So `scale` grows it in
  // place around its own centre — no translate-scale-translate needed, and no
  // vertical drift as the pop animates.
  ctx.scale(scale, scale);
  let cy = -blockH / 2 + lineH / 2;
  for (const line of lines) {
    if (style.bg) {
      const w = ctx.measureText(line).width;
      const padX = fontSize * 0.5;
      ctx.fillStyle = style.bg;
      roundRectPath(ctx, -w / 2 - padX, cy - lineH / 2 + lineH * 0.12, w + padX * 2, lineH * 0.82, fontSize * 0.25);
      ctx.fill();
    }
    if (style.shadow) {
      ctx.shadowColor = style.color === "#c4b5fd" ? "rgba(139,92,246,0.7)" : "rgba(0,0,0,0.65)";
      ctx.shadowBlur = fontSize * 0.4;
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, 0, cy);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    cy += lineH;
  }
  ctx.restore();
}

const OVERLAY_SIZE_SCALE: Record<TextOverlaySettings["size"], number> = {
  small: 0.032,
  medium: 0.045,
  large: 0.06,
};

function textOverlayAnchor(
  pos: TextOverlaySettings["position"],
  canvasW: number,
  canvasH: number
): { x: number; y: number; align: CanvasTextAlign } {
  const mx = canvasW * 0.06;
  const my = canvasH * 0.08;
  const left = mx;
  const centerX = canvasW / 2;
  const right = canvasW - mx;
  const top = my;
  const middle = canvasH / 2;
  const bottom = canvasH - my;
  switch (pos) {
    case "top-left": return { x: left, y: top, align: "left" };
    case "top-center": return { x: centerX, y: top, align: "center" };
    case "top-right": return { x: right, y: top, align: "right" };
    case "middle-left": return { x: left, y: middle, align: "left" };
    case "center": return { x: centerX, y: middle, align: "center" };
    case "middle-right": return { x: right, y: middle, align: "right" };
    case "bottom-left": return { x: left, y: bottom, align: "left" };
    case "bottom-center": return { x: centerX, y: bottom, align: "center" };
    case "bottom-right": return { x: right, y: bottom, align: "right" };
    default: return { x: centerX, y: bottom, align: "center" };
  }
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  s: TextOverlaySettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const baseAlpha = envelopeAlpha(t, m.startTime, m.endTime, s.animation === "fade" ? 0.4 : 0.2);
  if (baseAlpha <= 0 || !s.text.trim()) return;
  const fontSize = Math.max(12, Math.round(canvasH * (OVERLAY_SIZE_SCALE[s.size] ?? 0.045)));
  const anchor = textOverlayAnchor(s.position, canvasW, canvasH);
  const p = easeOut(inProgress(t, m.startTime, m.endTime));
  ctx.save();
  ctx.globalAlpha = baseAlpha;
  ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  ctx.textAlign = anchor.align;
  const maxWidth = canvasW * 0.6;
  const lines = wrapText(ctx, s.text, maxWidth);
  const lineH = fontSize * 1.28;
  let dx = 0;
  let scale = 1;
  if (s.animation === "slide") dx = (1 - p) * canvasW * 0.05 * (anchor.align === "right" ? -1 : 1);
  else if (s.animation === "pop") scale = 0.9 + 0.1 * p;
  const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  const blockH = lines.length * lineH;
  // Origin for background box.
  const originX =
    anchor.align === "center" ? anchor.x - blockW / 2 : anchor.align === "right" ? anchor.x - blockW : anchor.x;
  ctx.translate(dx, 0);
  if (scale !== 1) {
    ctx.translate(anchor.x, anchor.y);
    ctx.scale(scale, scale);
    ctx.translate(-anchor.x, -anchor.y);
  }
  const padX = fontSize * 0.5;
  const padY = fontSize * 0.32;
  if (s.backgroundStyle === "pill" || s.backgroundStyle === "box") {
    ctx.fillStyle = "rgba(10,10,16,0.72)";
    const r = s.backgroundStyle === "pill" ? blockH / 2 + padY : fontSize * 0.24;
    roundRectPath(ctx, originX - padX, anchor.y - padY, blockW + padX * 2, blockH + padY * 2, r);
    ctx.fill();
  }
  let y = anchor.y;
  for (const line of lines) {
    if (s.backgroundStyle === "shadow") {
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = fontSize * 0.35;
      ctx.shadowOffsetY = fontSize * 0.06;
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(line, anchor.x, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    y += lineH;
  }
  ctx.restore();
}

const BRANDING_ACCENT: Record<BrandingCtaSettings["stylePreset"], { bg: string; fg: string }> = {
  minimal: { bg: "rgba(255,255,255,0.92)", fg: "#0a0a12" },
  creator: { bg: "rgba(139,92,246,0.95)", fg: "#fff" },
  business: { bg: "rgba(37,99,235,0.95)", fg: "#fff" },
  social: { bg: "rgba(236,72,153,0.95)", fg: "#fff" },
};

function drawBrandingCta(
  ctx: CanvasRenderingContext2D,
  s: BrandingCtaSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = envelopeAlpha(t, m.startTime, m.endTime, 0.3);
  if (alpha <= 0 || !s.ctaText.trim()) return;
  const accent = BRANDING_ACCENT[s.stylePreset] ?? BRANDING_ACCENT.creator;
  const fontSize = Math.max(14, Math.round(canvasH * 0.036));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = "middle";
  const textW = ctx.measureText(s.ctaText).width;
  const padX = fontSize * 0.9;
  const padY = fontSize * 0.55;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const margin = canvasH * 0.05;
  let x: number;
  const y = canvasH - boxH - margin;
  if (s.position === "bottom-left") x = margin;
  else if (s.position === "bottom-center") x = canvasW / 2 - boxW / 2;
  else x = canvasW - boxW - margin; // bottom-right / custom
  const p = easeOut(inProgress(t, m.startTime, m.endTime, 0.4));
  ctx.translate(0, (1 - p) * boxH * 0.4);
  ctx.fillStyle = accent.bg;
  roundRectPath(ctx, x, y, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.fillStyle = accent.fg;
  ctx.textAlign = "center";
  ctx.fillText(s.ctaText, x + boxW / 2, y + boxH / 2);
  ctx.restore();
}

function drawTransition(
  ctx: CanvasRenderingContext2D,
  s: TransitionSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const dur = m.endTime - m.startTime;
  if (dur <= 0) return;
  const center = m.startTime + dur / 2;
  const half = dur / 2;
  // Triangular dip peaking at the window centre.
  const intensity = clamp01(1 - Math.abs(t - center) / half);
  if (intensity <= 0) return;
  const isFlash = s.style === "flash";
  ctx.save();
  ctx.globalAlpha = intensity * (isFlash ? 0.85 : 0.95);
  ctx.fillStyle = isFlash ? "#ffffff" : "#000000";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.restore();
}

// ── IN-CAMERA pass ───────────────────────────────────────────────────────────

/**
 * Draw callout + blur-redaction overlays active at `t`. Origin MUST be the base
 * placement CENTRE (caller sets it: the compositor is already centred inside the
 * camera transform; Remotion translates to `base.drawW/2, base.drawH/2`). Coords
 * are normalized `focusRegion` mapped onto `drawW × drawH`.
 */
export function drawInCameraOverlays(
  ctx: CanvasRenderingContext2D,
  moments: DetectedMoment[],
  t: number,
  drawW: number,
  drawH: number
): void {
  const { inCamera } = activeOverlays(moments, t);
  if (!inCamera.length) return;
  // Blur first (redact), callouts on top (annotate).
  for (const m of inCamera) {
    if (m.effectType === "blur-redaction" && m.blurRedaction)
      drawBlurRedaction(ctx, m.blurRedaction, m.focusRegion, drawW, drawH);
  }
  for (const m of inCamera) {
    if (m.effectType === "callout" && m.callout)
      drawCallout(ctx, m.callout, m, t, drawW, drawH);
  }
}

/** focusRegion (0..1) → pixel rect centred at origin (origin = placement centre). */
function regionRect(
  region: FocusRegion,
  drawW: number,
  drawH: number
): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
  const w = region.width * drawW;
  const h = region.height * drawH;
  const x = (region.x - 0.5) * drawW;
  const y = (region.y - 0.5) * drawH;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function drawBlurRedaction(
  ctx: CanvasRenderingContext2D,
  s: import("@/lib/firebase/schema").BlurRedactionSettings,
  region: FocusRegion,
  drawW: number,
  drawH: number
): void {
  const { x, y, w, h } = regionRect(region, drawW, drawH);
  if (w <= 0 || h <= 0) return;
  // A frosted redaction panel: opacity scales with strength. Fully hides the
  // region (identical on every render path — no ctx.filter dependency).
  const strength = clamp01(s.blurStrength);
  const alpha = 0.6 + 0.4 * strength;
  ctx.save();
  ctx.fillStyle = `rgba(12,12,18,${alpha.toFixed(3)})`;
  const r = Math.min(w, h) * 0.08;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  // Subtle "frosted" hatch so it reads as blur/redaction, not a solid crop.
  ctx.globalAlpha = 0.12 + 0.1 * strength;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.02);
  const step = Math.max(6, Math.min(w, h) * 0.14);
  ctx.beginPath();
  for (let lx = x - h; lx < x + w; lx += step) {
    ctx.moveTo(lx, y + h);
    ctx.lineTo(lx + h, y);
  }
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

function drawCallout(
  ctx: CanvasRenderingContext2D,
  s: CalloutSettings,
  m: DetectedMoment,
  t: number,
  drawW: number,
  drawH: number
): void {
  const alpha = envelopeAlpha(t, m.startTime, m.endTime, 0.2);
  if (alpha <= 0) return;
  const { x, y, w, h, cx, cy } = regionRect(m.focusRegion, drawW, drawH);
  const accent = "rgba(139,92,246,0.95)";
  const lw = Math.max(2, drawH * 0.006);
  const fontSize = Math.max(12, Math.round(drawH * 0.03));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = accent;
  ctx.lineWidth = lw;

  if (s.style === "spotlight") {
    // Dim everything, punch a soft hole over the region.
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
    ctx.globalCompositeOperation = "destination-out";
    const rad = Math.max(w, h) * 0.7;
    const grd = ctx.createRadialGradient(cx, cy, rad * 0.4, cx, cy, rad);
    grd.addColorStop(0, "rgba(0,0,0,1)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (s.style === "circle") {
    ctx.beginPath();
    ctx.ellipse(cx, cy, (w / 2) * 1.1, (h / 2) * 1.1, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.style === "underline") {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();
  } else if (s.style === "arrow") {
    // Arrow from up-left into the region's top-left corner.
    const ax = x - Math.max(w, drawW * 0.08);
    const ay = y - Math.max(h * 0.5, drawH * 0.06);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(x, y);
    ctx.stroke();
    const ang = Math.atan2(y - ay, x - ax);
    const head = lw * 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - head * Math.cos(ang - 0.5), y - head * Math.sin(ang - 0.5));
    ctx.lineTo(x - head * Math.cos(ang + 0.5), y - head * Math.sin(ang + 0.5));
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.fill();
  } else {
    // "box" (default)
    roundRectPath(ctx, x, y, w, h, Math.min(w, h) * 0.08);
    ctx.stroke();
  }

  // Optional label pill above the region.
  if (s.text && s.text.trim()) {
    ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const tw = ctx.measureText(s.text).width;
    const padX = fontSize * 0.6;
    const padY = fontSize * 0.4;
    const boxW = tw + padX * 2;
    const boxH = fontSize + padY * 2;
    const lx = cx - boxW / 2;
    const ly = y - boxH - fontSize * 0.5;
    ctx.fillStyle = accent;
    roundRectPath(ctx, lx, ly, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(s.text, cx, ly + boxH / 2);
  }
  ctx.restore();
}
