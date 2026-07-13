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
import { resolveTextStyle, type ResolvedTextStyle, type TextScript } from "./text-shaping";
import {
  evaluateAnimation,
  revealText,
  type AnimationFrame,
} from "@/lib/presets/animation";
import {
  aspectOf,
  resolveMaxWidthPx,
  safeBox,
} from "@/lib/presets/layout";
import {
  fontFamilyStack,
  rgba,
  resolveTextStyleValues,
  type TextStyleValues,
} from "./text-style";

/**
 * Set ctx.font (family = user family choice layered over the script-appropriate
 * stack) + ctx.direction (text-derived) via the SHARED resolvers. Every text draw
 * (caption / hook / text-overlay / callout / CTA) calls this, so font + direction
 * logic lives in ONE place, used identically by preview and every export path.
 * The canvas text engine shapes + bidi-reorders under ctx.direction — we NEVER
 * reverse strings manually.
 */
function applyEditFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  v: TextStyleValues,
  fontSizePx: number
): ResolvedTextStyle {
  const shaped = resolveTextStyle(text);
  ctx.font = `${v.fontWeight} ${fontSizePx}px ${fontFamilyStack(v.fontFamily, shaped.fontFamily)}`;
  ctx.direction = shaped.direction;
  return shaped;
}

/** Only cased scripts support an uppercase transform (Arabic/CJK/Thai/etc. don't). */
function isCasedScript(s: TextScript): boolean {
  return s === "latin" || s === "cyrillic" || s === "greek";
}



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

/**
 * Apply a moment's declarative preset animation to the canvas.
 *
 * Returns the evaluated frame, or `null` when the moment carries no `animation`
 * — in which case the caller keeps its LEGACY animation branch untouched. That
 * is deliberate: every project made before the preset library must render
 * byte-for-byte as it did, so `animation` is purely additive and only takes over
 * when it is actually present.
 *
 * This is the ONE place preset motion is turned into pixels, and it lives in the
 * module that the editor preview, the browser exporter, the Cloud Run worker and
 * Remotion all call. A preset therefore animates identically in all four by
 * construction — there is no second implementation to drift.
 *
 * The caller must `ctx.save()` first and `ctx.restore()` after (they all do).
 */
function applyPresetAnimation(
  ctx: CanvasRenderingContext2D,
  m: DetectedMoment,
  t: number,
  anchorX: number,
  anchorY: number,
  canvasW: number,
  canvasH: number
): AnimationFrame | null {
  const anim = m.animation;
  if (!anim) return null;

  const f = evaluateAnimation(anim, t, m.startTime, m.endTime);

  ctx.globalAlpha *= f.alpha;

  if (f.translateX !== 0 || f.translateY !== 0) {
    ctx.translate(f.translateX * canvasW, f.translateY * canvasH);
  }
  // Scale + rotate about the text's own anchor, so a "pop" grows in place rather
  // than flying in from the canvas origin.
  if (f.scale !== 1 || f.rotate !== 0) {
    ctx.translate(anchorX, anchorY);
    if (f.rotate !== 0) ctx.rotate((f.rotate * Math.PI) / 180);
    if (f.scale !== 1) ctx.scale(f.scale, f.scale);
    ctx.translate(-anchorX, -anchorY);
  }
  if (f.blur > 0) {
    // Already proven across every render path — compose-frame.ts uses ctx.filter
    // for the Canvas-Fit blurred background.
    ctx.filter = `blur(${(f.blur * canvasH).toFixed(2)}px)`;
  }
  return f;
}

/**
 * The text to actually draw, after the animation's progressive reveal.
 * Identity when the moment has no reveal.
 */
function animatedText(text: string, frame: AnimationFrame | null, m: DetectedMoment): string {
  const kind = m.animation?.reveal?.kind;
  if (!frame || !kind || kind === "none") return text;
  return revealText(text, kind, frame.revealFraction);
}

/**
 * Fold the animation's letter-spacing delta into the resolved style. Presets
 * animate tracking (a common title move: letters settling together), and
 * `drawStyledText` reads it from the style rather than the frame.
 */
function withAnimatedTracking(
  v: TextStyleValues,
  frame: AnimationFrame | null
): TextStyleValues {
  if (!frame || frame.letterSpacing === 0) return v;
  return { ...v, letterSpacing: v.letterSpacing + frame.letterSpacing };
}

/**
 * The alpha envelope to use.
 *
 * A moment with its own `animation` owns its opacity completely: the preset's
 * `in.opacity` / `out.opacity` ARE the fade. Multiplying the legacy envelope on
 * top would double-fade it — a designed 0.2s snap-in would be smeared into the
 * default 0.25s ramp and stop reading as a snap.
 */
function baseAlphaFor(m: DetectedMoment, t: number, legacyRamp?: number): number {
  if (m.animation) return m.enabled === false ? 0 : 1;
  return envelopeAlpha(t, m.startTime, m.endTime, legacyRamp);
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

/**
 * Script-aware greedy wrap to `maxWidth` px (ctx.font must already be set).
 * Wraps on whitespace like normal; a single token wider than the line (a CJK/Thai
 * run with no spaces, or a long URL) is broken BY CHARACTER so it never overflows.
 * Iterates by code point (Array.from) so surrogate pairs — CJK astral + emoji —
 * are never split mid-character.
 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const raw = (text ?? "").trim();
  if (!raw) return [];
  const fits = (str: string) => ctx.measureText(str).width <= maxWidth;
  const lines: string[] = [];
  let line = "";
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    const candidate = line ? `${line} ${token}` : token;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    if (fits(token)) {
      line = token;
      continue;
    }
    // Token alone is wider than the line — break it by character.
    let chunk = "";
    for (const ch of Array.from(token)) {
      if (!chunk || fits(chunk + ch)) {
        chunk += ch;
      } else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [raw];
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
    // Non-destructive disable — `enabled === false` hides the overlay in preview
    // AND export (this is the single gate both paths share). Absent = enabled.
    if (m.enabled === false) continue;
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

/** True if any ENABLED overlay moment exists (cheap gate to skip the passes entirely). */
export function hasOverlayMoments(moments: DetectedMoment[]): boolean {
  return moments.some(
    (m) =>
      m.enabled !== false &&
      (m.effectType === "captions" ||
      m.effectType === "hook-text" ||
      m.effectType === "text-overlay" ||
      m.effectType === "branding-cta" ||
      m.effectType === "transition" ||
      m.effectType === "callout" ||
      m.effectType === "blur-redaction")
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

// ── Unified styled-text renderer ─────────────────────────────────────────────
// ONE function draws a multi-line text block for EVERY text edit, consuming the
// shared resolved `TextStyleValues`. Every axis (family, size, weight, colour,
// opacity, alignment, background none/solid/box/pill, stroke, shadow, letter
// spacing, line height, padding, radius, uppercase) is honoured identically in
// preview + export because this is the single code path both call.

interface StyledTextAnchor {
  /** Alignment reference point on x (glyph placement follows `v.align`). */
  x: number;
  /** Anchor y; meaning set by `vAlign`. */
  y: number;
  /** How `y` positions the block: block centre / top edge / bottom edge. */
  vAlign: "center" | "top" | "bottom";
  maxWidth: number;
  minFontPx: number;
}

/**
 * Draw `text` at `anchor` using the fully-resolved style `v`. Caller sets
 * `ctx.globalAlpha` to the appearance envelope and any animation transform; this
 * bakes each element's own opacity into its colour, so text/background/shadow
 * opacities compose with the envelope without extra save/restores.
 */
function drawStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  v: TextStyleValues,
  canvasH: number,
  anchor: StyledTextAnchor
): void {
  const fontSizePx = Math.max(anchor.minFontPx, Math.round(canvasH * v.fontScale));
  const shaped = applyEditFont(ctx, text, v, fontSizePx);
  ctx.textBaseline = "middle";
  ctx.textAlign = v.align;
  // Letter spacing via the standard Canvas property (browser + @napi-rs/canvas +
  // Remotion Chromium all honour it; default 0 = no-op, so parity is unaffected
  // unless the user opts in). Guarded so an older engine can't throw.
  const lsPx = v.letterSpacing * fontSizePx;
  setLetterSpacing(ctx, lsPx);
  const display = v.uppercase && isCasedScript(shaped.script) ? text.toUpperCase() : text;
  const lines = wrapText(ctx, display, anchor.maxWidth);
  if (!lines.length) {
    setLetterSpacing(ctx, 0);
    return;
  }
  const lineH = fontSizePx * v.lineHeight;
  const blockH = lines.length * lineH;
  const padX = v.paddingX * fontSizePx;
  const padY = v.paddingY * fontSizePx;

  // First-line baseline (textBaseline = middle) from the anchor + vAlign.
  const firstBaseline =
    anchor.vAlign === "top"
      ? anchor.y + lineH / 2
      : anchor.vAlign === "bottom"
        ? anchor.y - blockH + lineH / 2
        : anchor.y - blockH / 2 + lineH / 2;

  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(...widths, 1);
  const lineLeft = (w: number) =>
    v.align === "center" ? anchor.x - w / 2 : v.align === "right" ? anchor.x - w : anchor.x;
  const blockTop = firstBaseline - lineH / 2;

  // Block-level plate (solid / box) behind the whole block.
  if (v.background === "solid" || v.background === "box") {
    ctx.fillStyle = rgba(v.backgroundColor, v.backgroundOpacity);
    const r = v.background === "box" ? v.borderRadius * fontSizePx : 0;
    roundRectPath(ctx, lineLeft(blockW) - padX, blockTop - padY, blockW + padX * 2, blockH + padY * 2, r);
    ctx.fill();
  }

  const hasShadow = v.shadow && v.shadowOpacity > 0;
  const strokePx = v.strokeWidth * fontSizePx;
  let by = firstBaseline;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const w = widths[i];
    // Per-line pill plate.
    if (v.background === "pill") {
      ctx.fillStyle = rgba(v.backgroundColor, v.backgroundOpacity);
      const boxH = lineH;
      roundRectPath(ctx, lineLeft(w) - padX, by - boxH / 2, w + padX * 2, boxH, boxH / 2);
      ctx.fill();
    }
    if (hasShadow) {
      ctx.shadowColor = rgba(v.shadowColor, v.shadowOpacity);
      ctx.shadowBlur = v.shadowBlur * fontSizePx;
      ctx.shadowOffsetX = v.shadowOffsetX * fontSizePx;
      ctx.shadowOffsetY = v.shadowOffsetY * fontSizePx;
    }
    if (strokePx > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = rgba(v.strokeColor, 1);
      ctx.strokeText(line, anchor.x, by);
      // Clear so the fill sits cleanly on the outline without a doubled shadow.
      clearShadow(ctx);
    }
    ctx.fillStyle = rgba(v.color, v.textOpacity);
    ctx.fillText(line, anchor.x, by);
    clearShadow(ctx);
    by += lineH;
  }
  setLetterSpacing(ctx, 0);
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** Set the canvas letterSpacing property if the engine supports it. */
function setLetterSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  try {
    (ctx as unknown as { letterSpacing?: string }).letterSpacing = `${px}px`;
  } catch {
    /* engine without letterSpacing support — spacing stays default (0). */
  }
}

/** Resolve the anchor (x, y) for a vertically-anchored text block. */
function positionedAnchor(
  v: TextStyleValues,
  canvasW: number,
  canvasH: number,
  table: { topF: number; centerF: number; bottomF: number; marginXF: number }
): { x: number; y: number; vAlign: "center" | "top" | "bottom" } {
  if (v.position === "custom") {
    return { x: clamp01(v.customX) * canvasW, y: clamp01(v.customY) * canvasH, vAlign: "center" };
  }
  const mx = table.marginXF * canvasW;
  const x = v.align === "left" ? mx : v.align === "right" ? canvasW - mx : canvasW / 2;
  if (v.position === "top") return { x, y: table.topF * canvasH, vAlign: "top" };
  if (v.position === "center") return { x, y: table.centerF * canvasH, vAlign: "center" };
  return { x, y: table.bottomF * canvasH, vAlign: "bottom" };
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  s: CaptionSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = baseAlphaFor(m, t);
  if (alpha <= 0 || !s.text.trim()) return;
  const v0 = resolveTextStyleValues(m);
  const a = positionedAnchor(v0, canvasW, canvasH, {
    topF: 0.14,
    centerF: 0.5,
    bottomF: v0.position === "custom" ? 0 : 0.82,
    marginXF: 0.09,
  });
  ctx.save();
  ctx.globalAlpha = alpha;
  const f = applyPresetAnimation(ctx, m, t, a.x, a.y, canvasW, canvasH);
  const v = withAnimatedTracking(v0, f);
  drawStyledText(ctx, animatedText(s.text, f, m), v, canvasH, {
    x: a.x,
    y: a.y,
    vAlign: a.vAlign,
    // Wrap inside the platform's SAFE area, not the raw canvas: on a 9:16 feed
    // the right 12% is the action rail, and a caption running under it is
    // invisible to a real viewer no matter how good it looks in our preview.
    maxWidth: safeTextWidth(canvasW, canvasH, 0.98, 0.82),
    minFontPx: 14,
  });
  ctx.restore();
}

/**
 * Max text width in px, respecting the aspect's safe area.
 *
 * `safeFraction` is the share of the safe box to use; `legacyFraction` is the
 * old share-of-canvas this call used before safe areas existed. On 16:9 the two
 * land within a hair of each other (the safe inset is 5%), so existing
 * horizontal projects wrap exactly as before; on 9:16 the safe box is what
 * actually keeps text off the platform chrome.
 */
function safeTextWidth(
  canvasW: number,
  canvasH: number,
  safeFraction: number,
  legacyFraction: number
): number {
  const aspect = aspectOf(canvasW, canvasH);
  if (aspect === "16:9") return canvasW * legacyFraction;
  return Math.max(24, safeBox(canvasW, canvasH, aspect).width * safeFraction);
}

function drawHookText(
  ctx: CanvasRenderingContext2D,
  s: HookTextSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = baseAlphaFor(m, t);
  if (alpha <= 0 || !s.text.trim()) return;
  const v0 = resolveTextStyleValues(m);
  const p = easeOut(inProgress(t, m.startTime, m.endTime));
  const a = positionedAnchor(v0, canvasW, canvasH, {
    topF: 0.14,
    centerF: 0.5,
    bottomF: 0.82,
    marginXF: 0.07,
  });
  ctx.save();
  ctx.globalAlpha = alpha;

  // A preset animation REPLACES the legacy enum rather than compounding with it
  // — running both would fight (a preset "slide from the left" plus the legacy
  // "pop" would arrive scaled AND offset, which is neither design).
  const f = applyPresetAnimation(ctx, m, t, a.x, a.y, canvasW, canvasH);
  if (!f) {
    // Legacy path — byte-identical to before the preset library existed.
    if (s.animation === "slide") ctx.translate((1 - p) * canvasW * 0.08, 0);
    else if (s.animation === "pop") {
      const scale = 0.85 + 0.15 * p;
      ctx.translate(a.x, a.y);
      ctx.scale(scale, scale);
      ctx.translate(-a.x, -a.y);
    }
  }

  const v = withAnimatedTracking(v0, f);
  drawStyledText(ctx, animatedText(s.text, f, m), v, canvasH, {
    x: a.x,
    y: a.y,
    vAlign: a.vAlign,
    maxWidth: safeTextWidth(canvasW, canvasH, 1, 0.86),
    minFontPx: 18,
  });
  ctx.restore();
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  s: TextOverlaySettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const baseAlpha = baseAlphaFor(m, t, s.animation === "fade" ? 0.4 : 0.2);
  if (baseAlpha <= 0 || !s.text.trim()) return;
  const v0 = resolveTextStyleValues(m);
  const p = easeOut(inProgress(t, m.startTime, m.endTime));
  const a = positionedAnchor(v0, canvasW, canvasH, {
    topF: 0.08,
    centerF: 0.5,
    bottomF: 0.92,
    marginXF: 0.06,
  });
  ctx.save();
  ctx.globalAlpha = baseAlpha;
  const f = applyPresetAnimation(ctx, m, t, a.x, a.y, canvasW, canvasH);
  const v = withAnimatedTracking(v0, f);
  if (f) {
    // Preset animation owns the transform — skip the legacy branch entirely.
  } else if (s.animation === "slide") {
    ctx.translate((1 - p) * canvasW * 0.05 * (v.align === "right" ? -1 : 1), 0);
  } else if (s.animation === "pop") {
    const scale = 0.9 + 0.1 * p;
    ctx.translate(a.x, a.y);
    ctx.scale(scale, scale);
    ctx.translate(-a.x, -a.y);
  }
  drawStyledText(ctx, animatedText(s.text, f, m), v, canvasH, {
    x: a.x,
    y: a.y,
    vAlign: a.vAlign,
    maxWidth: safeTextWidth(canvasW, canvasH, 0.86, 0.62),
    minFontPx: 12,
  });
  ctx.restore();
}

function drawBrandingCta(
  ctx: CanvasRenderingContext2D,
  s: BrandingCtaSettings,
  m: DetectedMoment,
  t: number,
  { canvasW, canvasH }: OverlayLayout
): void {
  const alpha = baseAlphaFor(m, t, 0.3);
  if (alpha <= 0 || !s.ctaText.trim()) return;
  const v = resolveTextStyleValues(m);
  const fontSize = Math.max(14, Math.round(canvasH * v.fontScale));
  ctx.save();
  ctx.globalAlpha = alpha;
  const shaped = applyEditFont(ctx, s.ctaText, v, fontSize);
  ctx.textBaseline = "middle";
  const lsPx = v.letterSpacing * fontSize;
  setLetterSpacing(ctx, lsPx);
  const label = v.uppercase && isCasedScript(shaped.script) ? s.ctaText.toUpperCase() : s.ctaText;
  const textW = ctx.measureText(label).width;
  const padX = v.paddingX * fontSize;
  const padY = v.paddingY * fontSize;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const margin = canvasH * 0.05;
  let x: number;
  let y = canvasH - boxH - margin;
  if (s.position === "custom") {
    x = clamp01(v.customX) * canvasW - boxW / 2;
    y = clamp01(v.customY) * canvasH - boxH / 2;
  } else if (s.position === "bottom-left") x = margin;
  else if (s.position === "bottom-center") x = canvasW / 2 - boxW / 2;
  else x = canvasW - boxW - margin; // bottom-right

  // A preset animation owns the CTA's motion; otherwise keep the legacy rise.
  // The anchor is the pill's own centre, so a "pop" grows the button in place.
  const f = applyPresetAnimation(ctx, m, t, x + boxW / 2, y + boxH / 2, canvasW, canvasH);
  if (!f) {
    const p = easeOut(inProgress(t, m.startTime, m.endTime, 0.4));
    ctx.translate(0, (1 - p) * boxH * 0.4);
  }

  if (v.background !== "none") {
    ctx.fillStyle = rgba(v.backgroundColor, v.backgroundOpacity);
    const r = v.background === "pill" ? boxH / 2 : v.background === "box" ? v.borderRadius * fontSize : 0;
    roundRectPath(ctx, x, y, boxW, boxH, r);
    ctx.fill();
  }
  if (v.shadow && v.shadowOpacity > 0) {
    ctx.shadowColor = rgba(v.shadowColor, v.shadowOpacity);
    ctx.shadowBlur = v.shadowBlur * fontSize;
    ctx.shadowOffsetX = v.shadowOffsetX * fontSize;
    ctx.shadowOffsetY = v.shadowOffsetY * fontSize;
  }
  ctx.fillStyle = rgba(v.color, v.textOpacity);
  ctx.textAlign = "center";
  ctx.fillText(label, x + boxW / 2, y + boxH / 2);
  clearShadow(ctx);
  setLetterSpacing(ctx, 0);
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
  const half = dur / 2;
  const center = m.startTime + half;
  /** Triangular dip: 0 at the edges of the window, 1 at its centre. */
  const intensity = clamp01(1 - Math.abs(t - center) / half);
  if (intensity <= 0) return;
  /** Linear 0→1 across the whole window — what the directional styles sweep on. */
  const sweep = clamp01((t - m.startTime) / dur);

  ctx.save();
  switch (s.style) {
    case "flash":
      ctx.globalAlpha = intensity * 0.85;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvasW, canvasH);
      break;

    case "smooth_cut":
      // A gentler, shallower dip — punctuation rather than a scene break.
      ctx.globalAlpha = easeOut(intensity) * 0.55;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvasW, canvasH);
      break;

    case "swipe": {
      // A hard black bar wiping left→right across the frame. Directional, so it
      // reads as a cut rather than a fade — and it is genuinely renderable over
      // a SINGLE source, unlike a two-scene clip-path wipe.
      const edge = sweep * canvasW * 2;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#000000";
      // Leading half covers, trailing half uncovers.
      if (sweep <= 0.5) ctx.fillRect(0, 0, Math.min(canvasW, edge), canvasH);
      else ctx.fillRect(Math.min(canvasW, edge - canvasW), 0, canvasW, canvasH);
      break;
    }

    case "zoom": {
      // An IRIS: a black frame with a circular hole that closes to the centre and
      // reopens. Drawn as an even-odd fill so the hole is genuinely transparent —
      // the video shows through it, which is what makes it read as an iris rather
      // than a vignette.
      const maxR = Math.hypot(canvasW, canvasH) / 2;
      const r = maxR * (1 - intensity);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.rect(0, 0, canvasW, canvasH);
      ctx.arc(canvasW / 2, canvasH / 2, Math.max(0, r), 0, Math.PI * 2);
      ctx.fill("evenodd");
      break;
    }

    case "fade":
    default:
      ctx.globalAlpha = intensity * 0.95;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvasW, canvasH);
      break;
  }
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

  // Optional label pill above the region — styled by the SHARED text model, so
  // the callout label honours the same font / colour / weight / uppercase /
  // stroke / shadow / letter-spacing controls as every other text edit (and an
  // Arabic/Hebrew label gets the right font + RTL direction).
  if (s.text && s.text.trim()) {
    const v = resolveTextStyleValues(m);
    const labelFont = Math.max(12, Math.round(drawH * v.fontScale));
    const shaped = applyEditFont(ctx, s.text, v, labelFont);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const lsPx = v.letterSpacing * labelFont;
    setLetterSpacing(ctx, lsPx);
    const label = v.uppercase && isCasedScript(shaped.script) ? s.text.toUpperCase() : s.text;
    const tw = ctx.measureText(label).width;
    const padX = v.paddingX * labelFont;
    const padY = v.paddingY * labelFont;
    const boxW = tw + padX * 2;
    const boxH = labelFont + padY * 2;
    const lx = cx - boxW / 2;
    const ly = y - boxH - labelFont * 0.5;
    if (v.background !== "none") {
      ctx.fillStyle = rgba(v.backgroundColor, v.backgroundOpacity);
      const r = v.background === "box" ? v.borderRadius * labelFont : boxH / 2;
      roundRectPath(ctx, lx, ly, boxW, boxH, r);
      ctx.fill();
    }
    if (v.shadow && v.shadowOpacity > 0) {
      ctx.shadowColor = rgba(v.shadowColor, v.shadowOpacity);
      ctx.shadowBlur = v.shadowBlur * labelFont;
      ctx.shadowOffsetX = v.shadowOffsetX * labelFont;
      ctx.shadowOffsetY = v.shadowOffsetY * labelFont;
    }
    const strokePx = v.strokeWidth * labelFont;
    if (strokePx > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = strokePx;
      ctx.strokeStyle = rgba(v.strokeColor, 1);
      ctx.strokeText(label, cx, ly + boxH / 2);
      clearShadow(ctx);
    }
    ctx.fillStyle = rgba(v.color, v.textOpacity);
    ctx.fillText(label, cx, ly + boxH / 2);
    clearShadow(ctx);
    setLetterSpacing(ctx, 0);
  }
  ctx.restore();
}
