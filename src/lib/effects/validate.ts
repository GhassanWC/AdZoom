/**
 * Test-render an effect program BEFORE it reaches a timeline.
 *
 * Runs the real interpreter (program.ts) frame by frame against a recording
 * context — no canvas library needed, so it runs in the API route — and
 * checks what a person would check by watching it: it compiles, stays inside
 * its budgets, draws something visible inside the frame, never produces
 * non-finite geometry, and (when anchored) actually starts at the anchor.
 * The same recording renders the SVG preview stored in the effect library.
 */

import {
  compileProgram,
  drawEffectProgram,
  FX_LIMITS,
  type CompiledProgram,
  type EffectProgram,
  type FxContext,
  type FxInstanceInputs,
  type FxIssue,
  type FxParamValues,
} from "./program";

interface Prim {
  shape: "circle" | "ring" | "arc" | "glow" | "line" | "rect" | "text";
  x: number;
  y: number;
  r?: number;
  x2?: number;
  y2?: number;
  a0?: number;
  a1?: number;
  w?: number;
  h?: number;
  rot?: number;
  width?: number;
  color: string;
  alpha: number;
  blend: string;
  text?: string;
  size?: number;
}

/** A CanvasRenderingContext2D stand-in that records what would be drawn. */
class RecordingContext {
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = "source-over";
  fillStyle: unknown = "#fff";
  strokeStyle: unknown = "#fff";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  shadowBlur = 0;
  shadowColor = "transparent";
  font = "";
  textAlign: CanvasTextAlign = "left";
  textBaseline: CanvasTextBaseline = "alphabetic";
  prims: Prim[] = [];
  nonFinite = 0;
  private stack: unknown[] = [];
  private tx = 0;
  private ty = 0;
  private rot = 0;
  private path: { kind: "arc"; x: number; y: number; r: number; a0: number; a1: number } | { kind: "line"; x: number; y: number; x2: number; y2: number } | null = null;
  private pendingMove: { x: number; y: number } | null = null;

  save() {
    this.stack.push([this.globalAlpha, this.globalCompositeOperation, this.fillStyle, this.strokeStyle, this.lineWidth, this.shadowBlur, this.tx, this.ty, this.rot]);
  }
  restore() {
    const s = this.stack.pop() as unknown[] | undefined;
    if (!s) return;
    [this.globalAlpha, this.globalCompositeOperation, this.fillStyle, this.strokeStyle, this.lineWidth, this.shadowBlur, this.tx, this.ty, this.rot] = s as [number, GlobalCompositeOperation, unknown, unknown, number, number, number, number, number];
  }
  translate(x: number, y: number) {
    this.tx += x;
    this.ty += y;
  }
  rotate(a: number) {
    this.rot += a;
  }
  beginPath() {
    this.path = null;
    this.pendingMove = null;
  }
  closePath() {}
  arc(x: number, y: number, r: number, a0: number, a1: number) {
    this.check(x, y, r, a0, a1);
    this.path = { kind: "arc", x, y, r, a0, a1 };
  }
  moveTo(x: number, y: number) {
    this.check(x, y);
    this.pendingMove = { x, y };
  }
  lineTo(x: number, y: number) {
    this.check(x, y);
    if (this.pendingMove) this.path = { kind: "line", x: this.pendingMove.x, y: this.pendingMove.y, x2: x, y2: y };
  }
  createRadialGradient(_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, _r1: number) {
    const g = { glow: true, color: "#fff", addColorStop: (o: number, c: string) => { if (o === 0) g.color = c; } };
    return g as unknown as CanvasGradient;
  }
  private colorString(v: unknown): string {
    if (typeof v === "string") return v;
    const g = v as { glow?: boolean; color?: string };
    return g?.color ?? "#fff";
  }
  fill() {
    const p = this.path;
    if (!p || p.kind !== "arc") return;
    const glow = typeof this.fillStyle === "object" && (this.fillStyle as { glow?: boolean })?.glow;
    this.prims.push({ shape: glow ? "glow" : "circle", x: p.x, y: p.y, r: p.r, color: this.colorString(this.fillStyle), alpha: this.globalAlpha, blend: this.globalCompositeOperation });
  }
  stroke() {
    const p = this.path;
    if (!p) return;
    if (p.kind === "arc") {
      const full = Math.abs(p.a1 - p.a0) >= Math.PI * 2 - 1e-6;
      this.prims.push({ shape: full ? "ring" : "arc", x: p.x, y: p.y, r: p.r, a0: p.a0, a1: p.a1, width: this.lineWidth, color: this.colorString(this.strokeStyle), alpha: this.globalAlpha, blend: this.globalCompositeOperation });
    } else {
      this.prims.push({ shape: "line", x: p.x, y: p.y, x2: p.x2, y2: p.y2, width: this.lineWidth, color: this.colorString(this.strokeStyle), alpha: this.globalAlpha, blend: this.globalCompositeOperation });
    }
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.check(x, y, w, h);
    this.prims.push({ shape: "rect", x: this.tx, y: this.ty, w, h, rot: this.rot, color: this.colorString(this.fillStyle), alpha: this.globalAlpha, blend: this.globalCompositeOperation });
  }
  fillText(text: string) {
    const size = Number(/(\d+)px/.exec(this.font)?.[1] ?? 12);
    this.prims.push({ shape: "text", x: this.tx, y: this.ty, rot: this.rot, text, size, color: this.colorString(this.fillStyle), alpha: this.globalAlpha, blend: this.globalCompositeOperation });
  }
  private check(...v: number[]) {
    if (v.some((n) => !Number.isFinite(n))) this.nonFinite++;
  }
}

export interface TestRenderStats {
  frames: number;
  maxPrimitives: number;
  visibleFrames: number;
  /** Fraction of drawn primitives whose centre was inside the frame. */
  inFrameRatio: number;
  /** Distance (fraction of frame height) from the anchor to the nearest primitive in the first visible frame. */
  startDistanceFromAnchor: number | null;
  msTotal: number;
}

export interface TestRenderResult {
  ok: boolean;
  issues: FxIssue[];
  warnings: string[];
  stats: TestRenderStats | null;
  /** data:image/svg+xml preview strip (3 moments of the effect). */
  preview: string | null;
}

const PREVIEW_W = 192;
const PREVIEW_H = 108;

/**
 * Compile + render `frames` samples across the program's duration. `inputs`
 * defaults to an anchor at the frame centre so a program can be tested before
 * its footage position is known.
 */
export function testRenderProgram(
  program: unknown,
  opts: { params?: FxParamValues; inputs?: FxInstanceInputs; frames?: number; budgetMs?: number } = {}
): TestRenderResult {
  const c = compileProgram(program);
  if (!c.ok) return { ok: false, issues: c.issues, warnings: [], stats: null, preview: null };
  const compiled = c.compiled;
  const prog = compiled.program as EffectProgram;
  const inputs: FxInstanceInputs = opts.inputs ?? { anchor: { x: 0.5, y: 0.5 } };
  const W = 1920;
  const H = 1080;
  const frames = opts.frames ?? 36;
  const budgetMs = opts.budgetMs ?? 4000;
  const issues: FxIssue[] = [];
  const warnings: string[] = [];
  let maxPrims = 0;
  let visible = 0;
  let inFrame = 0;
  let total = 0;
  let nonFinite = 0;
  let startDist: number | null = null;
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    const t = (prog.duration * f) / Math.max(1, frames - 1);
    const rec = new RecordingContext();
    try {
      const n = drawEffectProgram(rec as unknown as FxContext, compiled, { params: opts.params, inputs }, Math.min(t, prog.duration - 1e-6), { ox: 0, oy: 0, W, H });
      maxPrims = Math.max(maxPrims, n);
    } catch (err) {
      issues.push({ path: "render", message: `Frame at ${t.toFixed(2)}s threw: ${err instanceof Error ? err.message : String(err)}` });
      break;
    }
    nonFinite += rec.nonFinite;
    const shown = rec.prims.filter((p) => p.alpha > 0.02);
    if (shown.length) {
      visible++;
      if (startDist == null && inputs.anchor) {
        const a = inputs.anchor;
        startDist = Math.min(...shown.map((p) => Math.hypot(p.x / H - (a.x * W) / H, p.y / H - a.y)));
      }
    }
    for (const p of rec.prims) {
      total++;
      if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) inFrame++;
    }
    if (Date.now() - t0 > budgetMs) {
      issues.push({ path: "render", message: `Too slow: ${frames} test frames took over ${budgetMs}ms. Use fewer copies (count) or layers.` });
      break;
    }
  }
  const msTotal = Date.now() - t0;
  if (!issues.length) {
    if (visible === 0) issues.push({ path: "layers", message: "Nothing visible was drawn in any test frame (check alpha, radius and positions)." });
    if (total > 0 && inFrame / total < 0.1) issues.push({ path: "layers", message: "Almost everything is drawn outside the video frame — positions are fractions 0..1 of the frame." });
    if (nonFinite > frames * 2) issues.push({ path: "layers", message: "Some expressions produce non-finite numbers (division by zero, log of 0, …)." });
    if (maxPrims >= FX_LIMITS.primitivesPerFrame) warnings.push(`Hit the ${FX_LIMITS.primitivesPerFrame}-shape per-frame cap — some copies were skipped.`);
    if (prog.inputs?.includes("anchor") && startDist != null && startDist > 0.15) {
      warnings.push(`The first visible frame is ${(startDist * 100).toFixed(0)}% of the frame height away from the anchor — an anchored effect should start at the anchor (ax, ay).`);
    }
  }
  const ok = issues.length === 0;
  return {
    ok,
    issues,
    warnings,
    stats: { frames, maxPrimitives: maxPrims, visibleFrames: visible, inFrameRatio: total ? Math.round((inFrame / total) * 100) / 100 : 0, startDistanceFromAnchor: startDist == null ? null : Math.round(startDist * 1000) / 1000, msTotal },
    preview: ok ? previewSvg(compiled, opts.params, inputs) : null,
  };
}

// ── preview ─────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Three moments of the effect over a dark plate, as one small SVG strip. */
export function previewSvg(compiled: CompiledProgram, params: FxParamValues | undefined, inputs: FxInstanceInputs): string {
  const d = compiled.program.duration;
  const moments = [0.12, 0.4, 0.75];
  let defs = "";
  let body = "";
  let gid = 0;
  moments.forEach((m, fi) => {
    const rec = new RecordingContext();
    drawEffectProgram(rec as unknown as FxContext, compiled, { params, inputs }, d * m, { ox: 0, oy: 0, W: PREVIEW_W, H: PREVIEW_H });
    const ox = fi * (PREVIEW_W + 4);
    body += `<g transform="translate(${ox},0)"><rect width="${PREVIEW_W}" height="${PREVIEW_H}" fill="#0d1a12"/><clipPath id="c${fi}"><rect width="${PREVIEW_W}" height="${PREVIEW_H}"/></clipPath><g clip-path="url(#c${fi})">`;
    for (const p of rec.prims.slice(0, 500)) {
      const style = `opacity:${r1(p.alpha * 100) / 100}${p.blend === "lighter" ? ";mix-blend-mode:plus-lighter" : p.blend === "screen" ? ";mix-blend-mode:screen" : ""}`;
      const col = esc(p.color);
      if (p.shape === "circle") body += `<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="${r1(p.r!)}" fill="${col}" style="${style}"/>`;
      else if (p.shape === "glow") {
        const id = `g${gid++}`;
        defs += `<radialGradient id="${id}"><stop offset="0" stop-color="${col}"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`;
        body += `<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="${r1(p.r!)}" fill="url(#${id})" style="${style}"/>`;
      } else if (p.shape === "ring") body += `<circle cx="${r1(p.x)}" cy="${r1(p.y)}" r="${r1(p.r!)}" fill="none" stroke="${col}" stroke-width="${r1(p.width!)}" style="${style}"/>`;
      else if (p.shape === "arc") {
        const sx = p.x + p.r! * Math.cos(p.a0!), sy = p.y + p.r! * Math.sin(p.a0!);
        const ex = p.x + p.r! * Math.cos(p.a1!), ey = p.y + p.r! * Math.sin(p.a1!);
        const large = Math.abs(p.a1! - p.a0!) > Math.PI ? 1 : 0;
        body += `<path d="M${r1(sx)} ${r1(sy)} A${r1(p.r!)} ${r1(p.r!)} 0 ${large} 1 ${r1(ex)} ${r1(ey)}" fill="none" stroke="${col}" stroke-width="${r1(p.width!)}" stroke-linecap="round" style="${style}"/>`;
      } else if (p.shape === "line") body += `<line x1="${r1(p.x)}" y1="${r1(p.y)}" x2="${r1(p.x2!)}" y2="${r1(p.y2!)}" stroke="${col}" stroke-width="${r1(p.width!)}" stroke-linecap="round" style="${style}"/>`;
      else if (p.shape === "rect") body += `<rect x="${r1(-p.w! / 2)}" y="${r1(-p.h! / 2)}" width="${r1(p.w!)}" height="${r1(p.h!)}" fill="${col}" transform="translate(${r1(p.x)},${r1(p.y)}) rotate(${r1(((p.rot ?? 0) * 180) / Math.PI)})" style="${style}"/>`;
      else if (p.shape === "text") body += `<text x="${r1(p.x)}" y="${r1(p.y)}" font-size="${r1(p.size!)}" font-family="Arial" font-weight="800" text-anchor="middle" dominant-baseline="middle" fill="${col}" style="${style}">${esc(p.text ?? "")}</text>`;
    }
    body += `</g></g>`;
  });
  const w = PREVIEW_W * moments.length + 4 * (moments.length - 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PREVIEW_H}" viewBox="0 0 ${w} ${PREVIEW_H}"><defs>${defs}</defs>${body}</svg>`;
  return `data:image/svg+xml;base64,${typeof Buffer !== "undefined" ? Buffer.from(svg).toString("base64") : btoa(unescape(encodeURIComponent(svg)))}`;
}
